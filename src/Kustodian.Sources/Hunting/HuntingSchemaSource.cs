using System.Collections.Concurrent;
using System.Text;
using System.Text.Json;
using Kustodian.Graph.Fetch;
using Kustodian.Graph.Run;

namespace Kustodian.Sources.Hunting;

/// <summary>A column of an advanced hunting table, its type as the engine names it (<see cref="ServerRows.NormalizeType"/>).</summary>
public sealed record HuntingColumn(string Name, string Type, string Description);

/// <summary>A table of the advanced hunting schema, with its columns.</summary>
public sealed record HuntingTable(string Name, string Description, IReadOnlyList<HuntingColumn> Columns);

/// <summary>A parameter of a hunting function.</summary>
public sealed record HuntingParameter(string Name, string Type);

/// <summary>A function of the advanced hunting schema (built in, or saved in the tenant), with its parameters.</summary>
public sealed record HuntingFunction(string Name, string Description, IReadOnlyList<HuntingParameter> Parameters);

/// <summary>The hunting schema the editor and the schema panel work with. <see cref="Origin"/> is <c>tenant</c> (read from Graph
/// for the account) or <c>builtIn</c> (the bundled schema), and then <see cref="FallbackReason"/> says why.</summary>
public sealed record HuntingSchemaView(string Origin, string? FallbackReason, DateTimeOffset RetrievedAt, IReadOnlyList<HuntingTable> Tables,
    IReadOnlyList<HuntingFunction> Functions)
{
    public const string Tenant = "tenant";
    public const string BuiltIn = "builtIn";
}

/// <summary>
/// The advanced hunting schema an account may query, from Graph's <c>GET https://graph.microsoft.com/beta/security/getHuntingSchema</c>
/// (its tables and columns, and its built-in and saved functions), kept per account for 24 hours. Whenever it can't be read (a
/// refusal, a failure, a timeout, no tables) the bundled schema (<see cref="BuiltInHuntingSchema"/>) stands in, with the reason,
/// and the read isn't tried again for 10 minutes. The caller cancelling is not a failed read: nothing is remembered. Ported from
/// the portal's <c>HuntingSchemaSource</c>, without its tenant and demo logic.
/// </summary>
public sealed class HuntingSchemaSource(HttpClient graph, TimeProvider time)
{
    public static readonly Uri Endpoint = new("https://graph.microsoft.com/beta/security/getHuntingSchema");
    public static readonly TimeSpan CacheFor = TimeSpan.FromHours(24);
    public static readonly TimeSpan RetryAfter = TimeSpan.FromMinutes(10);
    public static readonly TimeSpan CallTimeout = TimeSpan.FromSeconds(30);

    /// <summary>A schema has some hundred tables; a body over this is not read on.</summary>
    public const long MaxResponseBytes = 20L * 1024 * 1024;

    private readonly ConcurrentDictionary<string, (HuntingSchemaView View, DateTimeOffset Until)> _cache = new(StringComparer.Ordinal);

    /// <summary>The bundled schema, stamped now, with <paramref name="reason"/>.</summary>
    public HuntingSchemaView BuiltIn(string reason) =>
        new(HuntingSchemaView.BuiltIn, reason, time.GetUtcNow(), BuiltInHuntingSchema.Tables, BuiltInHuntingSchema.Functions);

    /// <summary>The account's schema, from the cache unless <paramref name="refresh"/>, else from Graph; the bundled schema when the
    /// read fails.</summary>
    public async Task<HuntingSchemaView> GetAsync(string accountKey, bool refresh, CancellationToken ct)
    {
        var now = time.GetUtcNow();
        if (!refresh && _cache.TryGetValue(accountKey, out var hit) && now < hit.Until)
        {
            return hit.View;
        }

        ct.ThrowIfCancellationRequested();
        HuntingSchemaView view;
        TimeSpan keep;
        using var timeout = new CancellationTokenSource(CallTimeout, time);
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(ct, timeout.Token);
        try
        {
            var (tables, functions) = await ReadAsync(accountKey, linked.Token);
            (view, keep) = tables.Count == 0
                ? (BuiltIn("The tenant's schema has no tables. The built-in schema is shown."), RetryAfter)
                : (new HuntingSchemaView(HuntingSchemaView.Tenant, null, now, tables, functions ?? BuiltInHuntingSchema.Functions), CacheFor);
        }
        catch (Exception ex) when (!ct.IsCancellationRequested && ConsentRequiredException.FindIn(ex) is null)
        {
            (view, keep) = (BuiltIn(Reason(ex)), RetryAfter);
        }

        _cache[accountKey] = (view, now + keep);
        return view;
    }

    private static string Reason(Exception ex) => ex switch
    {
        _ when SignInRequiredException.IsIn(ex) => "Sign in again to read the tenant's schema. The built-in schema is shown.",
        SchemaReadException read => $"The tenant's schema couldn't be read ({read.Message}). The built-in schema is shown.",
        OperationCanceledException => "Graph didn't send the tenant's schema in time. The built-in schema is shown.",
        _ => "The tenant's schema couldn't be read. The built-in schema is shown.",
    };

    /// <summary>A refused or unreadable answer; the message is Graph's, cleaned (<see cref="GraphErrorText.Summarize"/>).</summary>
    private sealed class SchemaReadException(string message) : Exception(message);

    /// <summary>The tables, and the functions (null when the answer has no <c>functions</c>).</summary>
    private async Task<(IReadOnlyList<HuntingTable> Tables, IReadOnlyList<HuntingFunction>? Functions)> ReadAsync(string accountKey,
        CancellationToken ct)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, Endpoint).ForAccount(accountKey);
        using var response = await graph.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);
        var body = await BodyReader.ReadAsync(response.Content, MaxResponseBytes, ct)
            ?? throw new SchemaReadException("it is too large");
        if (!response.IsSuccessStatusCode)
        {
            if (GraphErrorText.IsTokenRejected(response, body))
            {
                throw new SignInRequiredException(GraphErrorText.SignInMessage);
            }

            throw new SchemaReadException(GraphErrorText.Summarize((int)response.StatusCode, Encoding.UTF8.GetString(body)));
        }

        try
        {
            using var document = JsonDocument.Parse(body);
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
            {
                throw new SchemaReadException("the answer isn't readable");
            }

            IReadOnlyList<HuntingTable> tables = Array(root, "tables").Select(Table).OfType<HuntingTable>().ToList();
            IReadOnlyList<HuntingFunction>? functions = root.TryGetProperty("functions", out var f) && f.ValueKind == JsonValueKind.Object
                ? [.. Array(f, "builtInFunctions").Concat(Array(f, "savedFunctions")).Select(Function).OfType<HuntingFunction>()]
                : null;
            return (tables, functions);
        }
        catch (JsonException)
        {
            throw new SchemaReadException("the answer isn't readable");
        }
    }

    private static IEnumerable<JsonElement> Array(JsonElement e, string property) =>
        e.ValueKind == JsonValueKind.Object && e.TryGetProperty(property, out var value) && value.ValueKind == JsonValueKind.Array
            ? value.EnumerateArray()
            : [];

    private static string? Text(JsonElement e, string property) =>
        e.ValueKind == JsonValueKind.Object && e.TryGetProperty(property, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    private static HuntingTable? Table(JsonElement e) =>
        Text(e, "name") is { Length: > 0 } name
            ? new HuntingTable(name, Text(e, "description") ?? "", [.. Array(e, "columns").Select(Column).OfType<HuntingColumn>()])
            : null;

    private static HuntingColumn? Column(JsonElement e) =>
        Text(e, "name") is { Length: > 0 } name
            ? new HuntingColumn(name, ServerRows.NormalizeType(Text(e, "dataType") ?? ""), Text(e, "description") ?? "")
            : null;

    /// <summary>A built-in function describes itself in <c>documentation</c>, a saved one in <c>description</c>.</summary>
    private static HuntingFunction? Function(JsonElement e) =>
        Text(e, "name") is { Length: > 0 } name
            ? new HuntingFunction(name, Text(e, "documentation") ?? Text(e, "description") ?? "",
                [.. Array(e, "inputParameters").Select(Parameter).OfType<HuntingParameter>()])
            : null;

    private static HuntingParameter? Parameter(JsonElement e) =>
        Text(e, "name") is { Length: > 0 } name ? new HuntingParameter(name, ServerRows.NormalizeType(Text(e, "cslType") ?? "")) : null;
}

/// <summary>
/// The documented advanced hunting schema, embedded as <c>hunting-schema.json</c> (copied from the portal, 66 tables and 4
/// functions). It stands in when an account's own schema can't be read. Names and types only.
/// </summary>
public static class BuiltInHuntingSchema
{
    private sealed record Document(List<DocumentTable> Tables, List<DocumentFunction> Functions);

    private sealed record DocumentTable(string Name, List<DocumentColumn> Columns);

    private sealed record DocumentColumn(string Name, string Type);

    private sealed record DocumentFunction(string Name, string Description, List<HuntingParameter> Parameters);

    private static readonly Lazy<(IReadOnlyList<HuntingTable> Tables, IReadOnlyList<HuntingFunction> Functions)> Loaded = new(Load);

    public static IReadOnlyList<HuntingTable> Tables => Loaded.Value.Tables;

    public static IReadOnlyList<HuntingFunction> Functions => Loaded.Value.Functions;

    private static (IReadOnlyList<HuntingTable>, IReadOnlyList<HuntingFunction>) Load()
    {
        using var stream = typeof(BuiltInHuntingSchema).Assembly.GetManifestResourceStream("hunting-schema.json")
            ?? throw new InvalidOperationException("The embedded hunting-schema.json is missing.");
        var document = JsonSerializer.Deserialize<Document>(stream, new JsonSerializerOptions(JsonSerializerDefaults.Web))
            ?? throw new InvalidOperationException("The embedded hunting-schema.json is empty.");
        return (
            [.. document.Tables.Select(t => new HuntingTable(t.Name, "", [.. t.Columns.Select(c => new HuntingColumn(c.Name, c.Type, ""))]))],
            [.. document.Functions.Select(f => new HuntingFunction(f.Name, f.Description, f.Parameters))]);
    }
}
