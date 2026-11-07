namespace Kustodian.Solutions;

/// <summary>What a solution needs from the tenant; shown to the user and checked against the token where possible.</summary>
public sealed record SolutionRequires(IReadOnlyList<string>? Graph, IReadOnlyList<string>? Roles,
    IReadOnlyList<string>? Licenses, string? Azure);

/// <summary>The items a solution ships: query and workbook ids, and tool names.</summary>
public sealed record SolutionContent(IReadOnlyList<string> Queries, IReadOnlyList<string> Workbooks,
    IReadOnlyList<string> Tools);

/// <summary>A solution's <c>solution.json</c>.</summary>
public sealed record SolutionManifest(int Version, string Id, string Name, string SolutionVersion, string Description,
    string Author, string Support, IReadOnlyList<string> Categories, IReadOnlyList<string> Sources, string MinAppVersion,
    SolutionRequires? Requires, SolutionContent Content);

/// <summary>A file of a solution as listed in the index; <see cref="Path"/> is relative to the solution folder.</summary>
public sealed record IndexFile(string Path, string Sha256, long Size);

/// <summary>A solution in the index: its manifest in full and every file with its hash.</summary>
public sealed record IndexEntry(SolutionManifest Manifest, IReadOnlyList<IndexFile> Files);

/// <summary>The catalog's <c>index.json</c>.</summary>
public sealed record SolutionIndexDoc(int Version, IReadOnlyList<IndexEntry> Solutions);
