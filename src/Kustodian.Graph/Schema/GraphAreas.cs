using System.Text.Json;

namespace Kustodian.Graph.Schema;

/// <summary>The data area a Graph table belongs to, so the schema panel can group 436 tables by what the data is about rather
/// than by Graph's URL layout. The map is <c>graph-areas.json</c>, embedded in this assembly: each key is a top-level collection
/// (<c>users</c>, matched exactly) or a prefix ending in <c>/</c> (<c>deviceManagement/</c>, matching every table under it), and
/// its value is one of <see cref="Names"/>. The longest matching key wins; a path nothing matches is <see cref="Other"/>, so a
/// collection Graph adds later still shows. The area is a pure function of the path, worked out when the schema is served, so
/// <c>graph-beta.json</c> doesn't carry it.</summary>
public sealed class GraphAreas
{
    /// <summary>The fallback area, always last.</summary>
    public const string Other = "Other";

    /// <summary>The areas in the order the panel shows them. The web keeps the same list as <c>AREAS</c> in
    /// <c>web/src/schema/schema-panel.tsx</c>, with <c>SPLIT_AREA</c> naming the one it splits by path segment: change them
    /// together.</summary>
    public static IReadOnlyList<string> Names { get; } =
    [
        "Users, groups and directory",
        "Apps and permissions",
        "Sign-in and audit logs",
        "Risk and identity protection",
        "Access reviews and privileged roles",
        "Policies and Conditional Access",
        "Devices and Intune",
        "Security",
        "Mail, Teams and files",
        "Reports and usage",
        Other,
    ];

    private static readonly Lazy<GraphAreas> BundledAreas = new(Load);

    /// <summary>The map committed as <c>graph-areas.json</c>, read once.</summary>
    public static GraphAreas Bundled => BundledAreas.Value;

    /// <summary>Key (exact path or <c>/</c>-ended prefix) → area name.</summary>
    public IReadOnlyDictionary<string, string> Entries { get; }

    /// <summary>A map from <paramref name="entries"/>; every value must be one of <see cref="Names"/>.</summary>
    public GraphAreas(IReadOnlyDictionary<string, string> entries)
    {
        foreach (var (key, area) in entries)
        {
            if (!Names.Contains(area))
                throw new InvalidOperationException($"graph-areas.json maps {key} to {area}, which isn't one of the areas.");
        }

        Entries = entries;
    }

    /// <summary>Whether <paramref name="entry"/> covers <paramref name="path"/>: a prefix entry (ending in <c>/</c>) covers every path
    /// under it, any other entry only the identical path.</summary>
    public static bool Matches(string entry, string path) =>
        entry.EndsWith('/') ? path.StartsWith(entry, StringComparison.Ordinal) : string.Equals(entry, path, StringComparison.Ordinal);

    /// <summary>The area of the table at <paramref name="path"/>: the longest matching entry's, or <see cref="Other"/>.</summary>
    public string Of(string path)
    {
        string? best = null;
        foreach (var entry in Entries.Keys)
        {
            if (Matches(entry, path) && (best is null || entry.Length > best.Length))
                best = entry;
        }

        return best is null ? Other : Entries[best];
    }

    /// <summary>Reads the map: one JSON object of key → area. A repeated key is refused rather than one silently winning.</summary>
    public static GraphAreas Read(Stream stream)
    {
        using var doc = JsonDocument.Parse(stream);
        var entries = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var property in doc.RootElement.EnumerateObject())
        {
            if (!entries.TryAdd(property.Name, property.Value.GetString() ?? ""))
                throw new InvalidOperationException($"graph-areas.json lists {property.Name} twice.");
        }

        return new GraphAreas(entries);
    }

    private static GraphAreas Load()
    {
        using var stream = typeof(GraphAreas).Assembly.GetManifestResourceStream("graph-areas.json")
            ?? throw new InvalidOperationException("The embedded resource graph-areas.json is missing.");
        return Read(stream);
    }
}
