using System.Globalization;
using System.Net;
using System.Net.Http.Headers;
using System.Text.Json;
using System.Text.Json.Nodes;
using Kustodian.Graph.Engine;
using Kustodian.Graph.Fetch;
using Kustodian.Graph.Query;
using Kustodian.Graph.Run;
using Kustodian.Sources.Arg;
using Kustodian.Sources.Tests.Hunting;
using Microsoft.Extensions.Time.Testing;

namespace Kustodian.Sources.Tests.Arg;

public class ArgQuerySourceTests
{
    private const string Account = "account-1";
    private const string RunId = "6f9619ff-8b86-d011-b42d-00c04fc964ff";
    private const string Sub1 = "00000000-0000-0000-0000-000000000001";
    private const string Sub2 = "00000000-0000-0000-0000-000000000002";
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private readonly FakeTimeProvider _time = new(new DateTimeOffset(2026, 10, 21, 8, 0, 0, TimeSpan.Zero));

    private ArgQuerySource Source(StubGraph arm, int rowsPerRun = 50_000) => new(new ArgClient(arm.Client(), _time), rowsPerRun, _time);

    private static QueryRunRequest Request(string kql, ArgScope? scope = null, IReadOnlyList<ParameterValue>? parameters = null) =>
        new(Account, kql, parameters ?? [], false, RunId, scope is null ? null : new QueryOptions(null, scope));

    private static JsonObject Body(SeenRequest seen) => JsonNode.Parse(seen.Body!)!.AsObject();

    /// <summary>A page of <paramref name="rows"/> rows named from <paramref name="first"/> on, with <paramref name="token"/>.</summary>
    private static string Page(int first, int rows, string? token, long total)
    {
        var data = new JsonArray([.. Enumerable.Range(first, rows).Select(i => (JsonNode)new JsonObject { ["name"] = $"r{i}", ["n"] = i })]);
        var page = new JsonObject { ["totalRecords"] = total, ["count"] = rows, ["data"] = data, ["resultTruncated"] = "false" };
        if (token is not null)
        {
            page["$skipToken"] = token;
        }

        return page.ToJsonString();
    }

    /// <summary>Runs <paramref name="run"/>, advancing the fake clock a second at a time until it ends, so a wait or a timeout on
    /// the clock passes.</summary>
    private async Task<T> Advancing<T>(Func<Task<T>> run)
    {
        var task = run();
        for (var i = 0; i < 600 && !task.IsCompleted; i++)
        {
            await Task.Delay(5, Ct);
            _time.Advance(TimeSpan.FromSeconds(1));
        }

        return await task;
    }

    [Fact]
    public async Task Arg_posts_scope_and_options()
    {
        var arm = new StubGraph(_ => StubGraph.Json(HttpStatusCode.OK, StubGraph.Fixture("arg-page-2.json")));
        var source = Source(arm);

        await source.RunAsync(Request("Resources", new ArgScope(ArgScope.Subscriptions, [Sub1, Sub2])), null, Ct);
        await source.RunAsync(Request("Resources", new ArgScope(ArgScope.ManagementGroup, ["contoso-platform"])), null, Ct);
        await source.RunAsync(Request("Resources", ArgScope.Default), null, Ct);
        // No options: "all I can see".
        await source.RunAsync(Request("Resources"), null, Ct);

        Assert.Equal(4, arm.Seen.Count);
        foreach (var seen in arm.Seen)
        {
            Assert.Equal(HttpMethod.Post, seen.Method);
            Assert.Equal("https://management.azure.com/providers/Microsoft.ResourceGraph/resources?api-version=2024-04-01", seen.Uri!.AbsoluteUri);
            var options = Body(seen)["options"]!.AsObject();
            Assert.Equal(["$top", "$skip", "resultFormat"], options.Select(p => p.Key));
            Assert.Equal(1000, options["$top"]!.GetValue<int>());
            Assert.Equal(0, options["$skip"]!.GetValue<int>());
            Assert.Equal("objectArray", options["resultFormat"]!.GetValue<string>());
            Assert.Equal("Resources", Body(seen)["query"]!.GetValue<string>());
        }

        Assert.Equal(["query", "subscriptions", "options"], Body(arm.Seen[0]).Select(p => p.Key));
        Assert.Equal([Sub1, Sub2], Body(arm.Seen[0])["subscriptions"]!.AsArray().Select(n => n!.GetValue<string>()));
        Assert.Equal(["query", "managementGroups", "options"], Body(arm.Seen[1]).Select(p => p.Key));
        Assert.Equal(["contoso-platform"], Body(arm.Seen[1])["managementGroups"]!.AsArray().Select(n => n!.GetValue<string>()));
        Assert.Equal(["query", "options"], Body(arm.Seen[2]).Select(p => p.Key));
        Assert.Equal(["query", "options"], Body(arm.Seen[3]).Select(p => p.Key));
    }

    [Fact]
    public async Task Arg_follows_skip_tokens()
    {
        var pages = new Queue<string>([StubGraph.Fixture("arg-page-1.json"), StubGraph.Fixture("arg-page-2.json")]);
        var arm = new StubGraph(_ => StubGraph.Json(HttpStatusCode.OK, pages.Dequeue()));

        var result = await Source(arm).RunAsync(Request("Resources | project name, type, id, location"), null, Ct);

        Assert.Equal(RunOutcome.Ok, result.Outcome);
        Assert.Equal(2, arm.Seen.Count);
        var second = Body(arm.Seen[1]);
        Assert.Equal("eyAibm8iOiAibHVjayIsICJidXQiOiAibmljZSIsICJ0cnkiOiAiISIgfQ==", second["options"]!["$skipToken"]!.GetValue<string>());
        // $skip would override the token's offset (QueryRequestOptions), so a page after the first sends none.
        Assert.False(second["options"]!.AsObject().ContainsKey("$skip"));
        Assert.Equal(1000, second["options"]!["$top"]!.GetValue<int>());
        Assert.Equal("Resources | project name, type, id, location", second["query"]!.GetValue<string>());
        Assert.Equal([new EngineColumn("name", "string"), new("type", "string"), new("id", "string"), new("location", "string")], result.Columns);
        Assert.Equal(["disk-1", "automation-1", "runbook-1", "vault-1", "storage-1"], result.Rows.Select(r => r[0].GetString()));
        Assert.Equal(5, result.Total);
    }

    [Fact]
    public async Task Arg_stops_at_rows_limit_and_reports_total()
    {
        var calls = 0;
        var arm = new StubGraph(_ =>
        {
            calls++;
            return StubGraph.Json(HttpStatusCode.OK, Page((calls - 1) * 3, 3, $"token-{calls}", 4_200));
        });

        var result = await Source(arm, rowsPerRun: 5).RunAsync(Request("Resources"), null, Ct);

        Assert.Equal(RunOutcome.Ok, result.Outcome);
        Assert.Equal(2, arm.Seen.Count);
        Assert.Equal(["r0", "r1", "r2", "r3", "r4"], result.Rows.Select(r => r[0].GetString()));
        Assert.Equal(4_200, result.Total);
    }

    /// <summary>A page without <c>totalRecords</c>, as <see cref="Page"/> writes one otherwise.</summary>
    private static string PageWithoutTotal(int first, int rows, string? token, string truncated = "false")
    {
        var page = JsonNode.Parse(Page(first, rows, token, 0))!.AsObject();
        page.Remove("totalRecords");
        page["resultTruncated"] = truncated;
        return page.ToJsonString();
    }

    [Fact]
    public async Task Arg_total_without_total_records_is_the_rows_read()
    {
        var arm = new StubGraph(_ => StubGraph.Json(HttpStatusCode.OK, PageWithoutTotal(0, 3, null)));

        var result = await Source(arm).RunAsync(Request("Resources"), null, Ct);

        Assert.Equal((RunOutcome.Ok, 3, 3), (result.Outcome, result.Rows.Count, result.Total));
    }

    [Fact]
    public async Task Arg_total_without_total_records_counts_every_row_sent()
    {
        // The cap falls inside the second page: the rows past it were sent, so there are at least that many.
        var calls = 0;
        var arm = new StubGraph(_ =>
        {
            calls++;
            return StubGraph.Json(HttpStatusCode.OK, PageWithoutTotal((calls - 1) * 3, 3, calls == 1 ? "token-1" : null));
        });

        var result = await Source(arm, rowsPerRun: 5).RunAsync(Request("Resources"), null, Ct);

        Assert.Equal((5, 6), (result.Rows.Count, result.Total));
    }

    [Fact]
    public async Task Arg_total_without_total_records_is_more_than_the_rows_read_when_a_token_is_pending()
    {
        var calls = 0;
        var arm = new StubGraph(_ =>
        {
            calls++;
            return StubGraph.Json(HttpStatusCode.OK, PageWithoutTotal((calls - 1) * 3, 3, $"token-{calls}"));
        });

        var result = await Source(arm, rowsPerRun: 6).RunAsync(Request("Resources"), null, Ct);

        Assert.Equal(2, arm.Seen.Count);
        Assert.Equal((6, 7), (result.Rows.Count, result.Total));
    }

    [Fact]
    public async Task Arg_total_keeps_an_earlier_pages_total_records()
    {
        var pages = new Queue<string>([Page(0, 3, "token-1", 4_200), PageWithoutTotal(3, 3, null)]);
        var arm = new StubGraph(_ => StubGraph.Json(HttpStatusCode.OK, pages.Dequeue()));

        var result = await Source(arm).RunAsync(Request("Resources"), null, Ct);

        Assert.Equal((6, 4_200), (result.Rows.Count, result.Total));
    }

    [Fact]
    public async Task Arg_truncated_result_without_a_token_says_so()
    {
        var arm = new StubGraph(_ => StubGraph.Json(HttpStatusCode.OK, PageWithoutTotal(0, 3, null, truncated: "true")));
        var paged = new StubGraph(_ => StubGraph.Json(HttpStatusCode.OK, PageWithoutTotal(0, 3, "token-1", truncated: "true")));

        var result = await Source(arm).RunAsync(Request("Resources | project name"), null, Ct);
        var withToken = await Source(paged, rowsPerRun: 3).RunAsync(Request("Resources"), null, Ct);

        Assert.Equal(RunOutcome.Ok, result.Outcome);
        Assert.Equal(3, result.Rows.Count);
        Assert.Equal("Resource Graph cut this result short; include the id column to page through all rows.", result.Message);
        // A token to follow: nothing was cut that paging can't reach.
        Assert.Null(withToken.Message);
    }

    [Fact]
    public async Task Arg_429_with_a_date_retry_after_counts_from_the_clock()
    {
        var arm = new StubGraph(_ =>
        {
            var response = StubGraph.Json(HttpStatusCode.TooManyRequests, StubGraph.Fixture("arg-429.json"));
            response.Headers.RetryAfter = new RetryConditionHeaderValue(_time.GetUtcNow().AddSeconds(20));
            return response;
        });

        var result = await Advancing(() => Source(arm).RunAsync(Request("Resources"), null, Ct));

        Assert.Equal(RunOutcome.Throttled, result.Outcome);
        Assert.Contains("Try again in 20 s.", result.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Arg_skip_token_repeating_is_refused()
    {
        var calls = 0;
        var arm = new StubGraph(_ => StubGraph.Json(HttpStatusCode.OK, Page(calls++, 1, "same-token", 100)));

        var result = await Source(arm).RunAsync(Request("Resources"), null, Ct);

        Assert.Equal((RunOutcome.Failed, "Azure Resource Graph returned the same page twice."), (result.Outcome, result.Message));
        Assert.Equal(2, arm.Seen.Count);
    }

    [Fact]
    public async Task Arg_more_than_1000_pages_is_refused()
    {
        var calls = 0;
        var arm = new StubGraph(_ =>
        {
            calls++;
            return StubGraph.Json(HttpStatusCode.OK, Page(calls, 1, $"token-{calls}", 5_000));
        });

        var result = await Source(arm, rowsPerRun: 1_000_000).RunAsync(Request("Resources"), null, Ct);

        Assert.Equal((RunOutcome.Failed, "Azure Resource Graph sent more than 1,000 pages. Narrow the query."), (result.Outcome, result.Message));
        Assert.Equal(1_000, arm.Seen.Count);
    }

    [Fact]
    public async Task Arg_429_waits_retry_after_once_then_throttled()
    {
        HttpResponseMessage Throttled(int retryAfterSeconds)
        {
            var response = StubGraph.Json(HttpStatusCode.TooManyRequests, StubGraph.Fixture("arg-429.json"));
            response.Headers.RetryAfter = new RetryConditionHeaderValue(TimeSpan.FromSeconds(retryAfterSeconds));
            response.Headers.Add("x-ms-user-quota-remaining", "0");
            response.Headers.Add("x-ms-user-quota-resets-after", "00:00:05");
            return response;
        }

        // A 429, then an answer: the run waits once and goes on.
        var answers = new Queue<HttpResponseMessage>([Throttled(2), StubGraph.Json(HttpStatusCode.OK, StubGraph.Fixture("arg-page-2.json"))]);
        var recovering = new StubGraph(_ => answers.Dequeue());
        var started = _time.GetUtcNow();
        var recovered = await Advancing(() => Source(recovering).RunAsync(Request("Resources"), null, Ct));

        Assert.Equal(RunOutcome.Ok, recovered.Outcome);
        Assert.Equal(2, recovering.Seen.Count);
        Assert.InRange(_time.GetUtcNow() - started, TimeSpan.FromSeconds(2), TimeSpan.FromSeconds(10));
        var throttledEntry = Assert.Single(recovered.Diagnostics, e => e.Kind == DiagnosticKinds.Throttled);
        Assert.Contains("quota left 0", throttledEntry.Detail, StringComparison.Ordinal);
        Assert.Contains("resets after 00:00:05", throttledEntry.Detail, StringComparison.Ordinal);
        Assert.Contains(recovered.Diagnostics, e => e.Kind == DiagnosticKinds.Retry);

        // A 429 twice: the second answers Throttled, with ARG's explanation, when to retry and the quota.
        var always = new StubGraph(_ => Throttled(2));
        var throttled = await Advancing(() => Source(always).RunAsync(Request("Resources"), null, Ct));

        Assert.Equal(RunOutcome.Throttled, throttled.Outcome);
        Assert.Equal(2, always.Seen.Count);
        Assert.Equal("Client application has been throttled and should not attempt to repeat the request until an amount of time has "
            + "elapsed. Try again in 2 s. Resource Graph quota left: 0, resets after 00:00:05.", throttled.Message);

        // A long Retry-After is waited at most 30 s.
        var waitedFrom = _time.GetUtcNow();
        var longWait = new StubGraph(_ => Throttled(600));
        var capped = await Advancing(() => Source(longWait).RunAsync(Request("Resources"), null, Ct));

        Assert.Equal(RunOutcome.Throttled, capped.Outcome);
        Assert.InRange(_time.GetUtcNow() - waitedFrom, TimeSpan.FromSeconds(30), TimeSpan.FromSeconds(40));
        Assert.Contains("Try again in 600 s.", capped.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Arg_error_details_give_position()
    {
        var body = StubGraph.Fixture("arg-400-parser.json").Replace("{line}", "1", StringComparison.Ordinal)
            .Replace("{position}", "12", StringComparison.Ordinal);
        var arm = new StubGraph(_ => StubGraph.Json(HttpStatusCode.BadRequest, body));

        var result = await Source(arm).RunAsync(Request("Resources | whre name == 'x'"), null, Ct);

        Assert.Equal(RunOutcome.QueryError, result.Outcome);
        Assert.Equal("Query is invalid. Please refer to the documentation for the Azure Resource Graph service and fix the error before "
            + "retrying. ParserFailure at 'whre'.", result.Message);
        Assert.NotNull(result.Error);
        // characterPositionInLine is 0-based: 12 is the 13th character, where "whre" starts.
        Assert.Equal((1, 13), (result.Error.Line, result.Error.Column));
        Assert.Equal(result.Message, result.Error.Message);
    }

    [Fact]
    public async Task Arg_error_without_details_has_the_message_and_no_position()
    {
        var arm = new StubGraph(_ => StubGraph.Json(HttpStatusCode.BadRequest,
            """{"error":{"code":"BadRequest","message":"The request content was invalid."}}"""));

        var result = await Source(arm).RunAsync(Request("Resources"), null, Ct);

        Assert.Equal((RunOutcome.QueryError, "The request content was invalid."), (result.Outcome, result.Message));
        Assert.Null(result.Error);
    }

    [Fact]
    public async Task Arg_error_position_maps_back_through_parameters()
    {
        const string Kql = "Resources | where name == {name} | whre x";
        const string Value = "a much longer resource name";
        var substituted = Kql.Replace("{name}", "\"" + Value + "\"", StringComparison.Ordinal);
        var serverPosition = substituted.IndexOf("whre", StringComparison.Ordinal);
        var body = StubGraph.Fixture("arg-400-parser.json").Replace("{line}", "1", StringComparison.Ordinal)
            .Replace("{position}", serverPosition.ToString(CultureInfo.InvariantCulture), StringComparison.Ordinal);
        var arm = new StubGraph(_ => StubGraph.Json(HttpStatusCode.BadRequest, body));

        var result = await Source(arm).RunAsync(Request(Kql, parameters: [new ParameterValue("name", "text", Value, true)]), null, Ct);

        Assert.Equal(substituted, Body(arm.Seen[0])["query"]!.GetValue<string>());
        Assert.Equal(RunOutcome.QueryError, result.Outcome);
        Assert.NotNull(result.Error);
        Assert.Equal((1, Kql.IndexOf("whre", StringComparison.Ordinal) + 1), (result.Error.Line, result.Error.Column));
    }

    [Fact]
    public async Task Arg_missing_parameter_is_a_query_error_without_a_request()
    {
        var arm = new StubGraph(_ => StubGraph.Json(HttpStatusCode.OK, StubGraph.Fixture("arg-page-2.json")));

        var result = await Source(arm).RunAsync(Request("Resources | where name == {n}", parameters: [new ParameterValue("n", "text", "", true)]),
            null, Ct);

        Assert.Equal((RunOutcome.QueryError, "Fill in n before running."), (result.Outcome, result.Message));
        Assert.Empty(arm.Seen);
    }

    [Fact]
    public async Task Arg_403_has_copy()
    {
        var arm = new StubGraph(_ => StubGraph.Json(HttpStatusCode.Forbidden, StubGraph.Fixture("arg-403.json")));

        var result = await Source(arm).RunAsync(Request("Resources", new ArgScope(ArgScope.Subscriptions, [Sub1])), null, Ct);

        Assert.Equal((RunOutcome.NoPermission, "You don't have access to Azure Resource Graph in this scope."), (result.Outcome, result.Message));
    }

    [Fact]
    public async Task Arg_consent_needed_propagates()
    {
        var arm = new StubGraph(_ => throw new ConsentRequiredException("arm"));

        var ex = await Assert.ThrowsAsync<ConsentRequiredException>(() => Source(arm).RunAsync(Request("Resources"), null, Ct));

        Assert.Equal("arm", ex.Audience);
    }

    [Fact]
    public async Task Arg_sign_in_needed_from_arm_is_an_outcome()
    {
        var fromHandler = new StubGraph(_ => throw new SignInRequiredException("The Azure request names no account."));
        var rejected = new StubGraph(_ =>
        {
            var response = StubGraph.Json(HttpStatusCode.Unauthorized,
                """{"error":{"code":"ExpiredAuthenticationToken","message":"The access token expiry UTC time is earlier than current UTC time."}}""");
            response.Headers.WwwAuthenticate.ParseAdd("Bearer error=\"invalid_token\", error_description=\"The access token is expired.\"");
            return response;
        });

        var first = await Source(fromHandler).RunAsync(Request("Resources"), null, Ct);
        var second = await Source(rejected).RunAsync(Request("Resources"), null, Ct);

        Assert.Equal((RunOutcome.SignInNeeded, GraphRunner.SignInMessage), (first.Outcome, first.Message));
        Assert.Equal((RunOutcome.SignInNeeded, GraphRunner.SignInMessage), (second.Outcome, second.Message));
    }

    [Fact]
    public async Task Arg_other_status_and_transport_failure_are_failed()
    {
        var badGateway = new StubGraph(_ => new HttpResponseMessage(HttpStatusCode.BadGateway)
        {
            Content = new StringContent("<html><head><title>502 Bad Gateway</title></head></html>"),
        });
        var reset = new StubGraph(_ => throw new HttpRequestException("connection reset"));

        var html = await Source(badGateway).RunAsync(Request("Resources"), null, Ct);
        var transport = await Source(reset).RunAsync(Request("Resources"), null, Ct);

        Assert.Equal((RunOutcome.Failed, "502 from Azure's backend: 502 Bad Gateway"), (html.Outcome, html.Message));
        Assert.Equal((RunOutcome.Failed, "Azure Resource Graph couldn't be reached. Check the connection and try again."),
            (transport.Outcome, transport.Message));
    }

    [Fact]
    public async Task Arg_body_read_times_out()
    {
        var arm = new StubGraph(_ => new HttpResponseMessage(HttpStatusCode.OK) { Content = new StreamContent(new StallingStream()) });

        var result = await Advancing(() => Source(arm).RunAsync(Request("Resources"), null, Ct));

        Assert.Equal((RunOutcome.Failed, "Azure Resource Graph didn't answer within 60 s. Narrow the query and try again."),
            (result.Outcome, result.Message));
    }

    [Fact]
    public async Task Arg_cancel_throws()
    {
        using var cts = new CancellationTokenSource();
        await cts.CancelAsync();
        var arm = new StubGraph(_ => StubGraph.Json(HttpStatusCode.OK, StubGraph.Fixture("arg-page-2.json")));

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => Source(arm).RunAsync(Request("Resources"), null, cts.Token));
    }

    [Fact]
    public async Task Arm_requests_carry_account_and_run_diagnostics()
    {
        var pages = new Queue<string>([StubGraph.Fixture("arg-page-1.json"), StubGraph.Fixture("arg-page-2.json")]);
        var arm = new StubGraph(_ => StubGraph.Json(HttpStatusCode.OK, pages.Dequeue()));
        var events = new List<RunEvent>();

        var result = await Source(arm).RunAsync(Request("Resources"), new SyncProgress(events.Add), Ct);

        Assert.Equal(2, arm.Seen.Count);
        foreach (var seen in arm.Seen)
        {
            Assert.Equal(Account, seen.Options.TryGetValue(GraphRequestAccount.Key, out var account) ? account : null);
            Assert.True(seen.Options.TryGetValue(RunDiagnostics.Key, out var diagnostics));
            Assert.Equal(RunId, diagnostics.RunId);
        }

        Assert.Equal(RunId, result.RunId);
        Assert.Equal(["requesting", "paging", "done"], events.Select(e => e.Stage));
        Assert.All(events, e => Assert.Equal(RunId, e.RunId));
    }

    private sealed class SyncProgress(Action<RunEvent> report) : IProgress<RunEvent>
    {
        public void Report(RunEvent value) => report(value);
    }
}
