using System.Text.Json;
using System.Text.RegularExpressions;

namespace Kustodian.Graph.Schema;

/// <summary>Microsoft's permissions data (<c>permissions/new/permissions.json</c> in microsoft-graph-devx-content, keyed by
/// permission, with API paths inside its path sets) turned into delegated permissions per API path, plus the hand-kept
/// column permissions Microsoft doesn't publish.</summary>
public static partial class GraphPermissions
{
    private const string DelegatedScheme = "DelegatedWork";

    /// <summary>Columns Graph is known to refuse without a higher permission, keyed by table name and column name.</summary>
    public static readonly IReadOnlyDictionary<(string Table, string Column), string> KnownColumns =
        new Dictionary<(string Table, string Column), string>
        {
            [("applications", "onPremisesPublishing")] = "Directory.ReadWrite.All",
        };

    /// <summary>For each path, the permissions Microsoft marks least-privileged for the <c>DelegatedWork</c> scheme (work and
    /// school accounts; Kustodian signs in no others). GET-only path sets win: a read-write permission is least-privileged
    /// for the write on a GET plus POST set, not for listing. A path listed only in sets that include GET among other
    /// methods falls back to those. Keys are <see cref="NormalizePath"/>ed and compared case-insensitively.</summary>
    public static IReadOnlyDictionary<string, IReadOnlyList<string>> ReadDelegated(Stream permissionsJson)
    {
        using var doc = JsonDocument.Parse(permissionsJson);
        var getOnly = new Dictionary<string, SortedSet<string>>(StringComparer.OrdinalIgnoreCase);
        var mixed = new Dictionary<string, SortedSet<string>>(StringComparer.OrdinalIgnoreCase);

        foreach (var permission in doc.RootElement.GetProperty("permissions").EnumerateObject())
        {
            if (!permission.Value.TryGetProperty("pathSets", out var pathSets))
                continue;
            foreach (var pathSet in pathSets.EnumerateArray())
            {
                var methods = pathSet.GetProperty("methods").EnumerateArray().Select(m => m.GetString()).ToList();
                if (!methods.Contains("GET") || !pathSet.GetProperty("schemeKeys").EnumerateArray().Any(IsDelegated))
                    continue;
                var found = methods is ["GET"] ? getOnly : mixed;
                foreach (var path in pathSet.GetProperty("paths").EnumerateObject())
                {
                    if (!LeastIsDelegated(path.Value.GetString() ?? ""))
                        continue;
                    var key = NormalizePath(path.Name);
                    if (!found.TryGetValue(key, out var set))
                        found[key] = set = new SortedSet<string>(StringComparer.Ordinal);
                    set.Add(permission.Name);
                }
            }
        }

        foreach (var (path, permissionsForPath) in mixed.Where(p => !getOnly.ContainsKey(p.Key)))
            getOnly[path] = permissionsForPath;
        return getOnly.ToDictionary(p => p.Key, p => (IReadOnlyList<string>)[.. p.Value], StringComparer.OrdinalIgnoreCase);
    }

    /// <summary>For each path, every read-only permission (its name has <c>.Read</c> and no <c>Write</c>) that a path set
    /// including GET grants for the <c>DelegatedWork</c> scheme, whatever its least-privileged marker: the ones Microsoft marks
    /// least-privileged for <c>DelegatedWork</c> first, then the rest, each part sorted ordinally. <c>User.Read</c> is left
    /// out: Microsoft lists it for the signed-in user's own relationships (<c>/me</c>), which every account can read, not
    /// for another object's. Used for relationship columns, where the denied chip names every permission that would do.
    /// Keys are <see cref="NormalizePath"/>ed and compared case-insensitively.</summary>
    public static IReadOnlyDictionary<string, IReadOnlyList<string>> ReadRelationshipDelegated(Stream permissionsJson)
    {
        using var doc = JsonDocument.Parse(permissionsJson);
        var least = new Dictionary<string, SortedSet<string>>(StringComparer.OrdinalIgnoreCase);
        var other = new Dictionary<string, SortedSet<string>>(StringComparer.OrdinalIgnoreCase);

        foreach (var permission in doc.RootElement.GetProperty("permissions").EnumerateObject())
        {
            if (!IsReadOnly(permission.Name) || permission.Name == "User.Read"
                || !permission.Value.TryGetProperty("pathSets", out var pathSets))
                continue;
            foreach (var pathSet in pathSets.EnumerateArray())
            {
                if (!pathSet.GetProperty("methods").EnumerateArray().Any(m => m.GetString() == "GET")
                    || !pathSet.GetProperty("schemeKeys").EnumerateArray().Any(IsDelegated))
                    continue;
                foreach (var path in pathSet.GetProperty("paths").EnumerateObject())
                {
                    var key = NormalizePath(path.Name);
                    var found = LeastIsDelegated(path.Value.GetString() ?? "") ? least : other;
                    if (!found.TryGetValue(key, out var set))
                        found[key] = set = new SortedSet<string>(StringComparer.Ordinal);
                    set.Add(permission.Name);
                }
            }
        }

        return least.Keys.Union(other.Keys, StringComparer.OrdinalIgnoreCase).ToDictionary(
            key => key,
            key =>
            {
                var first = least.GetValueOrDefault(key) ?? [];
                IReadOnlyList<string> ordered = [.. first, .. (other.GetValueOrDefault(key) ?? []).Where(p => !first.Contains(p))];
                return ordered;
            },
            StringComparer.OrdinalIgnoreCase);
    }

    /// <summary>Whether <paramref name="permission"/> only reads: its name has <c>.Read</c> and no <c>Write</c>.</summary>
    public static bool IsReadOnly(string permission)
        => permission.Contains(".Read", StringComparison.Ordinal) && !permission.Contains("Write", StringComparison.Ordinal);

    /// <summary>A leading <c>/</c>, lower case, and every <c>{…}</c> placeholder as <c>{}</c>.</summary>
    public static string NormalizePath(string path)
    {
        var withSlash = path.StartsWith('/') ? path : "/" + path;
        return PlaceholderRegex().Replace(withSlash, "{}").ToLowerInvariant();
    }

    private static bool IsDelegated(JsonElement scheme) => scheme.GetString() == DelegatedScheme;

    /// <summary>The value reads <c>least=DelegatedWork,Application</c>; anything else (empty, or a different marker) isn't it.</summary>
    private static bool LeastIsDelegated(string value)
        => value.StartsWith("least=", StringComparison.Ordinal)
           && value["least=".Length..].Split(',').Contains(DelegatedScheme);

    [GeneratedRegex(@"\{[^}]*\}")]
    private static partial Regex PlaceholderRegex();
}
