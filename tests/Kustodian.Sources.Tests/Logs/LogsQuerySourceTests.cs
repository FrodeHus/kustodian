using System.Net;
using System.Text.Json;
using Kustodian.Graph.Fetch;
using Kustodian.Graph.Query;
using Kustodian.Graph.Run;
using Kustodian.Sources.Arg;
using Kustodian.Sources.Logs;
using Kustodian.Sources.Tests.Hunting;
using Microsoft.Extensions.Time.Testing;

namespace Kustodian.Sources.Tests.Logs;

public class LogsQuerySourceTests
{
    private const string Account = "account-1";
    private const string RunId = "6f9619ff-8b86-d011-b42d-00c04fc964ff";
    private const string Guid1 = "0f5c1c3e-8f3c-4c52-9d3b-5f0a1c2d3e4f";
    private const string Guid2 = "1a2b3c4d-1111-4222-8333-444455556666";
    private readonly FakeTimeProvider _time = new(new DateTimeOffset(2026, 11, 10, 8, 0, 0, TimeSpan.Zero));

    private static readonly QueryWorkspace Sentinel = new(Guid1, "contoso-sentinel", "/subscriptions/s/x");

    private static string WorkspaceList(params string[] customerIds) =>
        "{\"totalRecords\":" + customerIds.Length + ",\"data\":[" + string.Join(",", customerIds.Select(c =>
            $"{{\"name\":\"contoso-sentinel\",\"resourceId\":\"/r/{c}\",\"customerId\":\"{c}\",\"resourceGroup\":\"rg\",\"subscriptionId\":\"s\",\"location\":\"l\"}}")) + "]}";

    private static StubGraph Visible(string id = Guid1) => new(_ => StubGraph.Json(HttpStatusCode.OK, WorkspaceList(id)));

    /// <summary>An ARM stub that fails the test when asked: a run with no workspace needs no list.</summary>
    private static readonly StubGraph NoArm = new(_ => throw new InvalidOperationException("ARM was called"));

    private static StubGraph Answering(HttpStatusCode status, string fixture) =>
        new(_ => StubGraph.Json(status, StubGraph.Fixture(fixture)));

    private LogsQuerySource Source(StubGraph logs, StubGraph? arm = null) =>
        new(new LogsClient(new HttpClient(logs, disposeHandler: false) { BaseAddress = new Uri("https://api.loganalytics.azure.com/") }, _time), new ArmDirectory((arm ?? NoArm).Client(), _time), _time);

    private static QueryOptions OnWorkspace(string? timespan = "P7D") => new(timespan, null, [Sentinel]);

    private static QueryRunRequest Request(string kql, QueryOptions? options = null, IReadOnlyList<ParameterValue>? parameters = null) =>
        new(Account, kql, parameters ?? [], false, RunId, options);

    private static Task<RunResult> Run(LogsQuerySource source, QueryRunRequest request, IProgress<RunEvent>? progress = null) =>
        source.RunAsync(request, progress, TestContext.Current.CancellationToken);

    private sealed class Events : IProgress<RunEvent>
    {
        public List<RunEvent> Seen { get; } = [];

        public void Report(RunEvent value) => Seen.Add(value);
    }

    [Fact]
    public async Task No_workspace_is_a_query_error()
    {
        var logs = Answering(HttpStatusCode.OK, "logs-query-200.json");

        var result = await Run(Source(logs), Request("T"));

        Assert.Equal(RunOutcome.QueryError, result.Outcome);
        Assert.Equal("Pick a workspace before running.", result.Message);
        Assert.Empty(logs.Seen);
    }

    [Fact]
    public async Task A_workspace_the_account_cant_see_is_not_run()
    {
        var logs = Answering(HttpStatusCode.OK, "logs-query-200.json");

        var result = await Run(Source(logs, Visible(Guid2)), Request("T", OnWorkspace()));

        Assert.Equal(RunOutcome.WorkspaceUnavailable, result.Outcome);
        Assert.Equal("contoso-sentinel isn't available to this account. Pick a workspace.", result.Message);
        Assert.Empty(logs.Seen);
    }

    [Fact]
    public async Task Another_accounts_workspace_is_not_run()
    {
        var logs = Answering(HttpStatusCode.OK, "logs-query-200.json");
        var arm = new StubGraph(r => StubGraph.Json(HttpStatusCode.OK,
            WorkspaceList(GraphRequestAccount.AccountOf(r) == "account-a" ? Guid1 : Guid2)));
        var source = Source(logs, arm);

        var asA = await Run(source, Request("T", OnWorkspace()) with { AccountKey = "account-a" });
        var asB = await Run(source, Request("T", OnWorkspace()) with { AccountKey = "account-b" });

        Assert.Equal(RunOutcome.Ok, asA.Outcome);
        Assert.Equal(RunOutcome.WorkspaceUnavailable, asB.Outcome);
        Assert.Single(logs.Seen);
    }

    [Fact]
    public async Task An_unreadable_list_blocks_the_run()
    {
        var logs = Answering(HttpStatusCode.OK, "logs-query-200.json");
        var arm = new StubGraph(_ => throw new HttpRequestException("down"));

        var result = await Run(Source(logs, arm), Request("T", OnWorkspace()));

        Assert.Equal(RunOutcome.WorkspaceUnavailable, result.Outcome);
        Assert.Equal(ArgClient.Unreachable, result.Message);
        Assert.Empty(logs.Seen);
    }

    [Theory]
    [InlineData("P7D", "P7D")]
    [InlineData(null, "P1D")]
    public async Task Runs_on_the_workspace_with_the_timespan(string? timespan, string sent)
    {
        var logs = Answering(HttpStatusCode.OK, "logs-query-200.json");
        var events = new Events();

        var result = await Run(Source(logs, Visible()), Request("T", OnWorkspace(timespan)), events);

        Assert.Equal(RunOutcome.Ok, result.Outcome);
        var seen = Assert.Single(logs.Seen);
        Assert.Equal($"https://api.loganalytics.azure.com/v1/workspaces/{Guid1}/query", seen.Uri!.AbsoluteUri);
        using var body = JsonDocument.Parse(seen.Body!);
        Assert.Equal(sent, body.RootElement.GetProperty("timespan").GetString());
        Assert.Equal(["Running the query in Log Analytics on contoso-sentinel", "Log Analytics answered"], events.Seen.Select(e => e.Detail));
    }

    [Fact]
    public async Task A_partial_error_is_a_warning()
    {
        var result = await Run(Source(Answering(HttpStatusCode.OK, "logs-query-200-partial.json"), Visible()), Request("T", OnWorkspace()));

        Assert.Equal(RunOutcome.Ok, result.Outcome);
        Assert.Contains(result.Diagnostics, e => e.Kind == DiagnosticKinds.Warning && e.Detail ==
            "Log Analytics returned part of the result: Query result exceeded the limit; the result is truncated.");
    }

    [Fact]
    public async Task A_query_error_position_maps_back()
    {
        const string Kql = "T | where Name == {device} | whre x";
        const string Value = "a much longer device name";
        var substituted = Kql.Replace("{device}", "\"" + Value + "\"", StringComparison.Ordinal);
        // The fixture's pos is 0-based; the client reports pos + 1.
        var body = StubGraph.Fixture("logs-query-400.json").Replace("\"line\":2,\"pos\":4",
            $"\"line\":1,\"pos\":{substituted.IndexOf("whre", StringComparison.Ordinal)}", StringComparison.Ordinal);
        var logs = new StubGraph(_ => StubGraph.Json(HttpStatusCode.BadRequest, body));

        var result = await Run(Source(logs, Visible()), Request(Kql, OnWorkspace(), [new ParameterValue("device", "text", Value, true)]));

        Assert.Equal(RunOutcome.QueryError, result.Outcome);
        Assert.Equal((1, Kql.IndexOf("whre", StringComparison.Ordinal) + 1), (result.Error!.Line, result.Error.Column));
    }

    [Fact]
    public async Task NoPermission_lists_Data_Read()
    {
        var result = await Run(Source(Answering(HttpStatusCode.Forbidden, "logs-query-403.json"), Visible()), Request("T", OnWorkspace()));

        Assert.Equal(RunOutcome.NoPermission, result.Outcome);
        Assert.Equal(["Data.Read"], result.Permissions);
    }

    [Fact]
    public async Task Consent_for_logs_propagates()
    {
        var logs = new StubGraph(_ => throw new ConsentRequiredException("logs"));

        var ex = await Assert.ThrowsAsync<ConsentRequiredException>(() => Run(Source(logs, Visible()), Request("T", OnWorkspace())));
        Assert.Equal("logs", ex.Audience);
    }
}
