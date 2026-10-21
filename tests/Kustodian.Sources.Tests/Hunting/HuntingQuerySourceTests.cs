using System.Globalization;
using System.Net;
using System.Text.Json;
using Kustodian.Graph.Engine;
using Kustodian.Graph.Fetch;
using Kustodian.Graph.Query;
using Kustodian.Graph.Run;
using Kustodian.Sources.Hunting;
using Microsoft.Extensions.Time.Testing;

namespace Kustodian.Sources.Tests.Hunting;

public class HuntingQuerySourceTests
{
    private const string Account = "account-1";
    private const string RunId = "6f9619ff-8b86-d011-b42d-00c04fc964ff";
    private readonly FakeTimeProvider _time = new(new DateTimeOffset(2026, 10, 21, 8, 0, 0, TimeSpan.Zero));

    private HuntingQuerySource Source(StubGraph graph) => new(new HuntingClient(graph.Client()), _time);

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
        Assert.Equal((line, column), HuntingClient.Position(message));
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
}
