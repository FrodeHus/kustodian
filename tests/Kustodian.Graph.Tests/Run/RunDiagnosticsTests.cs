using System.Collections.Concurrent;
using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Kustodian.Graph.Engine;
using Kustodian.Graph.Fetch;
using Kustodian.Graph.Query;
using Kustodian.Graph.Run;
using Kustodian.Graph.Schema;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Time.Testing;

namespace Kustodian.Graph.Tests.Run;

/// <summary>The run's diagnostics log as the Graph library writes it: the readers' probe, per-object, cache and throttling steps,
/// the engine's worker events, the run id on progress and result, and the cap. The requests themselves are logged by the host's
/// HTTP pipeline (its own tests); here every request is checked to carry the run's log.</summary>
public sealed class RunDiagnosticsTests
{
    private const string Account = "account-1";
    private static CancellationToken Ct => TestContext.Current.CancellationToken;
    private static readonly string WorkerDll = Path.Combine(AppContext.BaseDirectory, "engine-worker", "Kustodian.EngineWorker.dll");

    /// <summary>Applications 0..count-1. A list or probe that selects <c>onPremisesPublishing</c> is refused for permission and
    /// one that selects <c>passwordCredentials</c> answers a 404 web page; <c>$batch</c> answers each item with
    /// <see cref="Item"/>. Every request must carry the run's log.</summary>
    private sealed class Directory(int count) : HttpMessageHandler
    {
        private readonly ConcurrentDictionary<string, int> _tries = new();

        public ConcurrentQueue<RunDiagnostics?> Tagged { get; } = new();

        public Func<string, int, (int Status, string? RetryAfter)> Item { get; set; } = (_, _) => (200, null);

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Tagged.Enqueue(RunDiagnosticsRequest.DiagnosticsOf(request));
            if (request.Method == HttpMethod.Get)
            {
                var query = Uri.UnescapeDataString(request.RequestUri!.OriginalString);
                if (query.Contains("onPremisesPublishing", StringComparison.Ordinal))
                    return Json(HttpStatusCode.Forbidden, new { error = new { code = "Authorization_RequestDenied", message = "Insufficient privileges to complete the operation." } });
                if (query.Contains("passwordCredentials", StringComparison.Ordinal))
                    return Json(HttpStatusCode.NotFound, new { error = new { code = "UnknownError", message = "<!DOCTYPE html><html><title>404 - File or directory not found.</title></html>" } });
                var top = query.Contains("$top=1", StringComparison.Ordinal) && !query.Contains("$top=999", StringComparison.Ordinal) ? 1 : count;
                return Json(HttpStatusCode.OK, new { value = Enumerable.Range(0, top).Select(i => new { id = i.ToString(), displayName = "App " + i }) });
            }

            var batch = JsonNode.Parse(await request.Content!.ReadAsStringAsync(cancellationToken))!.AsObject();
            var responses = batch["requests"]!.AsArray().Select(r =>
            {
                var id = r!["url"]!.GetValue<string>().Split('/')[2].Split('?')[0];
                var (status, retryAfter) = Item(id, _tries.AddOrUpdate(id, 1, (_, n) => n + 1));
                return new
                {
                    id = r["id"]!.GetValue<string>(),
                    status,
                    headers = retryAfter is null ? null : new Dictionary<string, string> { ["Retry-After"] = retryAfter },
                    body = status == 200 ? new { id, passwordCredentials = new[] { new { displayName = "key " + id } } } : null,
                };
            });
            return Json(HttpStatusCode.OK, new { responses });
        }
    }

    private static HttpResponseMessage Json(HttpStatusCode status, object body)
        => new(status) { Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json") };

    private sealed class Cache : IGraphObjectCache
    {
        public ConcurrentDictionary<string, GraphCachedValues> Entries { get; } = new();

        public ValueTask<GraphCachedValues?> GetAsync(string accountKey, string path, IReadOnlyList<string> columns, string id, CancellationToken ct)
            => ValueTask.FromResult(Entries.GetValueOrDefault(id));

        public ValueTask SetAsync(string accountKey, string path, IReadOnlyList<string> columns, string id, string json, CancellationToken ct)
            => ValueTask.CompletedTask;

        public ValueTask RemoveAccountAsync(string accountKey, CancellationToken ct) => ValueTask.CompletedTask;
    }

    private static GraphFetch Fetch(string[] select, string[] named)
        => new(new GraphTable("applications", "applications", "microsoft.graph.application", "", "https://learn.microsoft.com/x", []), select, null)
        {
            Named = named,
        };

    private static async Task<RunDiagnostics> ReadAsync(Directory graph, GraphFetch fetch, IGraphObjectCache? cache = null)
    {
        var diagnostics = new RunDiagnostics(TimeProvider.System);
        var reader = new GraphCollectionReader(new HttpClient(graph) { BaseAddress = new Uri("https://graph.microsoft.com/beta/") },
            new GraphFetchBudget(), cache ?? NoGraphObjectCache.Instance, GraphLimits.Default);
        await reader.ReadAsync(Account, fetch, new GraphFetchBudget().Lease(), false, diagnostics, Ct);
        Assert.NotEmpty(graph.Tagged);
        Assert.All(graph.Tagged, d => Assert.Same(diagnostics, d));
        return diagnostics;
    }

    private static List<DiagnosticEntry> OfKind(RunDiagnostics diagnostics, string kind)
        => diagnostics.Entries.Where(e => e.Kind == kind).ToList();

    [Fact]
    public async Task Retry_after_is_logged_as_throttled_then_retry()
    {
        var graph = new Directory(3) { Item = (id, tries) => id == "1" && tries == 1 ? (429, "0") : (200, null) };

        var diagnostics = await ReadAsync(graph, Fetch(["id", "passwordCredentials"], ["passwordCredentials"]));

        var throttled = Assert.Single(OfKind(diagnostics, "throttled"));
        Assert.Equal(429, throttled.Status);
        Assert.Equal("applications: Graph throttled 1 read; Retry-After 0 s", throttled.Detail);
        var retry = Assert.Single(OfKind(diagnostics, "retry"));
        Assert.Equal("applications: sent 1 read again after 0 s", retry.Detail);
        var kinds = diagnostics.Entries.Select(e => e.Kind).ToList();
        Assert.True(kinds.IndexOf("throttled") < kinds.IndexOf("retry"));
    }

    [Fact]
    public async Task A_throttled_list_page_is_logged_with_its_retry_after()
    {
        var graph = new FakeGraph();
        graph.Answer = (_, _) => Task.FromResult(FakeGraph.Error(HttpStatusCode.TooManyRequests, "TooManyRequests", "Slow down.", 7));
        var diagnostics = new RunDiagnostics(TimeProvider.System);

        await Assert.ThrowsAsync<GraphReadException>(() => graph.Reader(new GraphFetchBudget())
            .ReadAsync(Account, Fetch(["id", "displayName"], []), new GraphFetchBudget().Lease(), false, diagnostics, Ct));

        // Sent once more after the wait, and throttled again: both are logged, and the retry between them.
        Assert.All(OfKind(diagnostics, "throttled"), throttled =>
            Assert.Equal(("applications: Graph is throttling; Retry-After 7 s", (int?)429), (throttled.Detail, throttled.Status)));
        Assert.Equal(2, OfKind(diagnostics, "throttled").Count);
        Assert.Equal("applications: sent the request again after 7 s", Assert.Single(OfKind(diagnostics, "retry")).Detail);
    }

    [Fact]
    public async Task Probe_steps_are_logged_with_dropped_columns()
    {
        var graph = new Directory(3);

        var diagnostics = await ReadAsync(graph, Fetch(["id", "displayName", "onPremisesPublishing", "passwordCredentials"], []));

        var probe = Assert.Single(OfKind(diagnostics, "probe"));
        Assert.Equal("applications: dropped passwordCredentials (Graph won't serve it in a list), "
            + "onPremisesPublishing (Graph refused it for permission)", probe.Detail);
        Assert.Null(probe.Status);
    }

    [Fact]
    public async Task Per_object_batch_and_cache_hits_are_logged()
    {
        var graph = new Directory(5) { Item = (id, _) => id == "4" ? (500, null) : (200, null) };
        var cache = new Cache();
        foreach (var id in new[] { "0", "1" })
            cache.Entries[id] = new GraphCachedValues("{\"passwordCredentials\":[]}", DateTimeOffset.UnixEpoch);

        var diagnostics = await ReadAsync(graph, Fetch(["id", "passwordCredentials"], ["passwordCredentials"]), cache);

        Assert.Equal("applications: passwordCredentials for 2 objects from the cache", Assert.Single(OfKind(diagnostics, "cache")).Detail);
        Assert.Equal("applications: read passwordCredentials one object at a time for 3 objects, 1 failed",
            Assert.Single(OfKind(diagnostics, "per-object")).Detail);
    }

    [Fact]
    public void Entries_cap_at_5000()
    {
        var diagnostics = new RunDiagnostics(TimeProvider.System);

        Parallel.For(0, 5_003, i => diagnostics.Add(new DiagnosticEntry(i, "request", "GET applications", 200, 1, 10)));

        var entries = diagnostics.Entries;
        Assert.Equal(5_001, entries.Count);
        Assert.Equal("3 more entries not shown", entries[^1].Detail);
        Assert.Equal(entries.Take(5_000).Select(e => e.AtMs).Order(), entries.Take(5_000).Select(e => e.AtMs));
    }

    [Fact]
    public void Entries_are_in_time_order_and_timed_from_the_run_start()
    {
        var time = new FakeTimeProvider();
        var diagnostics = new RunDiagnostics(time);
        time.Advance(TimeSpan.FromMilliseconds(250));

        diagnostics.Add(new DiagnosticEntry(diagnostics.NowMs, "request", "GET b", 200, 5, 1));
        diagnostics.Add(new DiagnosticEntry(100, "request", "GET a", 200, 200, 1));

        Assert.Equal(["GET a", "GET b"], diagnostics.Entries.Select(e => e.Detail));
        Assert.Equal(250, diagnostics.Entries[1].AtMs);
        Assert.True(Guid.TryParse(diagnostics.RunId, out _));
        Assert.NotEqual(diagnostics.RunId, new RunDiagnostics(time).RunId);
    }

    [Fact]
    public async Task Progress_events_carry_run_id()
    {
        await using var engine = Pool();
        var graph = new FakeGraph();
        graph.Answer = (_, _) => Task.FromResult(FakeGraph.Collection([new { id = "1", displayName = "Payroll" }]));
        var events = new Events();

        var r = await Runner(graph, engine).RunAsync(Account, "applications | project displayName", false, events, Ct);

        Assert.Equal(RunOutcome.Ok, r.Outcome);
        Assert.True(Guid.TryParse(r.RunId, out _));
        Assert.NotEmpty(events.All);
        Assert.All(events.All, e => Assert.Equal(r.RunId, e.RunId));
    }

    [Theory]
    [InlineData("3d8e2f6a-5b1c-4c7e-9a2d-1f4b6c8e0a12", true)]
    [InlineData("not-a-guid", false)]
    [InlineData("3d8e2f6a5b1c4c7e9a2d1f4b6c8e0a12", false)]   // a GUID, but not in "D" format
    [InlineData("", false)]
    [InlineData(null, false)]
    public async Task A_supplied_run_id_is_used_when_it_is_a_guid(string? supplied, bool used)
    {
        await using var engine = Pool();
        var graph = new FakeGraph();
        graph.Answer = (_, _) => Task.FromResult(FakeGraph.Collection([new { id = "1", displayName = "Payroll" }]));
        var events = new Events();

        var r = await Runner(graph, engine).RunAsync(Account, "applications | project displayName", [], false, supplied, events, Ct);

        Assert.Equal(RunOutcome.Ok, r.Outcome);
        if (used)
            Assert.Equal(supplied, r.RunId);
        else
            Assert.True(Guid.TryParseExact(r.RunId, "D", out _) && r.RunId != supplied);
        Assert.NotEmpty(events.All);
        Assert.All(events.All, e => Assert.Equal(r.RunId, e.RunId));
    }

    [Fact]
    public async Task A_supplied_run_id_names_a_parameter_error_too()
    {
        await using var engine = Pool();
        const string RunId = "3d8e2f6a-5b1c-4c7e-9a2d-1f4b6c8e0a12";

        var r = await Runner(new FakeGraph(), engine).RunAsync(Account, "applications | where displayName == name",
            [new ParameterValue("name", "text", "", true)], false, RunId, null, Ct);

        Assert.Equal((RunOutcome.QueryError, RunId), (r.Outcome, r.RunId));
    }

    [Fact]
    public async Task Engine_start_and_kill_are_logged()
    {
        await using var engine = Pool(o => o.MemoryLimitBytes = 200L * 1024 * 1024);
        var graph = new FakeGraph();
        // 3,000 rows joined to themselves on one key is 9,000,000 rows: far past 200 MB (the engine pool's memory-kill query).
        graph.Answer = (_, _) => Task.FromResult(FakeGraph.Collection(
            Enumerable.Range(1, 3_000).Select(i => new { id = i.ToString(), displayName = $"application number {i}" })));
        var runner = Runner(graph, engine);

        var ok = await runner.RunAsync(Account, "applications | count", false, null, Ct);
        var killed = await runner.RunAsync(Account,
            "applications | extend k = 1 | join kind=inner (applications | extend k = 1) on k | summarize count() by displayName, displayName1",
            false, null, Ct);

        Assert.Equal(RunOutcome.Ok, ok.Outcome);
        var answered = ok.Diagnostics.Where(e => e.Kind == "engine").ToList();
        Assert.Equal(2, answered.Count);
        Assert.Matches(@"^worker \d+ started$", answered[0].Detail);
        Assert.Matches(@"^worker \d+ answered, peak \d+ MB$", answered[1].Detail);
        Assert.NotNull(answered[1].DurationMs);

        Assert.Equal(RunOutcome.EngineMemory, killed.Outcome);
        var engineEvents = killed.Diagnostics.Where(e => e.Kind == "engine").ToList();
        Assert.Equal(2, engineEvents.Count);
        Assert.Matches(@"^worker \d+ started$", engineEvents[0].Detail);
        Assert.Matches(@"^worker \d+ killed: memory$", engineEvents[1].Detail);
        Assert.NotNull(engineEvents[1].DurationMs);
    }

    [Fact]
    public async Task Pool_reports_start_done_and_killed_with_the_reason()
    {
        await using var engine = Pool(o => o.Timeout = TimeSpan.FromSeconds(1));
        var infos = new Infos();
        var now = DateTimeOffset.UnixEpoch;

        await engine.RunAsync(new EngineRequest("print 1", now, [], 10), "run-1", infos, Ct);
        await Assert.ThrowsAsync<GraphEngineException>(() =>
            engine.RunAsync(new EngineRequest($"print r = '{new string('a', 60)}b' matches regex '^(a|aa)+$'", now, [], 10), "run-2", infos, Ct));

        Assert.Equal(["start", "done", "start", "killed"], infos.All.Select(i => i.Event));
        Assert.All(infos.All, i => Assert.True(i.WorkerPid > 0));
        Assert.Equal("timeout", infos.All[3].Reason);
        Assert.True(infos.All[1].PeakBytes > 0);
    }

    private static GraphEnginePool Pool(Action<GraphEngineOptions>? configure = null)
    {
        var options = new GraphEngineOptions { Workers = 1, WorkerPath = WorkerDll, WorkerArgs = [] };
        configure?.Invoke(options);
        return new GraphEnginePool(options, NullLogger<GraphEnginePool>.Instance, TimeProvider.System);
    }

    private static GraphRunner Runner(FakeGraph graph, GraphEnginePool engine)
    {
        var budget = new GraphFetchBudget();
        return new GraphRunner(GraphSchemaCatalog.Beta, graph.Reader(budget), budget, engine, GraphLimits.Default, TimeProvider.System);
    }

    private sealed class Events : IProgress<RunEvent>
    {
        public List<RunEvent> All { get; } = [];

        public void Report(RunEvent value)
        {
            lock (All)
                All.Add(value);
        }
    }

    private sealed class Infos : IProgress<EngineRunInfo>
    {
        public List<EngineRunInfo> All { get; } = [];

        public void Report(EngineRunInfo value)
        {
            lock (All)
                All.Add(value);
        }
    }
}
