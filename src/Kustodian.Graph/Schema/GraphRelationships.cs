using System.Text.Json;

namespace Kustodian.Graph.Schema;

/// <summary>A curated relationship is missing from the metadata: a name that isn't a navigation property of the table's
/// entity type, or a table that doesn't exist.</summary>
public sealed class GraphRelationshipException(string message) : Exception(message);

/// <summary>The navigation properties exposed as relationship columns: per table, the relationships worth a column. The list
/// is <c>graph-relationships.json</c>, embedded in this assembly: table name → relationship name → <c>{}</c> (room for
/// per-relationship settings). Only direct relationships are listed, never <c>transitive*</c>.</summary>
public static class GraphRelationships
{
    private static readonly Lazy<IReadOnlyDictionary<string, IReadOnlyList<string>>> BundledList = new(LoadBundled);

    /// <summary>The list committed as <c>graph-relationships.json</c>, read once.</summary>
    public static IReadOnlyDictionary<string, IReadOnlyList<string>> Bundled => BundledList.Value;

    /// <summary>Reads the list: table name → relationship names, in file order.</summary>
    public static IReadOnlyDictionary<string, IReadOnlyList<string>> Load(Stream json)
    {
        using var doc = JsonDocument.Parse(json);
        var tables = new Dictionary<string, IReadOnlyList<string>>(StringComparer.Ordinal);
        foreach (var table in doc.RootElement.EnumerateObject())
            tables[table.Name] = [.. table.Value.EnumerateObject().Select(r => r.Name)];
        return tables;
    }

    private static IReadOnlyDictionary<string, IReadOnlyList<string>> LoadBundled()
    {
        using var stream = typeof(GraphRelationships).Assembly.GetManifestResourceStream("graph-relationships.json")
            ?? throw new InvalidOperationException("The embedded resource graph-relationships.json is missing.");
        return Load(stream);
    }
}
