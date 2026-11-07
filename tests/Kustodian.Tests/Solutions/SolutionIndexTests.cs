using System.Text;
using Kustodian.Solutions;

namespace Kustodian.Tests.Solutions;

public sealed class SolutionIndexTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "kustodian-tests-" + Guid.NewGuid().ToString("N"));

    public void Dispose()
    {
        if (Directory.Exists(_dir))
        {
            Directory.Delete(_dir, recursive: true);
        }
    }

    private void Write(string relative, string content)
    {
        var path = Path.Combine(_dir, relative);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, content);
    }

    private const string Manifest = """
        {"version":1,"id":"{id}","name":"N","solutionVersion":"1.0.0","description":"d","author":"a","support":"kustodian",
         "categories":[],"sources":["graph"],"minAppVersion":"1.0.0","content":{"queries":["q-one"],"workbooks":[],"tools":[]}}
        """;

    [Fact]
    public void Build_lists_solutions_by_id_with_file_hashes_and_sizes_and_ignores_index_and_dot_files()
    {
        Write("zeta/solution.json", Manifest.Replace("{id}", "zeta"));
        Write("alpha/solution.json", Manifest.Replace("{id}", "alpha"));
        Write("alpha/README.md", "hello");
        Write("alpha/queries/q-one.json", "{}");
        Write("alpha/.DS_Store", "junk");
        Write("index.json", "{}");
        Write("README.md", "guide");

        var doc = SolutionIndex.Build(_dir);

        Assert.Equal(1, doc.Version);
        Assert.Equal(["alpha", "zeta"], doc.Solutions.Select(s => s.Manifest.Id));
        var files = doc.Solutions[0].Files;
        Assert.Equal(["README.md", "queries/q-one.json", "solution.json"], files.Select(f => f.Path));
        Assert.Equal(new IndexFile("README.md", SolutionHash.Sha256(Encoding.UTF8.GetBytes("hello")), 5), files[0]);
    }

    [Fact]
    public void Serialize_ends_with_a_newline_and_uses_camel_case()
    {
        var text = SolutionIndex.Serialize(new SolutionIndexDoc(1, []));

        Assert.EndsWith("\n", text);
        Assert.Contains("\"solutions\"", text);
        Assert.DoesNotContain("\r", text);
    }
}
