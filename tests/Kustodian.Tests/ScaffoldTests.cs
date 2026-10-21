using System.Xml.Linq;

namespace Kustodian.Tests;

public class ScaffoldTests
{
    [Fact(DisplayName = "Solution_has_no_reference_outside_kustodian")]
    public void SolutionHasNoReferenceOutsideKustodian()
    {
        var root = FindSolutionRoot();
        var files = Directory.EnumerateFiles(root, "*.csproj", SearchOption.AllDirectories)
            .Concat(Directory.EnumerateFiles(root, "Directory.*.props", SearchOption.AllDirectories))
            .Where(f => !IsBuildOutput(root, f))
            .ToList();

        Assert.NotEmpty(files);

        var escaping = new List<string>();
        foreach (var file in files)
        {
            var dir = Path.GetDirectoryName(file)!;
            foreach (var element in XDocument.Load(file).Descendants())
            {
                if (element.Name.LocalName is "PackageReference" or "PackageVersion" or "Using")
                {
                    continue;
                }

                foreach (var attribute in element.Attributes().Where(a => a.Name.LocalName is "Include" or "Project" or "Update"))
                {
                    var value = attribute.Value;
                    if (value.Contains("$(", StringComparison.Ordinal))
                    {
                        continue;
                    }

                    var resolved = Path.GetFullPath(Path.Combine(dir, value.Replace('\\', '/')));
                    if (!IsInside(root, resolved))
                    {
                        escaping.Add($"{Path.GetRelativePath(root, file)}: {element.Name.LocalName} {value}");
                    }
                }
            }
        }

        Assert.Empty(escaping);
    }

    private static bool IsBuildOutput(string root, string file)
    {
        var parts = Path.GetRelativePath(root, file).Split(Path.DirectorySeparatorChar);
        return parts.Contains("bin") || parts.Contains("obj");
    }

    private static bool IsInside(string root, string path) =>
        path == root || path.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.Ordinal);

    private static string FindSolutionRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !File.Exists(Path.Combine(dir.FullName, "Kustodian.slnx")))
        {
            dir = dir.Parent;
        }

        return dir?.FullName ?? throw new InvalidOperationException("Kustodian.slnx not found above the test output directory.");
    }
}
