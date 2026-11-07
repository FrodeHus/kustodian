using System.Text.RegularExpressions;

namespace Kustodian.Solutions;

/// <summary>The rules a manifest and its listed files must satisfy; each returns a message for the first problem, or null.</summary>
public static partial class SolutionRules
{
    private const long QueryFileLimit = 2_097_152;
    private const long WorkbookFileLimit = 2_097_152;
    private static readonly string[] Supports = ["kustodian", "community"];
    private static readonly string[] SourceNames = ["graph", "hunting", "arg"];

    [GeneratedRegex("^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]\\z")]
    private static partial Regex IdPattern();

    [GeneratedRegex(@"^\d+\.\d+\.\d+\z")]
    private static partial Regex SemverPattern();

    [GeneratedRegex("^[0-9a-f]{64}\\z")]
    private static partial Regex HexPattern();

    [GeneratedRegex("^(queries|workbooks)/([a-z0-9][a-z0-9-]{1,62}[a-z0-9])\\.json\\z")]
    private static partial Regex ItemPathPattern();

    /// <summary>True for 3 to 64 lowercase letters, digits and hyphens, not starting or ending with a hyphen.</summary>
    public static bool IsId(string id) => IdPattern().IsMatch(id);

    /// <summary>The first problem with the manifest, or null when it is valid. <paramref name="folderId"/> is its folder's name.</summary>
    public static string? ManifestProblem(SolutionManifest m, string folderId)
    {
        if (m.Id != folderId)
        {
            return $"Id '{m.Id}' does not match its folder '{folderId}'.";
        }

        if (string.IsNullOrWhiteSpace(m.Name))
        {
            return "Name is empty.";
        }

        if (!Supports.Contains(m.Support))
        {
            return $"Support '{m.Support}' must be 'kustodian' or 'community'.";
        }

        if (!SemverPattern().IsMatch(m.SolutionVersion))
        {
            return $"SolutionVersion '{m.SolutionVersion}' is not x.y.z.";
        }

        if (!SemverPattern().IsMatch(m.MinAppVersion))
        {
            return $"MinAppVersion '{m.MinAppVersion}' is not x.y.z.";
        }

        if (m.Sources.FirstOrDefault(s => !SourceNames.Contains(s)) is { } source)
        {
            return $"Source '{source}' must be graph, hunting or arg.";
        }

        return ItemsProblem("query", m.Content.Queries) ?? ItemsProblem("workbook", m.Content.Workbooks);
    }

    private static string? ItemsProblem(string kind, IReadOnlyList<string> ids)
    {
        if (ids.FirstOrDefault(i => !IsId(i)) is { } bad)
        {
            return $"The {kind} id '{bad}' is not a valid id.";
        }

        return ids.GroupBy(i => i).FirstOrDefault(g => g.Count() > 1) is { } dup
            ? $"The {kind} id '{dup.Key}' is listed twice."
            : null;
    }

    /// <summary>The files a solution folder must hold, in manifest order; <c>tools.json</c> only when it lists tools.</summary>
    public static IReadOnlyList<string> ExpectedFiles(SolutionManifest m) =>
    [
        "README.md",
        .. m.Content.Queries.Select(q => $"queries/{q}.json"),
        .. m.Content.Workbooks.Select(w => $"workbooks/{w}.json"),
        .. m.Content.Tools.Count > 0 ? new[] { "tools.json" } : [],
    ];

    /// <summary>The first problem with an indexed file: its path shape, its hash, or its size.</summary>
    public static string? FileProblem(IndexFile f)
    {
        var limit = f.Path switch
        {
            "README.md" => 262_144L,
            "tools.json" => 65_536L,
            // The 1 MB limit is on query text and LibraryService enforces it; the file also holds parameters and JSON escaping.
            _ when ItemPathPattern().Match(f.Path) is { Success: true } m && m.Groups[1].Value == "queries" => QueryFileLimit,
            _ when ItemPathPattern().IsMatch(f.Path) => WorkbookFileLimit,
            _ => 0L,
        };
        if (limit == 0)
        {
            return $"The path '{f.Path}' is not README.md, tools.json, queries/<id>.json or workbooks/<id>.json.";
        }

        if (!HexPattern().IsMatch(f.Sha256))
        {
            return $"The hash of '{f.Path}' is not 64 lowercase hex characters.";
        }

        return f.Size < 0 || f.Size > limit ? $"'{f.Path}' is {f.Size} bytes; the limit is {limit}." : null;
    }
}
