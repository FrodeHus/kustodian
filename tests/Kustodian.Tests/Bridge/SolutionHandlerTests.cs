using System.Net;
using System.Text.Json;
using Kustodian.History;
using Kustodian.Library;
using Kustodian.Messaging.Handlers;
using Kustodian.Solutions;
using Kustodian.Storage;
using Kustodian.Workbooks;
using Microsoft.Extensions.Time.Testing;

namespace Kustodian.Tests.Bridge;

/// <summary>The <c>solution.*</c> methods over the bridge, against the repo's own sample solution served from a fake GitHub.</summary>
public sealed class SolutionHandlerTests : IDisposable
{
    private const string Id = "entra-id";
    private static readonly string SolutionsDir = Path.Combine(FindRoot(), "Solutions");

    private readonly string _dir = Path.Combine(Path.GetTempPath(), "kustodian-sol-h-" + Guid.NewGuid().ToString("N"));
    private readonly Messaging.Bridge _bridge = new(_ => { });
    private readonly LibraryService _library;
    private readonly WorkbookService _workbooks;
    private readonly HistoryStore _history;
    private readonly FakeTimeProvider _time;
    private bool _down;

    public SolutionHandlerTests()
    {
        var time = _time = new FakeTimeProvider(DateTimeOffset.Parse("2026-11-07T10:00:00Z", System.Globalization.CultureInfo.InvariantCulture));
        var store = new JsonFileStore(_dir);
        _library = new LibraryService(store, time);
        _workbooks = new WorkbookService(store, time);
        _history = new HistoryStore(_dir, time);
        var http = new HttpClient(new Fake(url =>
        {
            if (_down)
            {
                throw new HttpRequestException("down");
            }

            var path = url.StartsWith(SolutionService.BaseUrl, StringComparison.Ordinal)
                ? Path.Combine(SolutionsDir, url[SolutionService.BaseUrl.Length..])
                : "";
            return File.Exists(path)
                ? new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(File.ReadAllBytes(path)) }
                : new HttpResponseMessage(HttpStatusCode.NotFound);
        }));
        new SolutionHandler(new SolutionService(store, http, _library, _workbooks, _history, time, "1.1.0")).Register(_bridge);
    }

    public void Dispose()
    {
        _history.Dispose();
        if (Directory.Exists(_dir))
        {
            Directory.Delete(_dir, recursive: true);
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

    private async Task<JsonElement> CallAsync(string method, string @params)
    {
        var json = await _bridge.HandleAsync($$"""{"id":"x","method":"{{method}}","params":{{@params}}}""");
        Assert.NotNull(json);
        using var doc = JsonDocument.Parse(json);
        return doc.RootElement.Clone();
    }

    private static void AssertBadRequest(JsonElement response, string message)
    {
        var error = response.GetProperty("error");
        Assert.Equal("bad_request", error.GetProperty("code").GetString());
        Assert.Equal(message, error.GetProperty("message").GetString());
    }

    [Fact]
    public async Task List_answers_the_catalog_with_and_without_params()
    {
        foreach (var p in new[] { "{}", """{"refresh":true}""" })
        {
            var result = (await CallAsync("solution.list", p)).GetProperty("result");
            Assert.False(result.GetProperty("offline").GetBoolean());
            var item = result.GetProperty("solutions").EnumerateArray().Single(s => s.GetProperty("manifest").GetProperty("id").GetString() == Id);
            Assert.True(item.GetProperty("compatible").GetBoolean());
            Assert.Equal(JsonValueKind.Null, item.GetProperty("installedVersion").ValueKind);
        }
    }

    [Fact]
    public async Task Get_install_and_uninstall_round_trip()
    {
        var before = (await CallAsync("solution.get", $$"""{"id":"{{Id}}"}""")).GetProperty("result");
        Assert.Equal(Id, before.GetProperty("manifest").GetProperty("id").GetString());
        Assert.False(string.IsNullOrEmpty(before.GetProperty("readme").GetString()));
        Assert.Equal(JsonValueKind.Null, before.GetProperty("installed").ValueKind);
        Assert.Empty(before.GetProperty("modified").EnumerateArray());

        var installed = (await CallAsync("solution.install", $$"""{"id":"{{Id}}","skip":["break-glass-compliance","risky-users-review","mfa-adoption"]}""")).GetProperty("result");
        Assert.Equal(Id, installed.GetProperty("id").GetString());
        Assert.All(installed.GetProperty("items").EnumerateArray(), i => Assert.Equal("query", i.GetProperty("kind").GetString()));
        Assert.Empty((await _workbooks.ListAsync(TestContext.Current.CancellationToken)).Workbooks);

        var libraryId = installed.GetProperty("items")[0].GetProperty("libraryId").GetString()!;
        var query = (await _library.ListAsync(TestContext.Current.CancellationToken)).Queries.Single(q => q.Id == libraryId);
        await _library.SaveAsync(new SavedQueryInput(query.Id, query.Name, query.Folder, query.Source, query.Text + "\n// mine",
            query.Parameters, query.Options), query.Origin, TestContext.Current.CancellationToken);

        var after = (await CallAsync("solution.get", $$"""{"id":"{{Id}}"}""")).GetProperty("result");
        Assert.Equal(Id, after.GetProperty("installed").GetProperty("id").GetString());
        Assert.Equal([libraryId], after.GetProperty("modified").EnumerateArray().Select(m => m.GetString()).ToArray());

        var removed = await CallAsync("solution.uninstall", $$"""{"id":"{{Id}}","keep":["{{libraryId}}"]}""");
        Assert.Equal(JsonValueKind.Null, removed.GetProperty("result").ValueKind);
        var left = (await _library.ListAsync(TestContext.Current.CancellationToken)).Queries;
        Assert.Equal(libraryId, Assert.Single(left).Id);
    }

    [Fact]
    public async Task Offline_an_installed_solution_still_opens_and_uninstalls()
    {
        await CallAsync("solution.install", $$"""{"id":"{{Id}}"}""");
        _time.Advance(TimeSpan.FromHours(2));
        _down = true;

        var details = (await CallAsync("solution.get", $$"""{"id":"{{Id}}"}""")).GetProperty("result");
        Assert.Equal(Id, details.GetProperty("manifest").GetProperty("id").GetString());
        Assert.Equal("", details.GetProperty("readme").GetString());
        Assert.Equal(Id, details.GetProperty("installed").GetProperty("id").GetString());

        var removed = await CallAsync("solution.uninstall", $$"""{"id":"{{Id}}"}""");
        Assert.Equal(JsonValueKind.Null, removed.GetProperty("result").ValueKind);
        Assert.Empty((await _library.ListAsync(TestContext.Current.CancellationToken)).Queries);
    }

    [Fact]
    public async Task Refusals_are_bad_requests()
    {
        AssertBadRequest(await CallAsync("solution.get", """{"id":"../x"}"""), "That isn't a solution id.");
        AssertBadRequest(await CallAsync("solution.install", "{}"), "That isn't a solution id.");
        AssertBadRequest(await CallAsync("solution.get", """{"id":"not-in-catalog"}"""), "That solution isn't in the catalog.");
        AssertBadRequest(await CallAsync("solution.uninstall", $$"""{"id":"{{Id}}"}"""), "That solution isn't installed.");
        AssertBadRequest(await CallAsync("solution.install", $$"""{"id":"{{Id}}","skip":"x"}"""), "The request's params are not valid.");
    }

    private sealed class Fake(Func<string, HttpResponseMessage> answer) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) =>
            Task.FromResult(answer(request.RequestUri!.ToString()));
    }
}
