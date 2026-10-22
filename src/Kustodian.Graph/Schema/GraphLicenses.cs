using System.Text.Json;

namespace Kustodian.Graph.Schema;

/// <summary>A license Microsoft Learn says a Graph table or column needs: <see cref="License"/> in Microsoft's words
/// ("Microsoft Entra ID P2"), the service plans (<c>servicePlanName</c> in <c>subscribedSkus</c>) any one of which provides it,
/// and the Learn page that says so.</summary>
public sealed record GraphLicenseRequirement(string License, IReadOnlyList<string> Plans, string Source);

/// <summary>The licenses Graph tables and columns need, from <c>graph-licenses.json</c>, embedded in this assembly. Microsoft
/// states them only in prose on each API page, so the map is hand-kept, and every entry cites its page. A table key is matched as
/// in <see cref="GraphAreas"/>: an exact path, or a prefix ending in <c>/</c>, the longest matching key winning. A column key is
/// the table's path and the column's name, joined by a dot (<c>users.signInActivity</c>). A table or column no key matches needs
/// no license.</summary>
public sealed class GraphLicenses
{
    private static readonly Lazy<GraphLicenses> BundledLicenses = new(Load);

    /// <summary>The map committed as <c>graph-licenses.json</c>, read once.</summary>
    public static GraphLicenses Bundled => BundledLicenses.Value;

    /// <summary>Table key (exact path or <c>/</c>-ended prefix) → requirement.</summary>
    public IReadOnlyDictionary<string, GraphLicenseRequirement> Tables { get; }

    /// <summary>Column key (<c>path.column</c>) → requirement.</summary>
    public IReadOnlyDictionary<string, GraphLicenseRequirement> Columns { get; }

    public GraphLicenses(IReadOnlyDictionary<string, GraphLicenseRequirement> tables, IReadOnlyDictionary<string, GraphLicenseRequirement> columns)
    {
        Tables = tables;
        Columns = columns;
    }

    /// <summary>What the table at <paramref name="path"/> needs: the longest matching entry's requirement, or null.</summary>
    public GraphLicenseRequirement? ForTable(string path)
    {
        string? best = null;
        foreach (var entry in Tables.Keys)
        {
            if (GraphAreas.Matches(entry, path) && (best is null || entry.Length > best.Length))
                best = entry;
        }

        return best is null ? null : Tables[best];
    }

    /// <summary>What the column <paramref name="column"/> of the table at <paramref name="path"/> needs beyond the table, or
    /// null.</summary>
    public GraphLicenseRequirement? ForColumn(string path, string column) =>
        Columns.TryGetValue(path + "." + column, out var requirement) ? requirement : null;

    /// <summary>Reads the map: <c>{"tables": {key: entry}, "columns": {key: entry}}</c>, each entry
    /// <c>{"license", "plans", "source"}</c>. An entry without a license, without plans, or whose source isn't a Microsoft Learn
    /// page is refused, as is a repeated key or a column key without a dot.</summary>
    public static GraphLicenses Read(Stream stream)
    {
        using var doc = JsonDocument.Parse(stream);
        var root = doc.RootElement;
        var tables = Entries(root, "tables");
        var columns = Entries(root, "columns");
        foreach (var key in columns.Keys)
        {
            var dot = key.LastIndexOf('.');
            if (dot <= 0 || dot == key.Length - 1)
                throw new InvalidOperationException($"graph-licenses.json column {key} isn't a table path and a column joined by a dot.");
        }

        return new GraphLicenses(tables, columns);
    }

    private static Dictionary<string, GraphLicenseRequirement> Entries(JsonElement root, string property)
    {
        var entries = new Dictionary<string, GraphLicenseRequirement>(StringComparer.Ordinal);
        if (!root.TryGetProperty(property, out var section))
            return entries;
        foreach (var entry in section.EnumerateObject())
        {
            var value = entry.Value;
            var license = value.TryGetProperty("license", out var l) ? l.GetString() ?? "" : "";
            var source = value.TryGetProperty("source", out var s) ? s.GetString() ?? "" : "";
            var plans = value.TryGetProperty("plans", out var p) && p.ValueKind == JsonValueKind.Array
                ? p.EnumerateArray().Select(x => x.GetString() ?? "").Where(x => x.Length > 0).ToList()
                : [];
            if (license.Length == 0 || plans.Count == 0)
                throw new InvalidOperationException($"graph-licenses.json {entry.Name} needs a license and at least one plan.");
            if (!source.StartsWith("https://learn.microsoft.com/", StringComparison.Ordinal))
                throw new InvalidOperationException($"graph-licenses.json {entry.Name} needs a Microsoft Learn page as its source.");
            if (!entries.TryAdd(entry.Name, new GraphLicenseRequirement(license, plans, source)))
                throw new InvalidOperationException($"graph-licenses.json lists {entry.Name} twice.");
        }

        return entries;
    }

    private static GraphLicenses Load()
    {
        using var stream = typeof(GraphLicenses).Assembly.GetManifestResourceStream("graph-licenses.json")
            ?? throw new InvalidOperationException("The embedded resource graph-licenses.json is missing.");
        return Read(stream);
    }
}
