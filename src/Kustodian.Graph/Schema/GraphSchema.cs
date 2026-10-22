namespace Kustodian.Graph.Schema;

/// <summary>The Graph beta schema as KQL tables. Committed as JSON and loaded at startup.</summary>
public sealed record GraphSchema(
    string Source,
    DateTimeOffset GeneratedAt,
    IReadOnlyList<GraphTable> Tables,
    IReadOnlyDictionary<string, IReadOnlyList<GraphField>> ComplexTypes)
{
    public GraphTable? Find(string name) => Tables.FirstOrDefault(t => t.Name == name);
}

/// <summary>A KQL table over a Graph collection: <c>security/incidents</c> becomes <c>security_incidents</c>.
/// <paramref name="DirectoryObject"/> is true when the entity type is or derives from <c>microsoft.graph.directoryObject</c>,
/// where Graph's string <c>$filter</c> is known to ignore case.</summary>
public sealed record GraphTable(
    string Name,
    string Path,
    string EntityType,
    string Description,
    string DocsUrl,
    IReadOnlyList<GraphColumn> Columns,
    bool DirectoryObject = false)
{
    /// <summary>The least-privileged delegated permissions for listing the table, sorted; empty when Microsoft lists none.</summary>
    public IReadOnlyList<string> Permissions { get; init; } = [];
}

/// <summary>A column: its Kusto type, the operators Graph's <c>$filter</c> accepts on it, whether it is only returned on
/// <c>$select</c>, (for dynamic columns) the complex type behind it, whether it is a collection (of that complex type,
/// a primitive or an enum), and whether a list returns it (<paramref name="Listable"/> is false for a property Graph
/// documents as returned only on a single object's GET, so it is never selected in a list).</summary>
public sealed record GraphColumn(
    string Name,
    string Type,
    string Description,
    IReadOnlyList<string> Filter,
    bool SelectOnly,
    string? ComplexType,
    bool Collection = false,
    bool Listable = true)
{
    /// <summary>A permission or role Graph is known to demand for this column beyond the table's own; hand-kept, since
    /// Microsoft publishes no column-level data.</summary>
    public string? KnownPermission { get; init; }

    /// <summary>True for a navigation property exposed as a column (<c>memberOf</c>, <c>members</c>, ...), fetched with
    /// <c>$expand</c> rather than <c>$select</c>.</summary>
    public bool Relationship { get; init; }

    /// <summary>For a relationship column, the delegated permissions Graph needs to expand it, in the order Microsoft
    /// lists them; empty otherwise.</summary>
    public IReadOnlyList<string> Permissions { get; init; } = [];
}

/// <summary>A field of a complex type, for completion inside a dynamic column.</summary>
public sealed record GraphField(string Name, string Type, bool Collection, string? ComplexType, string Description);
