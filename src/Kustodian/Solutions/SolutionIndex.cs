using System.Text.Json;
using Kustodian.Storage;

namespace Kustodian.Solutions;

/// <summary>Builds and writes the catalog's <c>index.json</c> from the <c>Solutions/</c> folder.</summary>
public static class SolutionIndex
{
    /// <summary>Every solution folder (not dot-folders) by id, each with its manifest and its files by path: <c>index.json</c>,
    /// dot-files and the folder-level README are not solutions' files.</summary>
    public static SolutionIndexDoc Build(string solutionsDir)
    {
        var entries = Directory.GetDirectories(solutionsDir).Where(d => !Path.GetFileName(d).StartsWith('.'))
            .Select(dir =>
            {
                var manifest = JsonSerializer.Deserialize<SolutionManifest>(File.ReadAllText(Path.Combine(dir, "solution.json")),
                    JsonFileStore.Options)!;
                var files = Directory.EnumerateFiles(dir, "*", SearchOption.AllDirectories)
                    .Select(f => (Full: f, Relative: Path.GetRelativePath(dir, f).Replace('\\', '/')))
                    .Where(f => !f.Relative.Split('/').Any(part => part.StartsWith('.')))
                    .OrderBy(f => f.Relative, StringComparer.Ordinal)
                    .Select(f =>
                    {
                        var bytes = File.ReadAllBytes(f.Full);
                        return new IndexFile(f.Relative, SolutionHash.Sha256(bytes), bytes.Length);
                    }).ToList();
                return new IndexEntry(manifest, files);
            })
            .OrderBy(e => e.Manifest.Id, StringComparer.Ordinal).ToList();
        return new SolutionIndexDoc(1, entries);
    }

    /// <summary>The index as the file holds it: indented JSON with LF line ends and a trailing newline.</summary>
    public static string Serialize(SolutionIndexDoc doc) =>
        JsonSerializer.Serialize(doc, JsonFileStore.Options).ReplaceLineEndings("\n") + "\n";
}
