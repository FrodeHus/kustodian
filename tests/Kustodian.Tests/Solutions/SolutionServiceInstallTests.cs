using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Kustodian.History;
using Kustodian.Library;
using Kustodian.Solutions;
using Kustodian.Storage;
using Kustodian.Workbooks;
using Microsoft.Extensions.Time.Testing;

namespace Kustodian.Tests.Solutions;

/// <summary>Install and uninstall against the repo's own sample solution, served from a fake GitHub.</summary>
public sealed class SolutionServiceInstallTests : IDisposable
{
    private const string Id = "entra-id";

    /// <summary>The bundled solution's version, so a bump in Solutions/ doesn't move these tests.</summary>
    private string BundledVersion => _index.Solutions.Single(e => e.Manifest.Id == Id).Manifest.SolutionVersion;
    private const string Folder = "Entra ID";
    private const string IndexUrl = SolutionService.BaseUrl + "index.json";
    private static readonly string SolutionsDir = Path.Combine(FindRoot(), "Solutions");

    private readonly string _dir = Path.Combine(Path.GetTempPath(), "kustodian-sol-" + Guid.NewGuid().ToString("N"));
    private readonly FakeTimeProvider _time = new(DateTimeOffset.Parse("2026-11-07T10:00:00Z", System.Globalization.CultureInfo.InvariantCulture));
    private readonly Dictionary<string, byte[]> _files;
    private readonly LibraryService _library;
    private readonly WorkbookService _workbooks;
    private readonly HistoryStore _history;
    private SolutionIndexDoc _index;
    private byte[] _indexBytes;
    private bool _down;

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    public SolutionServiceInstallTests()
    {
        var dir = Path.Combine(SolutionsDir, Id);
        _files = Directory.EnumerateFiles(dir, "*", SearchOption.AllDirectories)
            .ToDictionary(f => Path.GetRelativePath(dir, f).Replace('\\', '/'), File.ReadAllBytes);
        // The real index as committed, so a mismatch between it and the service's rules shows here.
        _indexBytes = File.ReadAllBytes(Path.Combine(SolutionsDir, "index.json"));
        _index = JsonSerializer.Deserialize<SolutionIndexDoc>(_indexBytes, JsonFileStore.Options)!;
        var store = new JsonFileStore(_dir);
        _library = new LibraryService(store, _time);
        _workbooks = new WorkbookService(store, _time);
        _history = new HistoryStore(_dir, _time);
    }

    public void Dispose()
    {
        _history.Dispose();
        if (Directory.Exists(_dir))
        {
            Directory.Delete(_dir, true);
        }
    }

    private static string FindRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !File.Exists(Path.Combine(dir.FullName, "Kustodian.slnx")))
        {
            dir = dir.Parent;
        }

        return dir?.FullName ?? throw new InvalidOperationException("Kustodian.slnx not found above the test output.");
    }

    private SolutionService Service(string appVersion = "1.1.0")
    {
        var http = new HttpClient(new Handler(url =>
        {
            if (_down)
            {
                throw new HttpRequestException("down");
            }

            if (url == IndexUrl)
            {
                return new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(_indexBytes) };
            }

            var prefix = SolutionService.BaseUrl + Id + "/";
            return url.StartsWith(prefix, StringComparison.Ordinal) && _files.TryGetValue(url[prefix.Length..], out var bytes)
                ? new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(bytes) }
                : new HttpResponseMessage(HttpStatusCode.NotFound);
        }));
        return new SolutionService(new JsonFileStore(_dir), http, _library, _workbooks, _history, _time, appVersion);
    }

    /// <summary>Changes a served file and the index with it, as a new upstream commit would.</summary>
    private void Publish(string path, byte[] bytes)
    {
        _files[path] = bytes;
        var entry = _index.Solutions.Single(e => e.Manifest.Id == Id);
        var manifest = path == "solution.json"
            ? JsonSerializer.Deserialize<SolutionManifest>(bytes, JsonFileStore.Options)!
            : entry.Manifest;
        var files = entry.Files.Select(f => f.Path == path ? new IndexFile(path, SolutionHash.Sha256(bytes), bytes.Length) : f).ToList();
        _index = new SolutionIndexDoc(1, [new IndexEntry(manifest, files)]);
        _indexBytes = JsonSerializer.SerializeToUtf8Bytes(_index, JsonFileStore.Options);
    }

    private JsonObject FileJson(string path) => JsonNode.Parse(_files[path])!.AsObject();

    private static byte[] Bytes(JsonNode node) => Encoding.UTF8.GetBytes(node.ToJsonString());

    private static HashSet<string> Set(params string[] ids) => [.. ids];

    /// <summary>The items an install skips: <paramref name="ids"/>, and every part but the risky-users one, which the tests
    /// use as their sample (two queries, the second linked from the workbook's third widget).</summary>
    private static HashSet<string> Skip(params string[] ids) =>
    [
        .. ids, "btg-findings", "btg-conditional-access", "btg-accounts", "btg-roles", "btg-groups", "btg-sign-ins", "btg-tenant",
        "mfa-by-company", "users-missing-passkey", "break-glass-compliance", "mfa-adoption",
    ];

    private string InstalledPath => Path.Combine(_dir, "solutions.json");

    private string[] SavedFiles() =>
        Directory.Exists(Path.Combine(_dir, "saved")) ? Directory.GetFiles(Path.Combine(_dir, "saved"), "*.json") : [];

    private static SavedQueryInput InputOf(SavedQuery q) => new(q.Id, q.Name, q.Folder, q.Source, q.Text, q.Parameters, q.Options);

    private async Task AssertNothingWritten()
    {
        Assert.Empty(SavedFiles());
        Assert.Empty((await _workbooks.ListAsync(Ct)).Workbooks);
        Assert.False(File.Exists(InstalledPath));
    }

    [Fact]
    public async Task InstallWritesQueriesThenWorkbooks()
    {
        var svc = Service();

        var installed = await svc.InstallAsync(Id, Skip(), Ct);

        var queries = (await _library.ListAsync(Ct)).Queries;
        Assert.Equal(2, queries.Count);
        foreach (var q in queries)
        {
            Assert.Equal(Folder, q.Folder);
            Assert.True(Guid.TryParseExact(q.Id, "D", out _));
            var itemId = q.Origin!.ItemId;
            Assert.Equal(new SolutionOrigin(Id, BundledVersion, itemId, SolutionHash.Sha256(_files[$"queries/{itemId}.json"]),
                SolutionHash.Query(InputOf(q))), q.Origin);
        }

        var riskyUsers = queries.Single(q => q.Origin!.ItemId == "risky-users");
        var summary = Assert.Single((await _workbooks.ListAsync(Ct)).Workbooks);
        Assert.Equal(Folder, summary.Folder);
        Assert.NotEqual(FileJson("workbooks/risky-users-review.json")["id"]!.GetValue<string>(), summary.Id);
        var wb = (await _workbooks.GetAsync(summary.Id, Ct))!;
        var saved = wb["widgets"]![2]!["query"]!["saved"]!;
        Assert.Equal(riskyUsers.Id, saved["id"]!.GetValue<string>());
        Assert.Equal(riskyUsers.Name, saved["name"]!.GetValue<string>());
        Assert.Equal(new SolutionOrigin(Id, BundledVersion, "risky-users-review", SolutionHash.Sha256(_files["workbooks/risky-users-review.json"]),
            SolutionHash.Workbook(wb)), wb["origin"].Deserialize<SolutionOrigin>(JsonFileStore.Options));

        var expected = queries.Select(q => new InstalledItem("query", q.Origin!.ItemId, q.Id))
            .Append(new InstalledItem("workbook", "risky-users-review", summary.Id)).OrderBy(i => i.ItemId).ToList();
        Assert.Equal(expected, installed.Items.OrderBy(i => i.ItemId));
        var file = JsonNode.Parse(await File.ReadAllTextAsync(InstalledPath, Ct))!;
        Assert.Equal(1, file["version"]!.GetValue<int>());
        var listed = Assert.Single(file["installed"]!.Deserialize<List<InstalledSolution>>(JsonFileStore.Options)!);
        Assert.Equal(expected, listed.Items.OrderBy(i => i.ItemId));
        Assert.Equal(_time.GetUtcNow(), listed.InstalledAt);

        Assert.Equal(BundledVersion, (await svc.ListAsync(false, Ct)).Solutions.Single(s => s.Manifest.Id == Id).InstalledVersion);
    }

    [Fact]
    public async Task InstallSkipsItems()
    {
        var installed = await Service().InstallAsync(Id, Skip("risky-signins"), Ct);

        Assert.Equal("risky-users", Assert.Single((await _library.ListAsync(Ct)).Queries).Origin!.ItemId);
        Assert.DoesNotContain(installed.Items, i => i.ItemId == "risky-signins");
        Assert.Equal(2, installed.Items.Count);
    }

    [Fact]
    public async Task InstallSkippedLinkedQueryCopiesIntoWidget()
    {
        await Service().InstallAsync(Id, Skip("risky-users"), Ct);

        var summary = Assert.Single((await _workbooks.ListAsync(Ct)).Workbooks);
        var query = (await _workbooks.GetAsync(summary.Id, Ct))!["widgets"]![2]!["query"]!;
        Assert.Null(query["saved"]);
        Assert.Equal(FileJson("queries/risky-users.json")["text"]!.GetValue<string>(), query["text"]!.GetValue<string>());
        Assert.Equal("risky-signins", Assert.Single((await _library.ListAsync(Ct)).Queries).Origin!.ItemId);
    }

    [Fact]
    public async Task HashMismatchWritesNothing()
    {
        var tampered = FileJson("queries/risky-signins.json");
        tampered["text"] = "users";
        _files["queries/risky-signins.json"] = Bytes(tampered);

        var ex = await Assert.ThrowsAsync<SolutionRejectedException>(() => Service().InstallAsync(Id, Skip(), Ct));

        Assert.Equal("The download didn't match the catalog. Try again later.", ex.Message);
        await AssertNothingWritten();
    }

    [Fact]
    public async Task FailureMidwayRollsBack()
    {
        // A file where the workbooks folder goes: the queries are written, then the workbook's write fails.
        Directory.CreateDirectory(_dir);
        await File.WriteAllTextAsync(Path.Combine(_dir, WorkbookService.Folder), "", Ct);

        await Assert.ThrowsAnyAsync<IOException>(() => Service().InstallAsync(Id, Skip(), Ct));

        Assert.Empty(SavedFiles());
        Assert.False(File.Exists(InstalledPath));
    }

    [Fact]
    public async Task RefusedWorkbookWritesNothing()
    {
        var wb = FileJson("workbooks/risky-users-review.json");
        var widgets = wb["widgets"]!.AsArray();
        while (widgets.Count <= WorkbookService.MaxWidgets)
        {
            widgets.Add(widgets[0]!.DeepClone());
        }

        Publish("workbooks/risky-users-review.json", Bytes(wb));

        var ex = await Assert.ThrowsAsync<SolutionRejectedException>(() => Service().InstallAsync(Id, Skip(), Ct));

        Assert.Contains("at most 100 widgets", ex.Message);
        await AssertNothingWritten();
    }

    [Fact]
    public async Task InstallTwiceIsRefused()
    {
        var svc = Service();
        await svc.InstallAsync(Id, Skip(), Ct);

        var ex = await Assert.ThrowsAsync<SolutionRejectedException>(() => svc.InstallAsync(Id, Skip(), Ct));

        Assert.Equal("This solution is already installed.", ex.Message);
        Assert.Equal(2, SavedFiles().Length);
    }

    [Fact]
    public async Task IncompatibleIsRefused()
    {
        var manifest = FileJson("solution.json");
        manifest["minAppVersion"] = "1.2.0";
        Publish("solution.json", Bytes(manifest));

        var ex = await Assert.ThrowsAsync<SolutionRejectedException>(() => Service("1.1.0").InstallAsync(Id, Skip(), Ct));

        Assert.Equal("Needs Kustodian 1.2.0", ex.Message);
        await AssertNothingWritten();
    }

    [Fact]
    public async Task UninstallRemovesUnmodifiedAndAsks()
    {
        var svc = Service();
        await svc.InstallAsync(Id, Skip(), Ct);
        var edited = (await _library.ListAsync(Ct)).Queries.Single(q => q.Origin!.ItemId == "risky-users");
        await _library.SaveAsync(InputOf(edited) with { Text = edited.Text + "\n| take 10", Name = "Mine" }, Ct);
        var workbookId = Assert.Single((await _workbooks.ListAsync(Ct)).Workbooks).Id;
        await _history.RecordAsync(new RecordRequest(workbookId, "w1", new HistoryQuery("graph", "T", null, []),
            new HistorySetting(HistoryMode.Values, HistoryInterval.Day, 30, []), "all", [new("id", "string")],
            [[JsonSerializer.SerializeToElement("a")]]), Ct);

        var modified = await svc.ModifiedAsync(Id, Ct);

        Assert.Equal([new InstalledItem("query", "risky-users", edited.Id)], modified);

        await svc.UninstallAsync(Id, Set(edited.Id), Ct);

        var kept = Assert.Single((await _library.ListAsync(Ct)).Queries);
        Assert.Equal(edited.Id, kept.Id);
        Assert.Null(kept.Origin);
        Assert.Empty((await _workbooks.ListAsync(Ct)).Workbooks);
        Assert.Empty(await _history.SeriesAsync(workbookId, "w1", Ct));
        var file = JsonNode.Parse(await File.ReadAllTextAsync(InstalledPath, Ct))!;
        Assert.Empty(file["installed"]!.AsArray());
        Assert.Null((await svc.ListAsync(false, Ct)).Solutions.Single(s => s.Manifest.Id == Id).InstalledVersion);
    }

    [Fact]
    public async Task UninstallKeepsAModifiedWorkbookWithoutOrigin()
    {
        var svc = Service();
        await svc.InstallAsync(Id, Skip(), Ct);
        var summary = Assert.Single((await _workbooks.ListAsync(Ct)).Workbooks);
        var wb = (await _workbooks.GetAsync(summary.Id, Ct))!;
        wb.Remove("origin");
        wb["widgets"]!.AsArray().RemoveAt(0);
        await _workbooks.SaveAsync(wb, Ct);

        Assert.Equal([new InstalledItem("workbook", "risky-users-review", summary.Id)], await svc.ModifiedAsync(Id, Ct));

        await svc.UninstallAsync(Id, Set(summary.Id), Ct);

        Assert.False((await _workbooks.GetAsync(summary.Id, Ct))!.ContainsKey("origin"));
        Assert.Empty(SavedFiles());
    }

    [Fact]
    public async Task UninstallNeverDeletesAModifiedItem()
    {
        var svc = Service();
        await svc.InstallAsync(Id, Skip(), Ct);
        var edited = (await _library.ListAsync(Ct)).Queries.Single(q => q.Origin!.ItemId == "risky-users");
        await _library.SaveAsync(InputOf(edited) with { Text = edited.Text + "\n| take 10" }, Ct);
        var summary = Assert.Single((await _workbooks.ListAsync(Ct)).Workbooks);
        var wb = (await _workbooks.GetAsync(summary.Id, Ct))!;
        wb.Remove("origin");
        await _workbooks.SaveAsync(wb, keepOrigin: false, Ct);

        await svc.UninstallAsync(Id, Set(), Ct);

        var kept = Assert.Single((await _library.ListAsync(Ct)).Queries);
        Assert.Equal(edited.Id, kept.Id);
        Assert.Null(kept.Origin);
        Assert.False((await _workbooks.GetAsync(summary.Id, Ct))!.ContainsKey("origin"));
        var file = JsonNode.Parse(await File.ReadAllTextAsync(InstalledPath, Ct))!;
        Assert.Empty(file["installed"]!.AsArray());
    }

    [Fact]
    public async Task UninstallSkipsMissing()
    {
        var svc = Service();
        await svc.InstallAsync(Id, Skip(), Ct);
        var gone = (await _library.ListAsync(Ct)).Queries.Single(q => q.Origin!.ItemId == "risky-signins");
        await _library.DeleteAsync(gone.Id, Ct);

        Assert.Empty(await svc.ModifiedAsync(Id, Ct));
        await svc.UninstallAsync(Id, Set(), Ct);

        Assert.Empty(SavedFiles());
        Assert.Empty((await _workbooks.ListAsync(Ct)).Workbooks);
        var ex = await Assert.ThrowsAsync<SolutionRejectedException>(() => svc.UninstallAsync(Id, Set(), Ct));
        Assert.Equal("That solution isn't installed.", ex.Message);
    }

    [Fact]
    public async Task CorruptSolutionsJsonMovedAside()
    {
        Directory.CreateDirectory(_dir);
        await File.WriteAllTextAsync(InstalledPath, "{ not json", Ct);
        var svc = Service();

        Assert.Null((await svc.ListAsync(false, Ct)).Solutions.Single(s => s.Manifest.Id == Id).InstalledVersion);
        Assert.True(File.Exists(InstalledPath + ".corrupt"));

        await svc.InstallAsync(Id, Skip(), Ct);
        Assert.Equal(BundledVersion, (await svc.ListAsync(false, Ct)).Solutions.Single(s => s.Manifest.Id == Id).InstalledVersion);
    }

    /// <summary>Takes the solution out of the index, as a withdrawal upstream would.</summary>
    private void Withdraw()
    {
        _index = new SolutionIndexDoc(1, [.. _index.Solutions.Where(e => e.Manifest.Id != Id)]);
        _indexBytes = JsonSerializer.SerializeToUtf8Bytes(_index, JsonFileStore.Options);
    }

    [Fact]
    public async Task OfflineAnInstalledSolutionStillOpensAndUninstalls()
    {
        var svc = Service();
        await svc.InstallAsync(Id, Skip(), Ct);
        _time.Advance(TimeSpan.FromHours(2));
        _down = true;

        var (manifest, readme) = await svc.GetAsync(Id, Ct);

        Assert.Equal(Id, manifest.Id);
        Assert.Equal("", readme);
        await svc.UninstallAsync(Id, Set(), Ct);
        Assert.Empty(SavedFiles());
        Assert.Empty((await _workbooks.ListAsync(Ct)).Workbooks);
    }

    [Fact]
    public async Task OfflineWithoutACacheAnInstalledSolutionStillOpens()
    {
        var svc = Service();
        await svc.InstallAsync(Id, Skip(), Ct);
        File.Delete(Path.Combine(_dir, "solution-cache", "index.json"));
        _down = true;

        var (manifest, readme) = await svc.GetAsync(Id, Ct);

        Assert.Equal("Entra ID", manifest.Name);
        Assert.Equal("", readme);
    }

    [Fact]
    public async Task AWithdrawnSolutionIsListedFromItsSnapshotAndUninstalls()
    {
        var svc = Service();
        await svc.InstallAsync(Id, Skip(), Ct);
        var snapshot = _index.Solutions.Single(e => e.Manifest.Id == Id).Manifest;
        Withdraw();

        var item = (await svc.ListAsync(true, Ct)).Solutions.Single(s => s.Manifest.Id == Id);
        Assert.Equal(snapshot.Name, item.Manifest.Name);
        Assert.Equal(snapshot.Content.Queries, item.Manifest.Content.Queries);
        Assert.Equal(snapshot.SolutionVersion, item.InstalledVersion);
        Assert.True(item.Compatible);

        var (manifest, readme) = await svc.GetAsync(Id, Ct);
        Assert.Equal(snapshot.Description, manifest.Description);
        Assert.Equal("", readme);

        await svc.UninstallAsync(Id, Set(), Ct);
        Assert.Empty(SavedFiles());
        Assert.DoesNotContain((await svc.ListAsync(false, Ct)).Solutions, s => s.Manifest.Id == Id);
        var ex = await Assert.ThrowsAsync<SolutionRejectedException>(() => svc.GetAsync(Id, Ct));
        Assert.Equal("That solution isn't in the catalog.", ex.Message);
    }

    [Fact]
    public async Task ASolutionsJsonWithoutSnapshotsStillReads()
    {
        Directory.CreateDirectory(_dir);
        var libraryId = Guid.NewGuid().ToString("D");
        await File.WriteAllTextAsync(InstalledPath, $$"""
            {"version":1,"installed":[{"id":"{{Id}}","solutionVersion":"0.9.0","installedAt":"2026-11-01T00:00:00Z",
              "items":[{"kind":"query","itemId":"risky-users","libraryId":"{{libraryId}}"}]}]}
            """, Ct);
        var svc = Service();

        Assert.Equal("0.9.0", (await svc.ListAsync(false, Ct)).Solutions.Single(s => s.Manifest.Id == Id).InstalledVersion);

        Withdraw();
        var item = (await svc.ListAsync(true, Ct)).Solutions.Single(s => s.Manifest.Id == Id);
        Assert.Equal(Id, item.Manifest.Name);
        Assert.Equal(["risky-users"], item.Manifest.Content.Queries);
        Assert.Equal("0.9.0", item.Manifest.SolutionVersion);
        var (manifest, readme) = await svc.GetAsync(Id, Ct);
        Assert.Equal(Id, manifest.Id);
        Assert.Equal("", readme);
        await svc.UninstallAsync(Id, Set(), Ct);
        Assert.DoesNotContain((await svc.ListAsync(false, Ct)).Solutions, s => s.Manifest.Id == Id);
    }

    private sealed class Handler(Func<string, HttpResponseMessage> answer) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) =>
            Task.FromResult(answer(request.RequestUri!.ToString()));
    }
}
