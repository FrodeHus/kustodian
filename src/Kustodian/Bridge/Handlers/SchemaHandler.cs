using Kustodian.Graph.Fetch;
using Kustodian.Graph.Schema;
using Kustodian.Sources;
using Kustodian.Sources.Arg;
using Kustodian.Sources.Hunting;

namespace Kustodian.Messaging.Handlers;

/// <summary><c>schema.get {source, refresh?}</c>: the tables, columns, functions and complex types the schema panel and the editor
/// show. <c>graph</c> is the bundled Graph schema. <c>hunting</c> is the active account's advanced hunting schema
/// (<see cref="HuntingSchemaSource"/>, cached for 24 hours unless <c>refresh</c>), or the bundled one, with the reason, when it
/// can't be read or nobody is signed in. <c>arg</c> is the bundled list of Resource Graph tables (<see cref="BuiltInArgSchema"/>);
/// the account's resource types come from <c>arm.resourceTypes</c>.
/// <c>schema.listedByDefault {source: "graph"}</c>: for the active account, the columns Graph lists by default for each table read
/// so far (<see cref="IGraphProbeCache"/>), by table name; a table not read yet isn't in it.
/// <c>schema.licenses {source: "graph", refresh?}</c>: each Graph table and column that needs a license
/// (<see cref="GraphLicenses"/>), with whether the active account's tenant has it (<see cref="ITenantLicenses"/>, read again when
/// <c>refresh</c>): <c>available</c>, <c>missing</c>, or <c>unknown</c> when the licenses couldn't be read or nobody is signed
/// in.</summary>
public sealed class SchemaHandler(GraphSchema schema, HuntingSchemaSource hunting, Func<Task<string?>> activeAccount,
    IGraphProbeCache? probes = null, ITenantLicenses? licenses = null, GraphLicenses? licenseMap = null)
{
    public const string SignInForTenantSchema = "Sign in to see your tenant's schema. The built-in schema is shown.";
    public const string SignInForLicenses = "Sign in to check the tenant's licenses.";

    private readonly GraphLicenses _licenseMap = licenseMap ?? GraphLicenses.Bundled;

    private readonly Lazy<SchemaView> _graph = new(() => SchemaView.From(schema));
    private readonly Lazy<SchemaView> _arg = new(SchemaView.FromArg);

    public void Register(Bridge bridge)
    {
        bridge.Register("schema.get", async (p, ct) =>
        {
            var request = BridgeJson.Params<SchemaParams>(p);
            return request.Source switch
            {
                "graph" => _graph.Value,
                "hunting" => SchemaView.From(await activeAccount() is { } account
                    ? await hunting.GetAsync(account, request.Refresh, ct)
                    : hunting.BuiltIn(SignInForTenantSchema)),
                "arg" => _arg.Value,
                _ => throw new BridgeException(BridgeErrorCodes.BadRequest, $"Unknown source {request.Source}."),
            };
        });
        bridge.Register("schema.listedByDefault", async (p, ct) =>
        {
            RequireGraph(p);
            return await ListedByDefaultAsync(ct);
        });
        bridge.Register("schema.licenses", async (p, ct) =>
        {
            RequireGraph(p);
            return await LicensesAsync(BridgeJson.Params<SchemaParams>(p).Refresh, ct);
        });
    }

    private async Task<SchemaLicenses> LicensesAsync(bool refresh, CancellationToken ct)
    {
        var tenant = await activeAccount() is not { } account
            ? TenantLicenses.Unknown(SignInForLicenses)
            : licenses is null
                ? TenantLicenses.Unknown("The tenant's licenses aren't read.")
                : await licenses.GetAsync(account, refresh, ct);
        LicenseView View(GraphLicenseRequirement r) => new(r.License, r.Plans, r.Source, tenant.StateOf(r));
        var tables = new Dictionary<string, LicenseView>(StringComparer.Ordinal);
        var columns = new Dictionary<string, IReadOnlyDictionary<string, LicenseView>>(StringComparer.Ordinal);
        foreach (var table in schema.Tables)
        {
            if (_licenseMap.ForTable(table.Path) is { } requirement)
                tables[table.Name] = View(requirement);
            var needed = table.Columns
                .Select(c => (c.Name, Requirement: _licenseMap.ForColumn(table.Path, c.Name)))
                .Where(c => c.Requirement is not null)
                .ToDictionary(c => c.Name, c => View(c.Requirement!), StringComparer.Ordinal);
            if (needed.Count > 0)
                columns[table.Name] = needed;
        }

        return new SchemaLicenses(tenant.Known, tenant.Reason, tables, columns);
    }

    private async Task<ListedByDefault> ListedByDefaultAsync(CancellationToken ct)
    {
        var tables = new Dictionary<string, IReadOnlyList<string>>(StringComparer.Ordinal);
        if (probes is null || await activeAccount() is not { } account)
            return new ListedByDefault(tables);
        var byPath = await probes.DefaultsOfAsync(account, ct);
        foreach (var table in schema.Tables)
        {
            if (byPath.TryGetValue(table.Path, out var defaults))
                tables[table.Name] = defaults.Columns;
        }
        return new ListedByDefault(tables);
    }

    private static void RequireGraph(System.Text.Json.JsonElement p)
    {
        var source = BridgeJson.Params<SchemaParams>(p).Source;
        if (source != "graph")
            throw new BridgeException(BridgeErrorCodes.BadRequest, $"Unknown source {source}.");
    }

    private sealed record SchemaParams(string? Source, bool Refresh);

    /// <summary><c>schema.licenses</c>' answer: whether the tenant's licenses are known (else why not), and the licenses tables
    /// (by name) and columns (by table, then column) need.</summary>
    private sealed record SchemaLicenses(bool Known, string? Reason, IReadOnlyDictionary<string, LicenseView> Tables,
        IReadOnlyDictionary<string, IReadOnlyDictionary<string, LicenseView>> Columns);

    /// <summary>A license a table or column needs, the plans that provide it, the Learn page that says so, and whether the tenant
    /// has it.</summary>
    private sealed record LicenseView(string License, IReadOnlyList<string> Plans, string Source, GraphLicenseState State);

    /// <summary><c>schema.listedByDefault</c>'s answer: the default columns by table name.</summary>
    private sealed record ListedByDefault(IReadOnlyDictionary<string, IReadOnlyList<string>> Tables);
}

/// <summary><c>schema.get</c>'s answer. <paramref name="Origin"/> is <c>tenant</c> (read for the account) or <c>builtIn</c>
/// (bundled; Graph's schema always is), and <paramref name="FallbackReason"/> says why a tenant's schema isn't shown.
/// <paramref name="Functions"/> are advanced hunting's; Graph has none.</summary>
public sealed record SchemaView(
    string Source, string Origin, string? FallbackReason, DateTimeOffset GeneratedAt, IReadOnlyList<SchemaTableView> Tables,
    IReadOnlyList<SchemaFunctionView> Functions, IReadOnlyDictionary<string, IReadOnlyList<GraphField>> ComplexTypes)
{
    public static SchemaView From(GraphSchema schema) => new(
        schema.Source,
        SchemaOrigin.BuiltIn,
        null,
        schema.GeneratedAt,
        [.. schema.Tables.Select(t => new SchemaTableView(t.Name, t.Path, GraphAreas.Bundled.Of(t.Path), t.Description,
            t.DocsUrl, t.Permissions,
            [.. t.Columns.Select(c => new SchemaColumnView(c.Name, c.Type, c.Description, c.Filter.Count > 0, c.Listable,
                c.ComplexType, c.Collection))]))],
        [],
        schema.ComplexTypes);

    /// <summary>Advanced hunting's schema: the Graph-only fields (path, area, docs link, permissions, filterable, listable,
    /// complex type) are null.</summary>
    public static SchemaView From(HuntingSchemaView hunting) => new(
        "hunting",
        hunting.Origin,
        hunting.FallbackReason,
        hunting.RetrievedAt,
        [.. hunting.Tables.Select(t => new SchemaTableView(t.Name, null, null, t.Description, null, null,
            [.. t.Columns.Select(c => new SchemaColumnView(c.Name, c.Type, c.Description, null, null, null, false))]))],
        [.. hunting.Functions.Select(f => new SchemaFunctionView(f.Name, f.Description,
            [.. f.Parameters.Select(p => new SchemaParameterView(p.Name, p.Type))]))],
        new Dictionary<string, IReadOnlyList<GraphField>>());

    /// <summary>Resource Graph's bundled tables: the Graph-only fields are null, and there are no functions.</summary>
    public static SchemaView FromArg() => new(
        "arg",
        SchemaOrigin.BuiltIn,
        null,
        BuiltInArgSchema.DocumentedAt,
        [.. BuiltInArgSchema.Tables.Select(t => new SchemaTableView(t.Name, null, null, t.Description, null, null,
            [.. t.Columns.Select(c => new SchemaColumnView(c.Name, c.Type, "", null, null, null, false))]))],
        [],
        new Dictionary<string, IReadOnlyList<GraphField>>());
}

/// <summary>A table as the UI sees it. <paramref name="Path"/> is its Graph collection relative to the version
/// (<c>auditLogs/signIns</c> for <c>auditLogs_signIns</c>), which the raw tab completes. <paramref name="Area"/> is the data area
/// the panel groups it under (<see cref="GraphAreas"/>, from the path; <c>Other</c> when unmapped). They,
/// <paramref name="DocsUrl"/> and <paramref name="Permissions"/> are Graph's, null for other sources.</summary>
public sealed record SchemaTableView(
    string Name, string? Path, string? Area, string Description, string? DocsUrl, IReadOnlyList<string>? Permissions, IReadOnlyList<SchemaColumnView> Columns);

/// <summary>A column as the UI sees it. <paramref name="Filterable"/> is true when Graph's <c>$filter</c> accepts any operator
/// on it; it, <paramref name="Listable"/> and <paramref name="ComplexType"/> are Graph's, null for other sources.</summary>
public sealed record SchemaColumnView(
    string Name, string Type, string Description, bool? Filterable, bool? Listable, string? ComplexType, bool Collection);

/// <summary>A function the source offers (advanced hunting's built-in and saved functions), with its parameters.</summary>
public sealed record SchemaFunctionView(string Name, string Description, IReadOnlyList<SchemaParameterView> Parameters);

public sealed record SchemaParameterView(string Name, string Type);
