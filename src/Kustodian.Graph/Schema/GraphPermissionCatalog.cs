using System.Text.Encodings.Web;
using System.Text.Json;

namespace Kustodian.Graph.Schema;

/// <summary>One delegated permission that can read tables: its name, whether it needs admin consent, Microsoft's end-user
/// description of it, and the tables (as <see cref="GraphTable.Path"/>) it can list, sorted ordinally.</summary>
public sealed record CatalogPermission(string Name, bool AdminConsent, string Description, IReadOnlyList<string> Tables);

/// <summary>Every delegated (<c>DelegatedWork</c>) permission that can read a Graph table, not only the least-privileged one
/// <see cref="GraphPermissions.ReadDelegated"/> keeps: the app-creation dialog offers them all. Built from Microsoft's
/// permissions file by <c>tools/schema</c> and committed as <c>graph-permissions.json</c>, embedded in this assembly. The
/// read-only filter (no write permissions) is the planner's, not applied here.</summary>
public sealed record GraphPermissionCatalog(string Source, IReadOnlyList<CatalogPermission> Permissions)
{
    private const string DelegatedScheme = "DelegatedWork";

    private static readonly Lazy<GraphPermissionCatalog> BundledCatalog = new(Load);

    /// <summary>The catalog committed as <c>graph-permissions.json</c>, read once.</summary>
    public static GraphPermissionCatalog Bundled => BundledCatalog.Value;

    /// <summary>Keeps every path set that includes <c>GET</c> and the <c>DelegatedWork</c> scheme, whatever its least-privileged
    /// marker. A table matches a path when <see cref="GraphPermissions.NormalizePath"/> of <c>/{table.Path}</c> equals the
    /// normalized path. Permissions that read no table are omitted; the rest are sorted by name.</summary>
    public static GraphPermissionCatalog Build(Stream permissionsJson, IEnumerable<GraphTable> tables, string source)
    {
        var byPath = new Dictionary<string, List<string>>(StringComparer.OrdinalIgnoreCase);
        foreach (var table in tables)
        {
            var key = GraphPermissions.NormalizePath("/" + table.Path);
            if (!byPath.TryGetValue(key, out var list))
                byPath[key] = list = [];
            list.Add(table.Path);
        }

        using var doc = JsonDocument.Parse(permissionsJson);
        var result = new List<CatalogPermission>();
        foreach (var permission in doc.RootElement.GetProperty("permissions").EnumerateObject())
        {
            if (!permission.Value.TryGetProperty("pathSets", out var pathSets))
                continue;

            var reads = new SortedSet<string>(StringComparer.Ordinal);
            foreach (var pathSet in pathSets.EnumerateArray())
            {
                if (!pathSet.GetProperty("methods").EnumerateArray().Any(m => m.GetString() == "GET")
                    || !pathSet.GetProperty("schemeKeys").EnumerateArray().Any(s => s.GetString() == DelegatedScheme))
                    continue;
                foreach (var path in pathSet.GetProperty("paths").EnumerateObject())
                {
                    if (byPath.TryGetValue(GraphPermissions.NormalizePath(path.Name), out var matches))
                        reads.UnionWith(matches);
                }
            }

            if (reads.Count == 0)
                continue;

            var adminConsent = false;
            var description = "";
            if (permission.Value.TryGetProperty("schemes", out var schemes) && schemes.TryGetProperty(DelegatedScheme, out var delegated))
            {
                adminConsent = delegated.TryGetProperty("requiresAdminConsent", out var consent) && consent.ValueKind == JsonValueKind.True;
                description = delegated.TryGetProperty("userDescription", out var text) ? text.GetString() ?? "" : "";
            }

            result.Add(new CatalogPermission(permission.Name, adminConsent, description, [.. reads]));
        }

        result.Sort((a, b) => string.CompareOrdinal(a.Name, b.Name));
        return new GraphPermissionCatalog(source, result);
    }

    /// <summary>Reads the committed file written by <see cref="Write"/>.</summary>
    public static GraphPermissionCatalog Read(Stream json)
    {
        using var doc = JsonDocument.Parse(json);
        var permissions = doc.RootElement.GetProperty("permissions").EnumerateArray().Select(p => new CatalogPermission(
            p.GetProperty("name").GetString()!,
            p.GetProperty("adminConsent").GetBoolean(),
            p.GetProperty("description").GetString()!,
            [.. p.GetProperty("tables").EnumerateArray().Select(t => t.GetString()!)])).ToList();
        return new GraphPermissionCatalog(doc.RootElement.GetProperty("source").GetString()!, permissions);
    }

    /// <summary>The committed file format: camelCase, 2-space indent, <c>\n</c> line ends, permissions in the order given, so
    /// a regeneration without upstream changes produces no diff.</summary>
    public static string Write(GraphPermissionCatalog catalog)
    {
        using var stream = new MemoryStream();
        var options = new JsonWriterOptions
        {
            Indented = true,
            IndentSize = 2,
            NewLine = "\n",
            Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        };
        using (var w = new Utf8JsonWriter(stream, options))
        {
            w.WriteStartObject();
            w.WriteString("source", catalog.Source);
            w.WriteStartArray("permissions");
            foreach (var permission in catalog.Permissions)
            {
                w.WriteStartObject();
                w.WriteString("name", permission.Name);
                w.WriteBoolean("adminConsent", permission.AdminConsent);
                w.WriteString("description", permission.Description);
                w.WriteStartArray("tables");
                foreach (var table in permission.Tables)
                    w.WriteStringValue(table);
                w.WriteEndArray();
                w.WriteEndObject();
            }

            w.WriteEndArray();
            w.WriteEndObject();
        }

        return System.Text.Encoding.UTF8.GetString(stream.ToArray()) + "\n";
    }

    private static GraphPermissionCatalog Load()
    {
        using var stream = typeof(GraphPermissionCatalog).Assembly.GetManifestResourceStream("graph-permissions.json")
            ?? throw new InvalidOperationException("The embedded resource graph-permissions.json is missing.");
        return Read(stream);
    }
}
