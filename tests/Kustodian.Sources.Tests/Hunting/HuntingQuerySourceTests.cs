using System.Globalization;
using System.Net;
using System.Text.Json;
using Kustodian.Graph.Engine;
using Kustodian.Graph.Fetch;
using Kustodian.Graph.Query;
using Kustodian.Graph.Run;
using Kustodian.Sources.Arg;
using Kustodian.Sources.Hunting;
using Microsoft.Extensions.Time.Testing;

namespace Kustodian.Sources.Tests.Hunting;

public class HuntingQuerySourceTests
{
    private const string Account = "account-1";
    private const string RunId = "6f9619ff-8b86-d011-b42d-00c04fc964ff";
    private readonly FakeTimeProvider _time = new(new DateTimeOffset(2026, 10, 21, 8, 0, 0, TimeSpan.Zero));

    private const string Guid1 = "0f5c1c3e-8f3c-4c52-9d3b-5f0a1c2d3e4f";
    private const string Guid2 = "1a2b3c4d-1111-4222-8333-444455556666";
    private const string Other = "9e9e9e9e-9999-4999-8999-999999999999";

    private static readonly QueryWorkspace Sentinel = new(Guid1.ToUpperInvariant(), "contoso-sentinel", "/subscriptions/s/x");

    private static string WorkspaceList(params string[] customerIds) =>
        "{\"totalRecords\":" + customerIds.Length + ",\"data\":[" + string.Join(",", customerIds.Select(c =>
            $"{{\"name\":\"contoso-sentinel\",\"resourceId\":\"/r/{c}\",\"customerId\":\"{c}\",\"resourceGroup\":\"rg\",\"subscriptionId\":\"s\",\"location\":\"l\"}}")) + "]}";

    /// <summary>An ARM stub that fails the test when asked: the run needs no workspace list.</summary>
    private static readonly StubGraph NoArm = new(_ => throw new InvalidOperationException("ARM was called"));

    private HuntingQuerySource Source(StubGraph graph, StubGraph? arm = null) =>
        new(new HuntingClient(graph.Client(), _time), new ArmDirectory((arm ?? NoArm).Client(), _time), _time);

    private static QueryOptions OnWorkspace(string timespan = "P90D") => new(timespan, null, [Sentinel]);

    private static QueryRunRequest Request(string kql, QueryOptions? options = null, IReadOnlyList<ParameterValue>? parameters = null) =>
        new(Account, kql, parameters ?? [], false, RunId, options);

    private static StubGraph Answering(HttpStatusCode status, string fixture) =>
        new(_ => StubGraph.Json(status, StubGraph.Fixture(fixture)));

    [Fact]
    public async Task Hunting_posts_query_and_timespan_to_v1()
    {
        var graph = Answering(HttpStatusCode.OK, "hunting-run-200.json");
        var source = Source(graph);

        await source.RunAsync(Request("DeviceProcessEvents | take 2", new QueryOptions("P7D", null)), null, TestContext.Current.CancellationToken);
        await source.RunAsync(Request("DeviceProcessEvents | take 2"), null, TestContext.Current.CancellationToken);

        Assert.Equal(2, graph.Seen.Count);
        foreach (var seen in graph.Seen)
        {
            Assert.Equal(HttpMethod.Post, seen.Method);
            Assert.Equal("https://graph.microsoft.com/v1.0/security/runHuntingQuery", seen.Uri!.AbsoluteUri);
        }

        using var first = JsonDocument.Parse(graph.Seen[0].Body!);
        Assert.Equal(["Query", "Timespan"], first.RootElement.EnumerateObject().Select(p => p.Name));
        Assert.Equal("DeviceProcessEvents | take 2", first.RootElement.GetProperty("Query").GetString());
        Assert.Equal("P7D", first.RootElement.GetProperty("Timespan").GetString());
        // No options: advanced hunting's own 30 days.
        using var second = JsonDocument.Parse(graph.Seen[1].Body!);
        Assert.Equal("P30D", second.RootElement.GetProperty("Timespan").GetString());
    }

    [Theory]
    [InlineData("hunting-run-200.json", "2024-03-26T09:39:50.7688641Z", "cmd.exe")]
    [InlineData("hunting-run-200-camel.json", "2020-08-30T06:38:35.7664356Z", "conhost.exe")]
    public async Task Hunting_maps_columns_and_rows_positionally(string fixture, string firstTimestamp, string firstFile)
    {
        var result = await Source(Answering(HttpStatusCode.OK, fixture))
            .RunAsync(Request("DeviceProcessEvents | take 2"), null, TestContext.Current.CancellationToken);

        Assert.Equal(RunOutcome.Ok, result.Outcome);
        Assert.Equal([new EngineColumn("Timestamp", "datetime"), new("FileName", "string"), new("InitiatingProcessFileName", "string")],
            result.Columns);
        Assert.Equal(2, result.Rows.Count);
        Assert.Equal(2, result.Total);
        Assert.Equal([firstTimestamp, firstFile, "powershell.exe"], result.Rows[0].Select(v => v.GetString()));
        Assert.Empty(result.Tables);
    }

    [Fact]
    public async Task Hunting_rows_with_unknown_keys_fall_back_to_position()
    {
        var graph = new StubGraph(_ => StubGraph.Json(HttpStatusCode.OK, """
            {"schema":[{"name":"A","type":"Int64"},{"name":"B","type":"String"}],"results":[{"x":1,"y":"one"},{"A":2,"B":"two"}]}
            """));

        var result = await Source(graph).RunAsync(Request("T"), null, TestContext.Current.CancellationToken);

        Assert.Equal([new EngineColumn("A", "long"), new("B", "string")], result.Columns);
        Assert.Equal(["1", "\"one\""], result.Rows[0].Select(v => v.GetRawText()));
        Assert.Equal(["2", "\"two\""], result.Rows[1].Select(v => v.GetRawText()));
    }

    [Fact]
    public async Task Hunting_403_has_permission_copy()
    {
        var result = await Source(Answering(HttpStatusCode.Forbidden, "hunting-run-403.json"))
            .RunAsync(Request("DeviceProcessEvents"), null, TestContext.Current.CancellationToken);

        Assert.Equal(RunOutcome.NoPermission, result.Outcome);
        Assert.Equal("Advanced hunting needs the ThreatHunting.Read.All permission and a Defender role (for example Security Reader). "
            + "With the Azure CLI client this permission may not be available: use your own app registration.", result.Message);
        Assert.Equal(["ThreatHunting.Read.All"], result.Permissions);
    }

    [Fact]
    public async Task Hunting_429_explains_limit_and_retry()
    {
        var body = StubGraph.Fixture("hunting-run-429.json");
        var graph = new StubGraph(_ =>
        {
            var response = StubGraph.Json(HttpStatusCode.TooManyRequests, body);
            response.Headers.RetryAfter = new System.Net.Http.Headers.RetryConditionHeaderValue(TimeSpan.FromSeconds(720));
            return response;
        });

        var result = await Source(graph).RunAsync(Request("DeviceProcessEvents"), null, TestContext.Current.CancellationToken);

        Assert.Equal(RunOutcome.Throttled, result.Outcome);
        Assert.Equal("You have exceeded processing resources allocated to this tenant. You can run queries again in 00:12:00. "
            + "Try again in 720 s.", result.Message);
        Assert.Contains(result.Diagnostics, e => e.Kind == DiagnosticKinds.Throttled);
    }

    [Fact]
    public async Task Hunting_429_with_a_date_retry_after_counts_from_the_clock()
    {
        var body = StubGraph.Fixture("hunting-run-429.json");
        var graph = new StubGraph(_ =>
        {
            var response = StubGraph.Json(HttpStatusCode.TooManyRequests, body);
            response.Headers.RetryAfter = new System.Net.Http.Headers.RetryConditionHeaderValue(_time.GetUtcNow().AddSeconds(90));
            return response;
        });

        var result = await Source(graph).RunAsync(Request("DeviceProcessEvents"), null, TestContext.Current.CancellationToken);

        Assert.Equal(RunOutcome.Throttled, result.Outcome);
        Assert.EndsWith("Try again in 90 s.", result.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Hunting_body_read_times_out()
    {
        var graph = new StubGraph(_ => new HttpResponseMessage(HttpStatusCode.OK) { Content = new StreamContent(new StallingStream()) });

        var run = Source(graph).RunAsync(Request("DeviceProcessEvents"), null, TestContext.Current.CancellationToken);
        for (var i = 0; i < 600 && !run.IsCompleted; i++)
        {
            await Task.Delay(5, TestContext.Current.CancellationToken);
            _time.Advance(TimeSpan.FromSeconds(1));
        }

        var result = await run;
        Assert.Equal((RunOutcome.Failed, "Microsoft Defender didn't answer within 240 s. Narrow the query or the timespan and try again."),
            (result.Outcome, result.Message));
    }

    [Fact]
    public async Task Hunting_429_without_retry_after_has_the_explanation_only()
    {
        var result = await Source(Answering(HttpStatusCode.TooManyRequests, "hunting-run-429.json"))
            .RunAsync(Request("DeviceProcessEvents"), null, TestContext.Current.CancellationToken);

        Assert.Equal(RunOutcome.Throttled, result.Outcome);
        Assert.Equal("You have exceeded processing resources allocated to this tenant. You can run queries again in 00:12:00.", result.Message);
    }

    [Fact]
    public async Task Hunting_body_over_50mb_is_too_large()
    {
        const string TooLarge = "The result is over Microsoft's 50 MB limit. Add summarize, project or take.";
        var endless = new EndlessStream();
        var streamed = new StubGraph(_ => new HttpResponseMessage(HttpStatusCode.OK) { Content = new StreamContent(endless) });
        var declared = new StubGraph(_ =>
        {
            var response = new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent([]) };
            response.Content.Headers.ContentLength = HuntingClient.MaxResponseBytes + 1;
            return response;
        });

        var fromStream = await Source(streamed).RunAsync(Request("T"), null, TestContext.Current.CancellationToken);
        var fromLength = await Source(declared).RunAsync(Request("T"), null, TestContext.Current.CancellationToken);

        Assert.Equal(50L * 1024 * 1024, HuntingClient.MaxResponseBytes);
        Assert.Equal((RunOutcome.TooLarge, TooLarge), (fromStream.Outcome, fromStream.Message));
        Assert.Equal((RunOutcome.TooLarge, TooLarge), (fromLength.Outcome, fromLength.Message));
        // Reading stopped at the cap: the body was never held whole.
        Assert.InRange(endless.BytesRead, HuntingClient.MaxResponseBytes, HuntingClient.MaxResponseBytes + (1 << 20));
    }

    [Fact]
    public async Task Hunting_error_position_maps_back_through_parameters()
    {
        const string Kql = "DeviceProcessEvents | where DeviceName == {device} | whre x";
        const string Value = "a much longer device name";
        var substituted = Kql.Replace("{device}", "\"" + Value + "\"", StringComparison.Ordinal);
        var serverColumn = substituted.IndexOf("whre", StringComparison.Ordinal) + 1;
        var body = StubGraph.Fixture("hunting-run-400.json").Replace("{line}", "1", StringComparison.Ordinal)
            .Replace("{column}", serverColumn.ToString(CultureInfo.InvariantCulture), StringComparison.Ordinal);
        var graph = new StubGraph(_ => StubGraph.Json(HttpStatusCode.BadRequest, body));

        var result = await Source(graph).RunAsync(Request(Kql, parameters: [new ParameterValue("device", "text", Value, true)]), null,
            TestContext.Current.CancellationToken);

        using var sent = JsonDocument.Parse(graph.Seen[0].Body!);
        Assert.Equal(substituted, sent.RootElement.GetProperty("Query").GetString());
        Assert.Equal(RunOutcome.QueryError, result.Outcome);
        Assert.Equal($"Syntax error: Query could not be parsed at 'whre' on line [1,{serverColumn}]", result.Message);
        Assert.NotNull(result.Error);
        Assert.Equal((1, Kql.IndexOf("whre", StringComparison.Ordinal) + 1), (result.Error.Line, result.Error.Column));
    }

    [Theory]
    [InlineData("Query could not be parsed at 'x' on line [3,7]", 3, 7)]
    [InlineData("Syntax error at line 2, column 5: unexpected token", 2, 5)]
    [InlineData("Unexpected token at line 4, position 9", 4, 9)]
    public void Hunting_error_positions_are_parsed(string message, int line, int column)
    {
        Assert.Equal((line, column), KustoPosition.Of(message));
    }

    [Fact]
    public async Task Hunting_400_without_a_position_has_none()
    {
        var graph = new StubGraph(_ => StubGraph.Json(HttpStatusCode.BadRequest,
            """{"error":{"code":"BadRequest","message":"'project' operator: Failed to resolve scalar expression named 'x'"}}"""));

        var result = await Source(graph).RunAsync(Request("T | project x"), null, TestContext.Current.CancellationToken);

        Assert.Equal(RunOutcome.QueryError, result.Outcome);
        Assert.Equal("'project' operator: Failed to resolve scalar expression named 'x'", result.Message);
        Assert.Null(result.Error);
    }

    [Fact]
    public async Task Hunting_missing_parameter_is_a_query_error_without_a_request()
    {
        var graph = Answering(HttpStatusCode.OK, "hunting-run-200.json");

        var result = await Source(graph).RunAsync(Request("T | where A == {a}", parameters: [new ParameterValue("a", "text", "", true)]),
            null, TestContext.Current.CancellationToken);

        Assert.Equal((RunOutcome.QueryError, "Fill in a before running."), (result.Outcome, result.Message));
        Assert.Empty(graph.Seen);
    }

    [Fact]
    public async Task Hunting_401_with_a_rejected_token_is_sign_in_needed()
    {
        var graph = new StubGraph(_ => StubGraph.Json(HttpStatusCode.Unauthorized,
            """{"error":{"code":"InvalidAuthenticationToken","message":"Lifetime validation failed, the token is expired."}}"""));

        var result = await Source(graph).RunAsync(Request("T"), null, TestContext.Current.CancellationToken);

        Assert.Equal((RunOutcome.SignInNeeded, GraphRunner.SignInMessage), (result.Outcome, result.Message));
    }

    [Fact]
    public async Task Hunting_sign_in_from_the_token_handler_is_sign_in_needed()
    {
        var graph = new StubGraph(_ => throw new SignInRequiredException("no token"));

        var result = await Source(graph).RunAsync(Request("T"), null, TestContext.Current.CancellationToken);

        Assert.Equal(RunOutcome.SignInNeeded, result.Outcome);
    }

    [Fact]
    public async Task Hunting_consent_required_propagates()
    {
        var graph = new StubGraph(_ => throw new ConsentRequiredException("graph"));

        await Assert.ThrowsAsync<ConsentRequiredException>(() =>
            Source(graph).RunAsync(Request("T"), null, TestContext.Current.CancellationToken));
    }

    [Fact]
    public async Task Hunting_other_status_is_failed_with_graphs_text()
    {
        var graph = new StubGraph(_ => new HttpResponseMessage(HttpStatusCode.BadGateway)
        {
            Content = new StringContent("<html><head><title>502 Bad Gateway</title></head></html>"),
        });

        var result = await Source(graph).RunAsync(Request("T"), null, TestContext.Current.CancellationToken);

        Assert.Equal((RunOutcome.Failed, "502 from Graph's backend: 502 Bad Gateway"), (result.Outcome, result.Message));
    }

    [Fact]
    public async Task Hunting_transport_failure_is_failed()
    {
        var graph = new StubGraph(_ => throw new HttpRequestException("connection reset"));

        var result = await Source(graph).RunAsync(Request("T"), null, TestContext.Current.CancellationToken);

        Assert.Equal(RunOutcome.Failed, result.Outcome);
    }

    [Fact]
    public async Task Unexpected_failure_sets_cause()
    {
        var ct = TestContext.Current.CancellationToken;
        var broken = await Source(new StubGraph(_ => throw new InvalidOperationException("broke"))).RunAsync(Request("T"), null, ct);
        var signIn = await Source(new StubGraph(_ => throw new SignInRequiredException("no token"))).RunAsync(Request("T"), null, ct);
        var transport = await Source(new StubGraph(_ => throw new HttpRequestException("reset"))).RunAsync(Request("T"), null, ct);

        Assert.Equal((RunOutcome.Failed, GraphRunner.Unexpected), (broken.Outcome, broken.Message));
        Assert.Equal("broke", Assert.IsType<InvalidOperationException>(broken.Cause).Message);
        Assert.Null(signIn.Cause);
        Assert.Null(transport.Cause);
    }

    [Fact]
    public async Task Hunting_cancel_throws()
    {
        using var cts = new CancellationTokenSource();
        await cts.CancelAsync();
        var graph = Answering(HttpStatusCode.OK, "hunting-run-200.json");

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => Source(graph).RunAsync(Request("T"), null, cts.Token));
    }

    [Fact]
    public async Task Hunting_requests_carry_account_and_run_diagnostics()
    {
        var graph = Answering(HttpStatusCode.OK, "hunting-run-200.json");
        var events = new List<RunEvent>();

        var result = await Source(graph).RunAsync(Request("T"), new SyncProgress(events.Add), TestContext.Current.CancellationToken);

        var seen = Assert.Single(graph.Seen);
        Assert.Equal(Account, seen.Options.TryGetValue(GraphRequestAccount.Key, out var account) ? account : null);
        Assert.True(seen.Options.TryGetValue(RunDiagnostics.Key, out var diagnostics));
        Assert.Equal(RunId, diagnostics.RunId);
        Assert.Equal(RunId, result.RunId);
        Assert.Equal(["requesting", "done"], events.Select(e => e.Stage));
        Assert.All(events, e => Assert.Equal(RunId, e.RunId));
    }

    private sealed class SyncProgress(Action<RunEvent> report) : IProgress<RunEvent>
    {
        public void Report(RunEvent value) => report(value);
    }

    /// <summary>A body that never ends, counting what was read from it.</summary>
    private sealed class EndlessStream : Stream
    {
        public long BytesRead { get; private set; }

        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => BytesRead; set => throw new NotSupportedException(); }

        public override int Read(byte[] buffer, int offset, int count)
        {
            Array.Fill(buffer, (byte)' ', offset, count);
            BytesRead += count;
            return count;
        }

        public override void Flush()
        {
        }

        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }

    [Fact]
    public async Task No_workspace_sends_todays_body()
    {
        var graph = Answering(HttpStatusCode.OK, "hunting-run-200.json");

        await Source(graph).RunAsync(Request("T", new QueryOptions("P30D", null)), null, TestContext.Current.CancellationToken);

        Assert.Equal("""{"Query":"T","Timespan":"P30D"}""", Assert.Single(graph.Seen).Body);
        Assert.Empty(NoArm.Seen);
    }

    [Fact]
    public async Task A_workspace_is_sent_as_workspaceId()
    {
        var graph = Answering(HttpStatusCode.OK, "hunting-run-200.json");
        var arm = new StubGraph(_ => StubGraph.Json(HttpStatusCode.OK, WorkspaceList(Guid1)));

        // The options carry the id in upper case, the list in lower: GUID text compares ignoring case.
        var result = await Source(graph, arm).RunAsync(Request("T", OnWorkspace()), null, TestContext.Current.CancellationToken);

        Assert.Equal(RunOutcome.Ok, result.Outcome);
        Assert.Equal($$"""{"Query":"T","Timespan":"P90D","workspaceId":"{{Guid1.ToUpperInvariant()}}"}""", Assert.Single(graph.Seen).Body);
    }

    [Fact]
    public async Task A_workspace_the_account_cant_see_is_not_run()
    {
        var graph = Answering(HttpStatusCode.OK, "hunting-run-200.json");
        var arm = new StubGraph(_ => StubGraph.Json(HttpStatusCode.OK, WorkspaceList(Guid2)));

        var result = await Source(graph, arm).RunAsync(Request("T", OnWorkspace()), null, TestContext.Current.CancellationToken);

        Assert.Equal(RunOutcome.WorkspaceUnavailable, result.Outcome);
        Assert.Equal("contoso-sentinel isn't available to this account. Pick a workspace.", result.Message);
        Assert.Empty(graph.Seen);
    }

    [Fact]
    public async Task Another_accounts_workspace_is_not_run()
    {
        var graph = Answering(HttpStatusCode.OK, "hunting-run-200.json");
        var arm = new StubGraph(r => StubGraph.Json(HttpStatusCode.OK,
            WorkspaceList(GraphRequestAccount.AccountOf(r) == "account-a" ? Guid1 : Guid2)));
        var source = Source(graph, arm);

        var asA = await source.RunAsync(Request("T", OnWorkspace()) with { AccountKey = "account-a" }, null, TestContext.Current.CancellationToken);
        var asB = await source.RunAsync(Request("T", OnWorkspace()) with { AccountKey = "account-b" }, null, TestContext.Current.CancellationToken);

        Assert.Equal(RunOutcome.Ok, asA.Outcome);
        Assert.Equal(RunOutcome.WorkspaceUnavailable, asB.Outcome);
        Assert.Single(graph.Seen);
    }

    [Fact]
    public async Task An_unreadable_list_blocks_the_run()
    {
        var graph = Answering(HttpStatusCode.OK, "hunting-run-200.json");
        var arm = new StubGraph(_ => throw new HttpRequestException("down"));

        var result = await Source(graph, arm).RunAsync(Request("T", OnWorkspace()), null, TestContext.Current.CancellationToken);

        Assert.Equal(RunOutcome.WorkspaceUnavailable, result.Outcome);
        Assert.Equal(ArgClient.Unreachable, result.Message);
        Assert.Empty(graph.Seen);
    }

    [Fact]
    public async Task A_consent_needed_list_propagates()
    {
        var graph = Answering(HttpStatusCode.OK, "hunting-run-200.json");
        var arm = new StubGraph(_ => throw new ConsentRequiredException("arm"));

        await Assert.ThrowsAsync<ConsentRequiredException>(() =>
            Source(graph, arm).RunAsync(Request("T", OnWorkspace()), null, TestContext.Current.CancellationToken));
        Assert.Empty(graph.Seen);
    }

    [Fact]
    public async Task A_sign_in_needed_list_is_sign_in_needed()
    {
        var graph = Answering(HttpStatusCode.OK, "hunting-run-200.json");
        var arm = new StubGraph(_ => throw new SignInRequiredException("again"));

        var result = await Source(graph, arm).RunAsync(Request("T", OnWorkspace()), null, TestContext.Current.CancellationToken);

        Assert.Equal(RunOutcome.SignInNeeded, result.Outcome);
        Assert.Empty(graph.Seen);
    }

    [Fact]
    public async Task A_workspace_run_notes_the_fallback()
    {
        var graph = Answering(HttpStatusCode.OK, "hunting-run-200.json");
        var arm = new StubGraph(_ => StubGraph.Json(HttpStatusCode.OK, WorkspaceList(Guid1)));

        var result = await Source(graph, arm).RunAsync(Request("T", OnWorkspace()), null, TestContext.Current.CancellationToken);

        Assert.Contains("If Defender can't reach contoso-sentinel, it answers from your primary workspace.",
            result.Diagnostics.Select(e => e.Detail));
    }

    [Fact]
    public async Task The_notes_name_the_workspace_the_account_lists_not_the_one_the_request_claims()
    {
        var graph = new StubGraph(_ => StubGraph.Json(HttpStatusCode.OK,
            $$"""{"schema":[{"name":"TenantId","type":"String"}],"results":[{"TenantId":"{{Other}}"}]}"""));
        var arm = new StubGraph(_ => StubGraph.Json(HttpStatusCode.OK, WorkspaceList(Guid1).Replace("contoso-sentinel", "account-name")));

        var result = await Source(graph, arm).RunAsync(Request("T", OnWorkspace()), null, TestContext.Current.CancellationToken);

        var details = result.Diagnostics.Select(e => e.Detail).ToList();
        Assert.Contains("If Defender can't reach account-name, it answers from your primary workspace.", details);
        Assert.Contains("Some rows came from another workspace than account-name: Defender may have answered from your primary workspace.", details);
        Assert.DoesNotContain(details, d => d!.Contains("contoso-sentinel"));
    }

    [Fact]
    public async Task A_blocked_workspace_with_no_name_is_called_by_its_short_id()
    {
        var arm = new StubGraph(_ => StubGraph.Json(HttpStatusCode.OK, WorkspaceList(Guid2)));
        var options = new QueryOptions("P90D", null, [new QueryWorkspace(Guid1, "", "/subscriptions/s/x")]);

        var result = await Source(Answering(HttpStatusCode.OK, "hunting-run-200.json"), arm).RunAsync(Request("T", options), null, TestContext.Current.CancellationToken);

        Assert.Equal("0f5c…3e4f isn't available to this account. Pick a workspace.", result.Message);
    }

    [Theory]
    [InlineData(Other, true)]
    [InlineData("", false)]
    [InlineData("0F5C1C3E-8F3C-4C52-9D3B-5F0A1C2D3E4F", false)]
    public async Task A_TenantId_that_differs_warns(string tenantId, bool warns)
    {
        var graph = new StubGraph(_ => StubGraph.Json(HttpStatusCode.OK,
            $$"""{"schema":[{"name":"TenantId","type":"String"}],"results":[{"TenantId":"{{Guid1}}"},{"TenantId":"{{tenantId}}"}]}"""));
        var arm = new StubGraph(_ => StubGraph.Json(HttpStatusCode.OK, WorkspaceList(Guid1)));

        var result = await Source(graph, arm).RunAsync(Request("T", OnWorkspace()), null, TestContext.Current.CancellationToken);

        Assert.Equal(warns, result.Diagnostics.Any(e => e.Kind == DiagnosticKinds.Warning && e.Detail ==
            "Some rows came from another workspace than contoso-sentinel: Defender may have answered from your primary workspace."));
    }

    [Fact]
    public async Task Without_a_TenantId_column_nothing_warns()
    {
        var arm = new StubGraph(_ => StubGraph.Json(HttpStatusCode.OK, WorkspaceList(Guid1)));

        var result = await Source(Answering(HttpStatusCode.OK, "hunting-run-200.json"), arm)
            .RunAsync(Request("T", OnWorkspace()), null, TestContext.Current.CancellationToken);

        Assert.DoesNotContain(result.Diagnostics, e => e.Kind == DiagnosticKinds.Warning);
    }

    [Fact]
    public async Task NoPermission_with_a_workspace_mentions_Sentinel_Reader()
    {
        var graph = new StubGraph(_ => StubGraph.Json(HttpStatusCode.Forbidden, "{}"));
        var arm = new StubGraph(_ => StubGraph.Json(HttpStatusCode.OK, WorkspaceList(Guid1)));

        var withWorkspace = await Source(graph, arm).RunAsync(Request("T", OnWorkspace()), null, TestContext.Current.CancellationToken);
        var without = await Source(graph).RunAsync(Request("T"), null, TestContext.Current.CancellationToken);

        Assert.Equal(RunOutcome.NoPermission, withWorkspace.Outcome);
        Assert.EndsWith(" With a workspace you also need Microsoft Sentinel Reader on it.", withWorkspace.Message);
        Assert.Equal(HuntingClient.NoPermission, without.Message);
    }
}
