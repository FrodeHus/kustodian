using Kustodian.Solutions;

namespace Kustodian.Tests.Solutions;

public sealed class SolutionRulesTests
{
    private static SolutionManifest Valid() => new(1, "entra-risky-users", "Entra risky users", "1.2.0", "d", "frodehus",
        "kustodian", ["identity"], ["graph", "hunting"], "0.9.0", null,
        new SolutionContent(["risky-users", "risky-signins"], ["weekly-review"], ["Confirm compromised"]));

    [Theory]
    [InlineData("entra-risky-users", true)]
    [InlineData("abc", true)]
    [InlineData("ab", false)]
    [InlineData("-abc", false)]
    [InlineData("abc-", false)]
    [InlineData("ABC", false)]
    [InlineData("a_b", false)]
    public void IsId(string id, bool expected) => Assert.Equal(expected, SolutionRules.IsId(id));

    [Fact]
    public void IsId_refuses_65_characters() => Assert.False(SolutionRules.IsId(new string('a', 65)));

    [Fact]
    public void IsId_refuses_a_trailing_newline() => Assert.False(SolutionRules.IsId("abc\n"));

    [Fact]
    public void FileProblem_refuses_a_trailing_newline()
    {
        Assert.NotNull(SolutionRules.FileProblem(new IndexFile("queries/abc.json\n", Hash, 10)));
        Assert.NotNull(SolutionRules.FileProblem(new IndexFile("README.md", Hash + "\n", 10)));
    }

    [Fact]
    public void IsId_accepts_64_characters() => Assert.True(SolutionRules.IsId(new string('a', 64)));

    [Fact]
    public void Valid_manifest_has_no_problem() => Assert.Null(SolutionRules.ManifestProblem(Valid(), "entra-risky-users"));

    public static TheoryData<SolutionManifest> Invalid()
    {
        var v = Valid();
        return new TheoryData<SolutionManifest>
        {
            v with { Id = "other" },
            v with { Support = "vendor" },
            v with { SolutionVersion = "1.2" },
            v with { MinAppVersion = "x.y.z" },
            v with { Sources = ["graph", "sql"] },
            v with { Content = v.Content with { Queries = ["Bad_Id"] } },
            v with { Content = v.Content with { Queries = ["same-id", "same-id"] } },
            v with { Content = v.Content with { Workbooks = ["ab"] } },
            v with { Name = " " },
        };
    }

    [Theory]
    [MemberData(nameof(Invalid))]
    public void Invalid_manifest_has_a_problem(SolutionManifest m) =>
        Assert.NotNull(SolutionRules.ManifestProblem(m, "entra-risky-users"));

    [Fact]
    public void ExpectedFiles_follow_the_manifest()
    {
        var v = Valid();
        Assert.Equal(["README.md", "queries/risky-users.json", "queries/risky-signins.json",
            "workbooks/weekly-review.json", "tools.json"], SolutionRules.ExpectedFiles(v));
        Assert.DoesNotContain("tools.json", SolutionRules.ExpectedFiles(v with { Content = v.Content with { Tools = [] } }));
    }

    private static readonly string Hash = new('a', 64);

    [Theory]
    [InlineData("README.md")]
    [InlineData("tools.json")]
    [InlineData("queries/risky-users.json")]
    [InlineData("workbooks/weekly-review.json")]
    public void FileProblem_accepts_the_allowed_shapes(string path) =>
        Assert.Null(SolutionRules.FileProblem(new IndexFile(path, Hash, 10)));

    [Theory]
    [InlineData("../x.json")]
    [InlineData("/x.json")]
    [InlineData("queries/../../x")]
    [InlineData("a\\b.json")]
    [InlineData("other.json")]
    [InlineData("queries/Bad.json")]
    [InlineData("queries/sub/abc.json")]
    public void FileProblem_refuses_bad_paths(string path) =>
        Assert.NotNull(SolutionRules.FileProblem(new IndexFile(path, Hash, 10)));

    [Theory]
    [InlineData("")]
    [InlineData("ABCDEF")]
    public void FileProblem_refuses_bad_hashes(string hash) =>
        Assert.NotNull(SolutionRules.FileProblem(new IndexFile("README.md", hash, 10)));

    [Fact]
    public void FileProblem_refuses_uppercase_and_short_hash_lengths()
    {
        Assert.NotNull(SolutionRules.FileProblem(new IndexFile("README.md", new string('A', 64), 10)));
        Assert.NotNull(SolutionRules.FileProblem(new IndexFile("README.md", new string('a', 63), 10)));
    }

    [Theory]
    [InlineData("README.md", 262_145)]
    [InlineData("tools.json", 65_537)]
    [InlineData("queries/abc.json", 2_097_153)]
    [InlineData("workbooks/abc.json", 2_097_153)]
    public void FileProblem_refuses_oversize(string path, long size) =>
        Assert.NotNull(SolutionRules.FileProblem(new IndexFile(path, Hash, size)));
}
