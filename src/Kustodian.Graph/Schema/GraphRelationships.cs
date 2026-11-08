using System.Text.Json;

namespace Kustodian.Graph.Schema;

/// <summary>A curated relationship is missing from the metadata: a name or path segment that isn't a navigation property of
/// the type it is read from, or a table that doesn't exist.</summary>
public sealed class GraphRelationshipException(string message) : Exception(message);

/// <summary>One curated relationship: the column's name, and the path read under each object (<c>/{table}/{id}/{path}</c>),
/// which is the name unless the list gives one (<c>authentication/methods</c>).</summary>
public sealed record GraphRelationship(string Name, string? Path = null)
{
    /// <summary>The path read under each object.</summary>
    public string ReadPath => Path ?? Name;

    public static implicit operator GraphRelationship(string name) => new(name);
}

/// <summary>The navigation properties exposed as relationship columns: per table, the relationships worth a column. The list
/// is <c>graph-relationships.json</c>, embedded in this assembly: table name → relationship name → <c>{}</c>, or
/// <c>{"path": "authentication/methods"}</c> when the column reads something further down than a navigation property of its
/// own name. Only direct relationships are listed, except <c>users.transitiveMemberOf</c>: Conditional Access and role
/// checks need nested groups, and nested reads are what throttles a large tenant, so no other <c>transitive*</c>.</summary>
public static class GraphRelationships
{
    private static readonly Lazy<IReadOnlyDictionary<string, IReadOnlyList<GraphRelationship>>> BundledList = new(LoadBundled);

    /// <summary>The list committed as <c>graph-relationships.json</c>, read once.</summary>
    public static IReadOnlyDictionary<string, IReadOnlyList<GraphRelationship>> Bundled => BundledList.Value;

    /// <summary>Reads the list: table name → relationships, in file order.</summary>
    public static IReadOnlyDictionary<string, IReadOnlyList<GraphRelationship>> Load(Stream json)
    {
        using var doc = JsonDocument.Parse(json);
        var tables = new Dictionary<string, IReadOnlyList<GraphRelationship>>(StringComparer.Ordinal);
        foreach (var table in doc.RootElement.EnumerateObject())
            tables[table.Name] = [.. table.Value.EnumerateObject().Select(r =>
                new GraphRelationship(r.Name, r.Value.TryGetProperty("path", out var path) ? path.GetString() : null))];
        return tables;
    }

    private static IReadOnlyDictionary<string, IReadOnlyList<GraphRelationship>> LoadBundled()
    {
        using var stream = typeof(GraphRelationships).Assembly.GetManifestResourceStream("graph-relationships.json")
            ?? throw new InvalidOperationException("The embedded resource graph-relationships.json is missing.");
        return Load(stream);
    }
}
