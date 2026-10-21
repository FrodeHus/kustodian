using Kustodian.Graph.Schema;

namespace Kustodian.Messaging.Handlers;

/// <summary><c>schema.get</c>: the tables, columns and complex types the schema panel and the editor show.</summary>
public sealed class SchemaHandler(GraphSchema schema)
{
    private readonly Lazy<SchemaView> _graph = new(() => SchemaView.From(schema));

    public void Register(Bridge bridge) =>
        bridge.Register("schema.get", (p, _) =>
        {
            var source = BridgeJson.Params<SchemaParams>(p).Source;
            return source == "graph"
                ? Task.FromResult<object?>(_graph.Value)
                : throw new BridgeException(BridgeErrorCodes.BadRequest, $"Unknown source {source}.");
        });

    private sealed record SchemaParams(string? Source);
}

public sealed record SchemaView(
    string Source, DateTimeOffset GeneratedAt, IReadOnlyList<SchemaTableView> Tables,
    IReadOnlyDictionary<string, IReadOnlyList<GraphField>> ComplexTypes)
{
    public static SchemaView From(GraphSchema schema) => new(
        schema.Source,
        schema.GeneratedAt,
        [.. schema.Tables.Select(t => new SchemaTableView(t.Name, t.Description, t.DocsUrl, t.Permissions,
            [.. t.Columns.Select(c => new SchemaColumnView(c.Name, c.Type, c.Description, c.Filter.Count > 0, c.Listable,
                c.ComplexType, c.Collection))]))],
        schema.ComplexTypes);
}

public sealed record SchemaTableView(
    string Name, string Description, string DocsUrl, IReadOnlyList<string> Permissions, IReadOnlyList<SchemaColumnView> Columns);

/// <summary>A column as the UI sees it. <paramref name="Filterable"/> is true when Graph's <c>$filter</c> accepts any operator
/// on it.</summary>
public sealed record SchemaColumnView(
    string Name, string Type, string Description, bool Filterable, bool Listable, string? ComplexType, bool Collection);
