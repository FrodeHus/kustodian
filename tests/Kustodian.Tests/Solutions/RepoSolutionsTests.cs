using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using System.Xml.Linq;
using Kusto.Language;
using Kustodian.Graph.Query;
using Kustodian.Library;
using Kustodian.Solutions;
using Kustodian.Storage;
using Kustodian.Workbooks;

namespace Kustodian.Tests.Solutions;

/// <summary>The rules the repo's own <c>Solutions/</c> folder must satisfy; the same ones CI enforces on a pull request.</summary>
public sealed partial class RepoSolutionsTests
{
    private static readonly string Root = FindRoot();
    private static readonly string SolutionsDir = Path.Combine(Root, "Solutions");
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [GeneratedRegex("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")]
    private static partial Regex GuidPattern();

    [GeneratedRegex(@"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")]
    private static partial Regex EmailPattern();

    private static string FindRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !File.Exists(Path.Combine(dir.FullName, "Kustodian.slnx")))
        {
            dir = dir.Parent;
        }

        return dir?.FullName ?? throw new InvalidOperationException("Kustodian.slnx not found above the test output.");
    }

    private static List<(string Folder, SolutionManifest Manifest)> Solutions() =>
        Directory.GetDirectories(SolutionsDir).Where(d => !Path.GetFileName(d).StartsWith('.')).Order(StringComparer.Ordinal)
            .Select(d => (Path.GetFileName(d), JsonSerializer.Deserialize<SolutionManifest>(
                File.ReadAllText(Path.Combine(d, "solution.json")), JsonFileStore.Options)!)).ToList();

    private static string ReadFile(string folder, string relative) => File.ReadAllText(Path.Combine(SolutionsDir, folder, relative));

    private static void Fail(string id, string file, string message) => Assert.Fail($"{id}: {file}: {message}");

    [Fact]
    public void There_is_a_solution() => Assert.NotEmpty(Solutions());

    [Fact]
    public void EveryManifestIsValid()
    {
        foreach (var (folder, m) in Solutions())
        {
            if (SolutionRules.ManifestProblem(m, folder) is { } problem)
            {
                Fail(folder, "solution.json", problem);
            }
        }
    }

    [Fact]
    public void FilesMatchTheManifest()
    {
        foreach (var (folder, m) in Solutions())
        {
            var actual = Directory.EnumerateFiles(Path.Combine(SolutionsDir, folder), "*", SearchOption.AllDirectories)
                .Select(f => Path.GetRelativePath(Path.Combine(SolutionsDir, folder), f).Replace('\\', '/'))
                .Where(f => f != "solution.json").Order(StringComparer.Ordinal).ToList();
            var expected = SolutionRules.ExpectedFiles(m).Order(StringComparer.Ordinal).ToList();
            if (!actual.SequenceEqual(expected))
            {
                Fail(folder, "(files)", $"expected [{string.Join(", ", expected)}] but found [{string.Join(", ", actual)}].");
            }
        }
    }

    private static List<(string Folder, SolutionManifest M, string Id, SavedQueryInput? Input)> Queries() =>
        Solutions().SelectMany(s => s.Manifest.Content.Queries.Select(q =>
            (s.Folder, s.Manifest, q,
                LibraryService.ReadInput(JsonNode.Parse(ReadFile(s.Folder, $"queries/{q}.json")), JsonFileStore.Options)))).ToList();

    [Fact]
    public async Task QueriesLoad()
    {
        var dir = Path.Combine(Path.GetTempPath(), "kustodian-tests-" + Guid.NewGuid().ToString("N"));
        try
        {
            var service = new LibraryService(new JsonFileStore(dir), TimeProvider.System);
            foreach (var (folder, m, id, input) in Queries())
            {
                var file = $"queries/{id}.json";
                if (input is null)
                {
                    Fail(folder, file, "is not a saved query.");
                    continue;
                }

                if (!m.Sources.Contains(input.Source))
                {
                    Fail(folder, file, $"source '{input.Source}' is not one of the manifest's sources.");
                }

                try
                {
                    await service.SaveAsync(input with { Id = null }, Ct);
                }
                catch (LibraryRejectedException e)
                {
                    Fail(folder, file, e.Message);
                }
            }
        }
        finally
        {
            if (Directory.Exists(dir))
            {
                Directory.Delete(dir, recursive: true);
            }
        }
    }

    private static string Sample(ParameterDef p) => p.Value != "" ? p.Value : p.Type switch
    {
        "number" => "0",
        "timespan" => "1d",
        "datetime" => "2000-01-01",
        "list" => p.Choices?.FirstOrDefault() ?? "x",
        _ => "x",
    };

    [Fact]
    public void QueriesParse()
    {
        foreach (var (folder, _, id, input) in Queries())
        {
            var file = $"queries/{id}.json";
            Assert.NotNull(input);
            var values = input.Parameters.Select(p => new ParameterValue(p.Name, p.Type, Sample(p), p.Required)).ToList();
            var result = ParameterSubstitution.Apply(input.Text, values);
            if (result.Text is null)
            {
                Fail(folder, file, result.Missing is { } m ? $"parameter {m} has no value." : result.Error?.Message ?? "substitution failed.");
                continue;
            }

            var errors = KustoCode.Parse(result.Text).GetSyntaxDiagnostics().Where(d => d.Severity == "Error").ToList();
            if (errors.Count > 0)
            {
                Fail(folder, file, errors[0].Message);
            }
        }
    }

    private static List<(string Folder, SolutionManifest M, string Id, JsonObject Json)> Workbooks() =>
        Solutions().SelectMany(s => s.Manifest.Content.Workbooks.Select(w =>
            (s.Folder, s.Manifest, w, JsonNode.Parse(ReadFile(s.Folder, $"workbooks/{w}.json"))!.AsObject()))).ToList();

    [Fact]
    public void WorkbooksLoad()
    {
        foreach (var (folder, m, id, json) in Workbooks())
        {
            var file = $"workbooks/{id}.json";
            if (WorkbookService.Check(json) is { } problem)
            {
                Fail(folder, file, problem);
            }

            var linked = (json["widgets"] as JsonArray ?? []).Select(w => w?["query"]?["saved"]?["id"]?.GetValue<string>()).OfType<string>();
            if (linked.FirstOrDefault(q => !m.Content.Queries.Contains(q)) is { } unknown)
            {
                Fail(folder, file, $"links the query '{unknown}', which the solution does not ship.");
            }
        }
    }

    [Fact]
    public void NoTenantData()
    {
        foreach (var (folder, m) in Solutions())
        {
            foreach (var file in SolutionRules.ExpectedFiles(m))
            {
                var text = ReadFile(folder, file);
                if (file.StartsWith("workbooks/", StringComparison.Ordinal))
                {
                    // A workbook's own id and its widget ids are the only GUIDs a solution may carry.
                    var json = JsonNode.Parse(text)!.AsObject();
                    var own = new[] { json["id"]?.GetValue<string>() }
                        .Concat((json["widgets"] as JsonArray ?? []).Select(w => w?["id"]?.GetValue<string>())).OfType<string>();
                    text = own.Aggregate(text, (t, g) => t.Replace(g, ""));
                }

                if (GuidPattern().Match(text) is { Success: true } guid)
                {
                    Fail(folder, file, $"contains the GUID {guid.Value}.");
                }

                if (EmailPattern().Match(text) is { Success: true } mail)
                {
                    Fail(folder, file, $"contains the e-mail address {mail.Value}.");
                }
            }
        }
    }

    [Fact]
    public void MinAppVersionIsReachable()
    {
        var current = Version.Parse(XDocument.Load(Path.Combine(Root, "Directory.Build.props")).Descendants("Version").First().Value);
        var next = new Version(current.Major, current.Minor + 1, 0);
        foreach (var (folder, m) in Solutions())
        {
            if (Version.Parse(m.MinAppVersion) > next)
            {
                Fail(folder, "solution.json", $"minAppVersion {m.MinAppVersion} is above the next release {next}.");
            }
        }
    }

    [Fact]
    public void IndexIsCurrent()
    {
        var expected = SolutionIndex.Serialize(SolutionIndex.Build(SolutionsDir));
        var path = Path.Combine(SolutionsDir, "index.json");
        if (Environment.GetEnvironmentVariable("KUSTODIAN_WRITE_SOLUTIONS_INDEX") == "1")
        {
            File.WriteAllText(path, expected);
            return;
        }

        Assert.True(File.Exists(path) && File.ReadAllText(path) == expected,
            "Solutions/index.json is out of date. Run: KUSTODIAN_WRITE_SOLUTIONS_INDEX=1 dotnet test --filter IndexIsCurrent");
    }
}
