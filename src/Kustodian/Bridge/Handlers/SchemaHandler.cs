using Kustodian.Graph.Fetch;
using Kustodian.Graph.Schema;

namespace Kustodian.Messaging.Handlers;

/// <summary><c>schema.get</c>: the tables, columns and complex types the schema panel and the editor show.
/// <c>schema.listedByDefault</c>: for the active account, the columns Graph lists by default for each table read so far
/// (<see cref="IGraphProbeCache"/>), by table name; a table not read yet isn't in it.</summary>
public sealed class SchemaHandler(GraphSchema schema, Func<Task<string?>>? activeAccount = null, IGraphProbeCache? probes = null)
{
    private readonly Lazy<SchemaView> _graph = new(() => SchemaView.From(schema));

    public void Register(Bridge bridge)
    {
        bridge.Register("schema.get", (p, _) =>
        {
            RequireGraph(p);
            return Task.FromResult<object?>(_graph.Value);
        });
        bridge.Register("schema.listedByDefault", async (p, ct) =>
        {
            RequireGraph(p);
            return await ListedByDefaultAsync(ct);
        });
    }

    private async Task<ListedByDefault> ListedByDefaultAsync(CancellationToken ct)
    {
        var tables = new Dictionary<string, IReadOnlyList<string>>(StringComparer.Ordinal);
        if (probes is null || activeAccount is null || await activeAccount() is not { } account)
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

    private sealed record SchemaParams(string? Source);

    /// <summary><c>schema.listedByDefault</c>'s answer: the default columns by table name.</summary>
    private sealed record ListedByDefault(IReadOnlyDictionary<string, IReadOnlyList<string>> Tables);
}

public sealed record SchemaView(
    string Source, DateTimeOffset GeneratedAt, IReadOnlyList<SchemaTableView> Tables,
    IReadOnlyDictionary<string, IReadOnlyList<GraphField>> ComplexTypes)
{
    public static SchemaView From(GraphSchema schema) => new(
        schema.Source,
        schema.GeneratedAt,
        [.. schema.Tables.Select(t => new SchemaTableView(t.Name, t.Path, t.Description, t.DocsUrl, t.Permissions,
            [.. t.Columns.Select(c => new SchemaColumnView(c.Name, c.Type, c.Description, c.Filter.Count > 0, c.Listable,
                c.ComplexType, c.Collection))]))],
        schema.ComplexTypes);
}

/// <summary>A table as the UI sees it. <paramref name="Path"/> is its Graph collection relative to the version
/// (<c>auditLogs/signIns</c> for <c>auditLogs_signIns</c>), which the raw tab completes.</summary>
public sealed record SchemaTableView(
    string Name, string Path, string Description, string DocsUrl, IReadOnlyList<string> Permissions, IReadOnlyList<SchemaColumnView> Columns);

/// <summary>A column as the UI sees it. <paramref name="Filterable"/> is true when Graph's <c>$filter</c> accepts any operator
/// on it.</summary>
public sealed record SchemaColumnView(
    string Name, string Type, string Description, bool Filterable, bool Listable, string? ComplexType, bool Collection);
