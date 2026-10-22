using System.Net;
using System.Text.Json;
using System.Text.Json.Nodes;
using Kustodian.Graph.Engine;
using Kustodian.Graph.Fetch;
using Kustodian.Graph.Query;
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

    private static readonly string WorkerDll = Path.Combine(AppContext.BaseDirectory, "engine-worker", "Kustodian.TestEngineWorker.dll");

    private sealed class Host(FakeGraph graph, GraphFetchBudget budget, GraphEnginePool engine, GraphRunner runner) : IAsyncDisposable
    {
        public FakeGraph Graph => graph;
        public GraphFetchBudget Budget => budget;
        public GraphEnginePool Engine => engine;

        public Task<RunResult> RunAsync(string kql = Kql, IProgress<RunEvent>? progress = null, CancellationToken ct = default)
            => runner.RunAsync(Account, kql, refresh: false, progress, ct);

        public Task<RunResult> RunAsync(string kql, IReadOnlyList<ParameterValue> parameters, CancellationToken ct)
            => runner.RunAsync(Account, kql, parameters, refresh: false, progress: null, ct);

        public ValueTask DisposeAsync() => engine.DisposeAsync();
    }

    private static Host NewHost(Action<GraphEngineOptions>? configure = null, long budgetBytes = GraphFetchBudget.DefaultMaxBytes)
    {
        var options = new GraphEngineOptions { Workers = 1, WorkerPath = WorkerDll, WorkerArgs = [] };
        configure?.Invoke(options);
        var graph = new FakeGraph();
        var budget = new GraphFetchBudget(budgetBytes);
        var engine = new GraphEnginePool(options, NullLogger<GraphEnginePool>.Instance, TimeProvider.System);
        return new Host(graph, budget, engine, new GraphRunner(GraphSchemaCatalog.Beta, graph.Reader(budget), budget, engine, GraphLimits.Default,
            TimeProvider.System));
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

    // Graph counts; the engine prints the count under the query's column name. No object is read.
    [Theory]
    [InlineData("applications | count", "Count")]
    [InlineData("applications | where createdDateTime >= datetime(2026-01-01) | summarize ['n\\'s'] = count()", "n's")]
    public async Task Run_of_a_count_answers_with_graphs_count(string kql, string column)
    {
        await using var h = NewHost();
        h.Graph.Answer = (request, _) => Task.FromResult(request.RequestUri!.AbsolutePath.EndsWith("/$count", StringComparison.Ordinal)
            ? new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("4321") }
            : FakeGraph.Collection([App("Payroll")]));

        var r = await h.RunAsync(kql, ct: Ct);

        Assert.Equal(RunOutcome.Ok, r.Outcome);
        Assert.Equal([column], r.Columns.Select(c => c.Name));
        Assert.Equal("long", r.Columns[0].Type);
        Assert.Equal(["4321"], Column(r, column));
        Assert.StartsWith("/beta/applications/$count", Assert.Single(h.Graph.Requests), StringComparison.Ordinal);
    }

    [Fact]
    public async Task Run_of_a_count_graph_refuses_counts_the_objects()
    {
        await using var h = NewHost();
        h.Graph.Answer = (request, _) => Task.FromResult(request.RequestUri!.AbsolutePath.EndsWith("/$count", StringComparison.Ordinal)
            ? FakeGraph.Error(HttpStatusCode.BadRequest, "Request_BadRequest", "Unsupported query.")
            : FakeGraph.Collection([App("Payroll"), App("Wiki")]));

        var r = await h.RunAsync("applications | count", ct: Ct);

        Assert.Equal(RunOutcome.Ok, r.Outcome);
        Assert.Equal(["2"], Column(r, "Count"));
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

    // A tenant without SharePoint Online: Graph refuses any users list that selects a SharePoint profile column, and each
    // single-user read of one.
    private static Host SpoLessHost()
    {
        var h = NewHost();
        string[] profile = ["aboutMe", "birthday", "hireDate", "interests", "mySite", "pastProjects", "preferredName",
            "responsibilities", "schools", "skills"];
        object User(string name) => new { id = Guid.NewGuid().ToString(), displayName = name };
        h.Graph.Answer = (request, _) => Task.FromResult(request.Method == HttpMethod.Get
            ? FakeGraph.Select(request).Intersect(profile).Any()
                ? FakeGraph.Error(HttpStatusCode.BadRequest, "BadRequest", "Tenant does not have a SPO license.")
                : FakeGraph.Collection([User("Ada"), User("Grace")])
            : FakeGraph.BatchErrors(request, HttpStatusCode.BadRequest, "BadRequest", "Tenant does not have a SPO license."));
        return h;
    }

    // The built-in Stale guests snippet (src/Kustodian/Snippets/builtin-snippets.json) with its default period.
    private const string StaleGuests = "users\n| where userType == \"Guest\"\n| extend lastSignIn = todatetime(signInActivity.lastSuccessfulSignInDateTime)\n| where isnull(lastSignIn) or lastSignIn < ago(90d)\n| project displayName, userPrincipalName, mail, createdDateTime, lastSignIn\n| order by lastSignIn asc";

    [Fact]
    public async Task Stale_guests_lists_signInActivity_and_filters_on_it()
    {
        await using var h = NewHost();
        var recent = DateTimeOffset.UtcNow.AddDays(-5).ToString("O");
        var old = DateTimeOffset.UtcNow.AddDays(-200).ToString("O");
        object Guest(string name, string? lastSignIn) => new
        {
            id = Guid.NewGuid().ToString(), displayName = name, userType = "Guest",
            signInActivity = lastSignIn is null ? null : new { lastSuccessfulSignInDateTime = lastSignIn },
        };
        h.Graph.Answer = (_, _) => Task.FromResult(FakeGraph.Collection([Guest("Recent", recent), Guest("Old", old), Guest("Never", null)]));

        var r = await h.RunAsync(StaleGuests, ct: Ct);

        Assert.Equal(RunOutcome.Ok, r.Outcome);
        Assert.Equal(["Never", "Old"], Column(r, "displayName"));
        var list = h.Graph.Requests.First(q => q.StartsWith("/beta/users?", StringComparison.Ordinal));
        Assert.Contains("signInActivity", list.Split("$select=")[1].Split('&')[0].Split(','));
        Assert.Empty(Assert.Single(r.Tables).Unlicensed);
    }

    [Fact]
    public async Task Users_in_a_tenant_without_premium_reads_again_without_signInActivity_and_says_so()
    {
        await using var h = NewHost();
        h.Graph.Answer = (request, _) => Task.FromResult(FakeGraph.Select(request).Contains("signInActivity")
            ? FakeGraph.Error(HttpStatusCode.Forbidden, "Authentication_RequestFromNonPremiumTenantOrB2CTenant",
                "Neither tenant is B2C or tenant doesn't have premium license")
            : FakeGraph.Collection([new { id = "1", displayName = "Ada" }]));

        var r = await h.RunAsync("users", ct: Ct);

        Assert.Equal(RunOutcome.Ok, r.Outcome);
        Assert.Equal(["Ada"], Column(r, "displayName"));
        var table = Assert.Single(r.Tables);
        Assert.Contains("signInActivity", table.Unlicensed);
        Assert.Equal("Neither tenant is B2C or tenant doesn't have premium license", table.UnlicensedReason);
    }

    [Fact]
    public async Task Users_runs_in_a_tenant_without_sharepoint()
    {
        await using var h = SpoLessHost();

        var r = await h.RunAsync("users", ct: Ct);

        Assert.Equal(RunOutcome.Ok, r.Outcome);
        Assert.Equal(["Ada", "Grace"], Column(r, "displayName"));
        Assert.Empty(Assert.Single(r.Tables).PerObject);
    }

    [Fact]
    public async Task Users_about_me_refused_per_user_is_empty_and_reported()
    {
        await using var h = SpoLessHost();

        var r = await h.RunAsync("users | project displayName, aboutMe", ct: Ct);

        Assert.Equal(RunOutcome.Ok, r.Outcome);
        Assert.Equal(["Ada", "Grace"], Column(r, "displayName"));
        Assert.Equal(["", ""], Column(r, "aboutMe"));   // a Kusto string has no null: empty
        var table = Assert.Single(r.Tables);
        Assert.Equal(["aboutMe"], table.PerObject);
        Assert.Equal(2, table.PerObjectFailed);
    }

    private static Task<HttpResponseMessage> OwnersAnswer(HttpRequestMessage request, string[] ids, int refusedIndex)
    {
        if (request.Method == HttpMethod.Get)
            return Task.FromResult(FakeGraph.Collection([.. ids.Select(id => new { id, displayName = id })]));
        var batch = JsonNode.Parse(request.Content!.ReadAsStringAsync().GetAwaiter().GetResult())!.AsObject();
        var responses = batch["requests"]!.AsArray().Select(r =>
        {
            var id = r!["url"]!.GetValue<string>().Split('/')[2];
            return id == ids[refusedIndex]
                ? (object)new { id = r["id"]!.GetValue<string>(), status = 403, body = new { error = new { code = "Forbidden", message = "no" } } }
                : new { id = r["id"]!.GetValue<string>(), status = 200, body = new { value = Array.Empty<object>() } };
        }).ToList();
        return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent(JsonSerializer.Serialize(new { responses }), System.Text.Encoding.UTF8, "application/json"),
        });
    }

    [Fact]
    public async Task Relationship_outcome_reaches_the_result()
    {
        await using var h = NewHost();
        string[] ids = ["a1", "a2"];
        h.Graph.Answer = (request, _) => OwnersAnswer(request, ids, 1);
        var events = new Events();

        var r = await h.RunAsync("applications | mv-expand o = owners", events, Ct);

        Assert.Equal(RunOutcome.Ok, r.Outcome);
        var relationship = Assert.Single(Assert.Single(r.Tables).Relationships);
        Assert.Equal("owners", relationship.Column);
        Assert.Equal(2, relationship.Objects);
        Assert.Equal(1, relationship.Refused);
        Assert.Equal(GraphSchemaCatalog.Beta.Find("applications")!.Columns.First(c => c.Name == "owners").Permissions, relationship.Permissions);
        Assert.Equal(1_000, relationship.EntryCap);
        Assert.False(relationship.Capped);
        Assert.False(relationship.FilteredLocally);
        Assert.Contains(events.All, e => e.Stage == "per-object" && e.Detail.Contains("applications.owners", StringComparison.Ordinal));
    }

    [Fact]
    public async Task Unfiltered_read_marks_relationship_filtered_locally()
    {
        await using var h = NewHost();
        string[] ids = ["a1", "a2"];
        h.Graph.Answer = (request, ct) => request.Method == HttpMethod.Get && request.RequestUri!.Query.Contains("$filter", StringComparison.Ordinal)
            ? Task.FromResult(FakeGraph.Error(HttpStatusCode.BadRequest, "Request_UnsupportedQuery", "no filter"))
            : OwnersAnswer(request, ids, 1);

        var r = await h.RunAsync("applications | where displayName == \"a1\" | mv-expand o = owners", ct: Ct);

        Assert.Equal(RunOutcome.Ok, r.Outcome);
        var table = Assert.Single(r.Tables);
        Assert.True(table.Unfiltered);
        Assert.True(Assert.Single(table.Relationships).FilteredLocally);
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
    public async Task Run_over_the_object_cap_reports_too_large_with_the_readers_reason()
    {
        await using var h = NewHost();
        h.Graph.Answer = (request, _) =>
        {
            // Pages of 10,000 until there are more than 50,000.
            var page = request.RequestUri!.Query.Contains("page=", StringComparison.Ordinal)
                ? int.Parse(request.RequestUri.Query.Split("page=")[1], System.Globalization.CultureInfo.InvariantCulture)
                : 0;
            var values = Enumerable.Range(page * 10_000, 10_000).Select(i => new { id = i.ToString(System.Globalization.CultureInfo.InvariantCulture) });
            return Task.FromResult(FakeGraph.Page(values, $"https://graph.microsoft.com/beta/applications?page={page + 1}"));
        };

        var r = await h.RunAsync("applications | project id", ct: Ct);

        Assert.Equal(RunOutcome.TooLarge, r.Outcome);
        Assert.Equal("applications has more than 50,000 objects. Add a `where` Graph can filter on (see the schema list).", r.Message);
        Assert.Equal(0, h.Budget.Used);
    }

    [Fact]
    public async Task Cancel_during_fetch_throws_returns_the_budget_and_next_run_succeeds()
    {
        await using var h = NewHost();
        using var cancel = CancellationTokenSource.CreateLinkedTokenSource(Ct);
        var fetching = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var first = true;
        h.Graph.Answer = async (_, ct) =>
        {
            if (first)
            {
                first = false;
                fetching.SetResult();
                await Task.Delay(Timeout.Infinite, ct);
            }
            return FakeGraph.Collection([App("Payroll")]);
        };

        var running = h.RunAsync(ct: cancel.Token);
        await fetching.Task.WaitAsync(TimeSpan.FromSeconds(10), Ct);
        await cancel.CancelAsync();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => running);
        Assert.Equal(0, h.Budget.Used);
        Assert.Equal(0, h.Engine.Snapshot().Busy);

        var again = await h.RunAsync(ct: Ct);
        Assert.Equal(RunOutcome.Ok, again.Outcome);
        Assert.Equal(["Payroll"], Column(again, "displayName"));
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
    public async Task Run_substitutes_parameters_as_literals()
    {
        await using var h = NewHost();
        h.Graph.Answer = (_, _) => Task.FromResult(FakeGraph.Collection([App("Pay'roll"), App("Wiki")]));

        var r = await h.RunAsync("applications | where displayName == {name} | project displayName",
            [new ParameterValue("name", "text", "Pay'roll", true)], Ct);

        Assert.Equal(RunOutcome.Ok, r.Outcome);
        Assert.Equal(["Pay'roll"], Column(r, "displayName"));
        Assert.Contains("$filter=displayName eq 'Pay''roll'", Assert.Single(h.Graph.Requests), StringComparison.Ordinal);
    }

    [Fact]
    public async Task Missing_required_parameter_is_query_error_without_position()
    {
        await using var h = NewHost();

        var r = await h.RunAsync("applications | where displayName == {name}", [new ParameterValue("name", "text", "", true)], Ct);

        Assert.Equal(RunOutcome.QueryError, r.Outcome);
        Assert.Equal("Fill in name before running.", r.Message);
        Assert.Null(r.Error);
        Assert.Empty(h.Graph.Requests);
    }

    [Fact]
    public async Task Bad_parameter_value_is_query_error_with_the_rule()
    {
        await using var h = NewHost();

        var r = await h.RunAsync("applications | where createdDateTime > ago({withinDays})",
            [new ParameterValue("withinDays", "timespan", "7d) | take 1", true)], Ct);

        Assert.Equal(RunOutcome.QueryError, r.Outcome);
        Assert.Equal("withinDays: a timespan like 7d, 12h or 30m.", r.Message);
        Assert.Null(r.Error);
        Assert.Empty(h.Graph.Requests);
    }

    [Fact]
    public async Task Query_error_after_a_parameter_maps_back_to_the_original_position()
    {
        await using var h = NewHost();
        const string kql = "applications\n| where displayName == {name} | wher x";

        var r = await h.RunAsync(kql, [new ParameterValue("name", "text", new string('a', 100), false)], Ct);

        Assert.Equal(RunOutcome.QueryError, r.Outcome);
        Assert.NotNull(r.Error);
        Assert.Equal(2, r.Error.Line);
        Assert.Equal(kql.Split('\n')[1].IndexOf("wher x", StringComparison.Ordinal) + 1, r.Error.Column);
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
        // The schema lists groups' write permission before its read one.
        Assert.Equal(["Group-NestingSupport.ReadWrite.All", "Group.ReadBasic.All"],
            GraphSchemaCatalog.Beta.Tables.Single(t => t.Name == "groups").Permissions);

        var r = await h.RunAsync("groups | project id", ct: Ct);

        Assert.Equal(RunOutcome.NoPermission, r.Outcome);
        // Any one will do, and the read permission comes first: the least to ask an admin for.
        Assert.Equal("You don't have permission to read groups. It needs one of: Group.ReadBasic.All, Group-NestingSupport.ReadWrite.All.",
            r.Message);
        Assert.Equal("groups", Assert.Single(r.Tables).Table);
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
