using System.Net;
using System.Text.Json;
using Kustodian.Graph.Engine;
using Kustodian.Graph.Fetch;
using Kustodian.Graph.Run;
using Kustodian.Graph.Schema;
using Microsoft.Extensions.Logging.Abstractions;

namespace Kustodian.Graph.Tests.Run;

/// <summary>Runs from KQL to rows: the runner over a fake Graph (behind the real reader) and the real engine pool on the worker
/// the test project copies next to itself.</summary>
public sealed class GraphRunnerTests
{
    private const string Account = "account-1";
    private const string Kql = "applications | project displayName";
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    // Catastrophic regex backtracking: hours of work in a few kilobytes (also used by the engine pool's tests).
    private static readonly string SlowQuery = $"print r = '{new string('a', 60)}b' matches regex '^(a|aa)+$'";

    private static readonly string WorkerDll = Path.Combine(AppContext.BaseDirectory, "engine-worker", "Kustodian.EngineWorker.dll");

    private sealed class Host(FakeGraph graph, GraphFetchBudget budget, GraphEnginePool engine, GraphRunner runner) : IAsyncDisposable
    {
        public FakeGraph Graph => graph;
        public GraphFetchBudget Budget => budget;
        public GraphEnginePool Engine => engine;

        public Task<RunResult> RunAsync(string kql = Kql, IProgress<RunEvent>? progress = null, CancellationToken ct = default)
            => runner.RunAsync(Account, kql, refresh: false, progress, ct);

        public ValueTask DisposeAsync() => engine.DisposeAsync();
    }

    private static Host NewHost(Action<GraphEngineOptions>? configure = null, long budgetBytes = GraphFetchBudget.DefaultMaxBytes)
    {
        var options = new GraphEngineOptions { Workers = 1, WorkerPath = WorkerDll, WorkerArgs = [] };
        configure?.Invoke(options);
        var graph = new FakeGraph();
        var budget = new GraphFetchBudget(budgetBytes);
        var engine = new GraphEnginePool(options, NullLogger<GraphEnginePool>.Instance, TimeProvider.System);
        return new Host(graph, budget, engine, new GraphRunner(GraphSchemaCatalog.Beta, graph.Reader(budget), budget, engine, TimeProvider.System));
    }

    private static object App(string name) => new { id = Guid.NewGuid().ToString(), displayName = name };

    private static string?[] Column(RunResult r, string name)
    {
        var i = r.Columns.Select(c => c.Name).ToList().IndexOf(name);
        Assert.True(i >= 0, $"no column {name}");
        return r.Rows.Select(row => row[i].ValueKind == JsonValueKind.Null ? null : row[i].ToString()).ToArray();
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

    [Fact]
    public async Task Run_returns_rows_for_simple_query()
    {
        await using var h = NewHost();
        h.Graph.Answer = (_, _) => Task.FromResult(FakeGraph.Collection([App("Payroll"), App("Wiki")]));

        var r = await h.RunAsync(ct: Ct);

        Assert.Equal(RunOutcome.Ok, r.Outcome);
        Assert.Null(r.Message);
        Assert.Equal(["displayName"], r.Columns.Select(c => c.Name));
        Assert.Equal(["Payroll", "Wiki"], Column(r, "displayName"));
        Assert.Equal(2, r.Total);
        var table = Assert.Single(r.Tables);
        Assert.Equal("applications", table.Table);
        Assert.StartsWith("applications?$select=", Assert.Single(table.Requests));
        Assert.Equal(0, h.Budget.Used);
    }

    [Fact]
    public async Task Run_with_denied_column_returns_rows_and_names_the_column()
    {
        await using var h = NewHost();
        h.Graph.Answer = (request, _) => Task.FromResult(FakeGraph.Select(request).Contains("onPremisesPublishing")
            ? FakeGraph.Error(HttpStatusCode.Forbidden, "Authorization_RequestDenied", "Insufficient privileges to complete the operation.")
            : FakeGraph.Collection([App("Payroll"), App("Wiki")]));

        var r = await h.RunAsync("applications | project displayName, onPremisesPublishing", ct: Ct);

        Assert.Equal(RunOutcome.Ok, r.Outcome);
        Assert.Equal(2, r.Rows.Count);
        Assert.Equal(["onPremisesPublishing"], Assert.Single(r.Tables).Denied);
    }

    [Fact]
    public async Task Run_with_400_on_probe_reads_column_per_object_and_continues()
    {
        await using var h = NewHost();
        h.Graph.Answer = (request, _) => Task.FromResult(
            request.Method == HttpMethod.Get && FakeGraph.Select(request).Contains("onPremisesPublishing")
                ? FakeGraph.Error(HttpStatusCode.BadRequest, "Request_BadRequest", "Invalid object identifier '[sourceEntityId]'.")
                : request.Method == HttpMethod.Get
                    ? FakeGraph.Collection([App("Payroll"), App("Wiki")])
                    : FakeGraph.Collection([]));   // $batch: no item answered

        var r = await h.RunAsync("applications | project displayName, onPremisesPublishing", ct: Ct);

        Assert.Equal(RunOutcome.Ok, r.Outcome);
        Assert.Equal(["Payroll", "Wiki"], Column(r, "displayName"));
        var table = Assert.Single(r.Tables);
        // Graph won't list the column, so it is read one object at a time; here the $batch answers no item, so both fail.
        Assert.Equal(["onPremisesPublishing"], table.PerObject);
        Assert.Equal(2, table.PerObjectFailed);
        Assert.Empty(table.Unreadable);
        Assert.Empty(table.Denied);
        Assert.Contains(table.Requests, q => q.Contains("$top=1") && !q.Contains("displayName"));   // the probes are listed
    }

    [Fact]
    public async Task Run_over_budget_reports_too_large()
    {
        await using var h = NewHost(budgetBytes: 1L << 20);
        var big = new string('x', 5 << 20);
        h.Graph.Answer = (_, _) => Task.FromResult(FakeGraph.Collection([new { id = "1", displayName = big }]));

        var run = h.RunAsync(ct: Ct);
        var r = await run.WaitAsync(TimeSpan.FromSeconds(10), Ct);

        Assert.Equal(RunOutcome.TooLarge, r.Outcome);
        Assert.Equal("Too much data from applications for one run (1 MB). Add a filter or project fewer columns.", r.Message);
        Assert.Equal(0, h.Budget.Used);
    }

    [Fact]
    public async Task Cancel_during_engine_kills_worker_and_next_run_succeeds()
    {
        await using var h = NewHost();
        using var cancel = CancellationTokenSource.CreateLinkedTokenSource(Ct);

        var running = h.RunAsync(SlowQuery, ct: cancel.Token);
        while (h.Engine.Snapshot().Busy == 0 && !running.IsCompleted)
            await Task.Delay(10, Ct);
        await cancel.CancelAsync();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => running);
        var snapshot = h.Engine.Snapshot();
        Assert.Equal(0, snapshot.Busy);
        Assert.True(snapshot.Alive == 0 || snapshot.KillsLastMinute == 1, "the worker was not killed");

        var again = await h.RunAsync("print 1", ct: Ct);
        Assert.Equal(RunOutcome.Ok, again.Outcome);
        Assert.Equal(1, again.Total);
    }

    [Fact]
    public async Task Engine_over_its_time_limit_reports_engine_timeout()
    {
        await using var h = NewHost(o => o.Timeout = TimeSpan.FromSeconds(1));

        var r = await h.RunAsync(SlowQuery, ct: Ct);

        Assert.Equal(RunOutcome.EngineTimeout, r.Outcome);
        Assert.Equal("The query took longer than 1 s and was stopped.", r.Message);
    }

    [Fact]
    public async Task Query_error_returns_position()
    {
        await using var h = NewHost();

        var r = await h.RunAsync("applications | wher x", ct: Ct);

        Assert.Equal(RunOutcome.QueryError, r.Outcome);
        Assert.NotNull(r.Error);
        Assert.Equal(1, r.Error.Line);
        Assert.True(r.Error.Column > 0);
        Assert.Equal(r.Error.Message, r.Message);
        Assert.Empty(h.Graph.Requests);
    }

    [Fact]
    public async Task Refused_query_returns_refusal()
    {
        await using var h = NewHost();

        var r = await h.RunAsync(".show tables", ct: Ct);

        Assert.Equal(RunOutcome.Refused, r.Outcome);
        Assert.False(string.IsNullOrEmpty(r.Message));
        Assert.Empty(h.Graph.Requests);
    }

    [Fact]
    public async Task Cluster_query_is_a_query_error_with_a_position()
    {
        await using var h = NewHost();

        var r = await h.RunAsync("cluster('x').database('y').T", ct: Ct);

        Assert.Equal(RunOutcome.QueryError, r.Outcome);
        Assert.Equal("Only Microsoft Graph tables can be queried.", r.Message);
        Assert.NotNull(r.Error);
        Assert.Equal(1, r.Error.Line);
        Assert.True(r.Error.Column > 0);
    }

    [Fact]
    public async Task Sign_in_required_inside_a_batch_read_is_sign_in_needed_not_failed_items()
    {
        await using var h = NewHost();
        h.Graph.Answer = (request, _) =>
        {
            if (request.Method == HttpMethod.Post)
                throw new HttpRequestException("wrapped", new SignInRequiredException("No token"));
            return Task.FromResult(FakeGraph.Select(request).Contains("onPremisesPublishing")
                ? FakeGraph.Error(HttpStatusCode.BadRequest, "Request_BadRequest", "Invalid object identifier '[sourceEntityId]'.")
                : FakeGraph.Collection([App("Payroll")]));
        };

        var r = await h.RunAsync("applications | project displayName, onPremisesPublishing", ct: Ct);

        Assert.Equal((RunOutcome.SignInNeeded, "Sign in again to run this query."), (r.Outcome, r.Message));
    }

    [Fact]
    public async Task Unauthorized_token_returns_sign_in_needed()
    {
        await using var h = NewHost();
        h.Graph.Answer = (_, _) =>
        {
            var response = FakeGraph.Error(HttpStatusCode.Unauthorized, "InvalidAuthenticationToken", "Access token has expired.");
            response.Headers.WwwAuthenticate.ParseAdd("Bearer error=\"invalid_token\"");
            return Task.FromResult(response);
        };

        var r = await h.RunAsync("applications | project id", ct: Ct);

        Assert.Equal(RunOutcome.SignInNeeded, r.Outcome);
        Assert.Equal("Sign in again to run this query.", r.Message);
    }

    [Fact]
    public async Task Sign_in_required_exception_from_the_pipeline_returns_sign_in_needed_even_when_wrapped()
    {
        await using var h = NewHost();
        var calls = 0;
        h.Graph.Answer = (_, _) => Interlocked.Increment(ref calls) == 1
            ? throw new SignInRequiredException("No token")
            : throw new HttpRequestException("wrapped", new AggregateException(new SignInRequiredException("No token")));

        var direct = await h.RunAsync(ct: Ct);
        var wrapped = await h.RunAsync(ct: Ct);

        Assert.Equal((RunOutcome.SignInNeeded, "Sign in again to run this query."), (direct.Outcome, direct.Message));
        Assert.Equal((RunOutcome.SignInNeeded, "Sign in again to run this query."), (wrapped.Outcome, wrapped.Message));
    }

    [Fact]
    public async Task A_table_graph_refuses_is_no_permission_and_names_what_it_needs()
    {
        await using var h = NewHost();
        h.Graph.Answer = (_, _) => Task.FromResult(
            FakeGraph.Error(HttpStatusCode.Forbidden, "Authorization_RequestDenied", "Insufficient privileges."));
        var table = GraphSchemaCatalog.Beta.Tables.Single(t => t.Name == "applications");

        var r = await h.RunAsync("applications | project id", ct: Ct);

        Assert.Equal(RunOutcome.NoPermission, r.Outcome);
        var expected = table.Permissions.Count > 0
            ? $"You don't have permission to read applications. It needs {string.Join(", ", table.Permissions)}."
            : $"You don't have permission to read applications. {table.DocsUrl}";
        Assert.Equal(expected, r.Message);
        Assert.Equal("applications", Assert.Single(r.Tables).Table);
    }

    [Fact]
    public async Task Throttled_by_graph_is_throttled()
    {
        await using var h = NewHost();
        h.Graph.Answer = (_, _) => Task.FromResult(
            FakeGraph.Error(HttpStatusCode.TooManyRequests, "TooManyRequests", "Too many requests.", retryAfterSeconds: 30));

        var r = await h.RunAsync(ct: Ct);

        Assert.Equal(RunOutcome.Throttled, r.Outcome);
        Assert.Equal("Graph is throttling requests. Try again in 30 s.", r.Message);
    }

    [Fact]
    public async Task An_engine_error_fails_the_run_with_its_message()
    {
        await using var h = NewHost();
        h.Graph.Answer = (_, _) => Task.FromResult(FakeGraph.Collection([new { id = "1", createdDateTime = "2026-01-01T00:00:00Z" }]));

        // KustoLoco can't run `in` over datetimes.
        var r = await h.RunAsync("applications | where createdDateTime in (datetime(2026-01-01))", ct: Ct);

        Assert.Equal(RunOutcome.Failed, r.Outcome);
        Assert.StartsWith("Not supported here: ", r.Message);
    }

    [Fact]
    public async Task Progress_reports_stages_in_order()
    {
        await using var h = NewHost();
        h.Graph.Answer = (_, _) => Task.FromResult(FakeGraph.Collection([App("Payroll")]));
        var events = new Events();

        var r = await h.RunAsync(progress: events, ct: Ct);

        Assert.Equal(RunOutcome.Ok, r.Outcome);
        Assert.Equal(["planning", "fetching", "engine"], events.All.Select(e => e.Stage));
        Assert.Equal("applications", events.All[1].Detail);
    }

    [Fact]
    public async Task Progress_reports_probing_after_fetching_and_before_the_engine()
    {
        await using var h = NewHost();
        h.Graph.Answer = (request, _) => Task.FromResult(FakeGraph.Select(request).Contains("onPremisesPublishing")
            ? FakeGraph.Error(HttpStatusCode.Forbidden, "Authorization_RequestDenied", "Insufficient privileges.")
            : FakeGraph.Collection([App("Payroll")]));
        var events = new Events();

        await h.RunAsync("applications | project displayName, onPremisesPublishing", events, Ct);

        Assert.Equal(["planning", "fetching", "probing", "engine"], events.All.Select(e => e.Stage));
    }
}
