using System.Net;
using System.Net.Http.Headers;
using System.Text.Json;
using Kustodian.Graph.Fetch;
using Kustodian.Graph.Run;
using Kustodian.Sources.Logs;
using Kustodian.Sources.Tests.Hunting;
using Microsoft.Extensions.Time.Testing;

namespace Kustodian.Sources.Tests.Logs;

// The fixtures logs-*.json are hand-written from the Azure Monitor Logs query API reference, not recorded from a service.
public class LogsClientTests
{
    private const string Account = "account-1";
    private const string Workspace = "0f5c1c3e-8f3c-4c52-9d3b-5f0a1c2d3e4f";
    private readonly FakeTimeProvider _time = new(new DateTimeOffset(2026, 11, 10, 8, 0, 0, TimeSpan.Zero));

    private LogsClient Client(StubGraph stub) =>
        new(new HttpClient(stub, disposeHandler: false) { BaseAddress = new Uri("https://api.loganalytics.azure.com/") }, _time);

    private RunDiagnostics Diagnostics() => new(_time);

    private Task<LogsAnswer> Run(StubGraph stub, string customerId = Workspace, string kql = "T", string timespan = "P1D") =>
        Client(stub).RunAsync(Account, customerId, kql, timespan, Diagnostics(), TestContext.Current.CancellationToken);

    private static StubGraph Answering(HttpStatusCode status, string fixture) =>
        new(_ => StubGraph.Json(status, StubGraph.Fixture(fixture)));

    [Fact]
    public async Task Posts_query_and_timespan_to_the_workspace()
    {
        var stub = Answering(HttpStatusCode.OK, "logs-query-200.json");

        await Run(stub);

        var seen = Assert.Single(stub.Seen);
        Assert.Equal(HttpMethod.Post, seen.Method);
        Assert.Equal($"https://api.loganalytics.azure.com/v1/workspaces/{Workspace}/query", seen.Uri!.AbsoluteUri);
        Assert.Equal("""{"query":"T","timespan":"P1D"}""", seen.Body);
    }

    [Fact]
    public async Task Asks_the_server_to_wait_ten_minutes()
    {
        string? prefer = null;
        var stub = new StubGraph(r =>
        {
            prefer = string.Join(",", r.Headers.GetValues("Prefer"));
            return StubGraph.Json(HttpStatusCode.OK, StubGraph.Fixture("logs-query-200.json"));
        });

        await Run(stub);

        Assert.Equal("wait=600", prefer);
    }

    [Theory]
    [InlineData("../x")]
    [InlineData("a/b")]
    [InlineData("")]
    public async Task A_customer_id_that_is_not_a_guid_is_refused_without_a_request(string customerId)
    {
        var stub = new StubGraph(_ => throw new InvalidOperationException("called"));

        var answer = await Run(stub, customerId);

        Assert.Equal(RunOutcome.Failed, answer.Outcome);
        Assert.Empty(stub.Seen);
    }

    [Fact]
    public async Task Reads_the_first_table()
    {
        var answer = await Run(Answering(HttpStatusCode.OK, "logs-query-200.json"));

        Assert.Equal(RunOutcome.Ok, answer.Outcome);
        Assert.Equal(["TimeGenerated:datetime", "Count:long"], answer.Columns.Select(c => $"{c.Name}:{c.Type}"));
        var row = Assert.Single(answer.Rows);
        Assert.Equal("2026-11-10T00:00:00Z", row[0].GetString());
        Assert.Equal(3, row[1].GetInt32());
    }

    [Fact]
    public async Task Prefers_PrimaryResult_and_pads_short_rows_with_null()
    {
        var stub = new StubGraph(_ => StubGraph.Json(HttpStatusCode.OK, """
            {"tables":[{"name":"Other","columns":[{"name":"A","type":"int"}],"rows":[[1]]},
             {"name":"PrimaryResult","columns":[{"name":"X","type":"string"},{"name":"Y","type":"string"}],"rows":[["a"]]}]}
            """));

        var answer = await Run(stub);

        Assert.Equal(["X", "Y"], answer.Columns.Select(c => c.Name));
        Assert.Equal(JsonValueKind.Null, Assert.Single(answer.Rows)[1].ValueKind);
    }

    [Fact]
    public async Task A_200_with_an_error_is_ok_with_PartialError()
    {
        var answer = await Run(Answering(HttpStatusCode.OK, "logs-query-200-partial.json"));

        Assert.Equal(RunOutcome.Ok, answer.Outcome);
        Assert.Single(answer.Rows);
        Assert.Equal("Query result exceeded the limit; the result is truncated.", answer.PartialError);
    }

    [Fact]
    public async Task A_204_is_empty()
    {
        var answer = await Run(new StubGraph(_ => new HttpResponseMessage(HttpStatusCode.NoContent)));

        Assert.Equal(RunOutcome.Ok, answer.Outcome);
        Assert.Empty(answer.Columns);
        Assert.Empty(answer.Rows);
    }

    [Fact]
    public async Task A_400_names_the_position()
    {
        var answer = await Run(Answering(HttpStatusCode.BadRequest, "logs-query-400.json"));

        Assert.Equal(RunOutcome.QueryError, answer.Outcome);
        Assert.Equal("Query could not be parsed at 'x' on line [2,5]", answer.Message);
        Assert.Equal((2, 5), (answer.Line, answer.Column));
    }

    [Fact]
    public async Task A_400_without_numeric_position_falls_back_to_the_message()
    {
        var stub = new StubGraph(_ => StubGraph.Json(HttpStatusCode.BadRequest,
            """{"error":{"code":"BadArgumentError","message":"Query could not be parsed at 'x' on line [3,7]"}}"""));

        var answer = await Run(stub);

        Assert.Equal((3, 7), (answer.Line, answer.Column));
    }

    [Fact]
    public async Task A_403_InsufficientAccessError_is_NoPermission()
    {
        var answer = await Run(Answering(HttpStatusCode.Forbidden, "logs-query-403.json"));

        Assert.Equal(RunOutcome.NoPermission, answer.Outcome);
        Assert.Equal("Log Analytics refused the query. You need Reader or Log Analytics Reader on the workspace, and the Data.Read permission.",
            answer.Message);
    }

    [Fact]
    public async Task A_403_with_another_code_is_NoPermission_with_the_same_message()
    {
        var stub = new StubGraph(_ => StubGraph.Json(HttpStatusCode.Forbidden, """{"error":{"code":"Whatever","message":"no"}}"""));

        var answer = await Run(stub);

        Assert.Equal((RunOutcome.NoPermission, LogsClient.NoPermission), (answer.Outcome, answer.Message));
    }

    [Theory]
    [InlineData(HttpStatusCode.Forbidden)]
    [InlineData(HttpStatusCode.Unauthorized)]
    public async Task A_rejected_token_throws_SignInRequired(HttpStatusCode status)
    {
        var stub = new StubGraph(_ => StubGraph.Json(status, """{"error":{"code":"InvalidAuthenticationToken","message":"expired"}}"""));

        await Assert.ThrowsAsync<SignInRequiredException>(() => Run(stub));
    }

    [Fact]
    public async Task A_401_without_an_error_body_throws_SignInRequired()
    {
        var stub = new StubGraph(_ => new HttpResponseMessage(HttpStatusCode.Unauthorized));

        await Assert.ThrowsAsync<SignInRequiredException>(() => Run(stub));
    }

    [Fact]
    public async Task Sign_in_and_consent_from_the_token_handler_propagate()
    {
        await Assert.ThrowsAsync<SignInRequiredException>(() => Run(new StubGraph(_ => throw new SignInRequiredException("no token"))));
        await Assert.ThrowsAsync<ConsentRequiredException>(() => Run(new StubGraph(_ => throw new ConsentRequiredException("logs"))));
    }

    [Fact]
    public async Task A_429_is_Throttled_with_Retry_After()
    {
        var d = Diagnostics();
        var stub = new StubGraph(_ =>
        {
            var response = StubGraph.Json(HttpStatusCode.TooManyRequests, """{"error":{"code":"ThrottledError","message":"Too many requests."}}""");
            response.Headers.RetryAfter = new RetryConditionHeaderValue(TimeSpan.FromSeconds(30));
            return response;
        });

        var answer = await Client(stub).RunAsync(Account, Workspace, "T", "P1D", d, TestContext.Current.CancellationToken);

        Assert.Equal(RunOutcome.Throttled, answer.Outcome);
        Assert.Equal("Too many requests. Try again in 30 s.", answer.Message);
        Assert.Contains(d.Entries, e => e.Kind == DiagnosticKinds.Throttled);
    }

    [Fact]
    public async Task A_504_says_the_query_took_too_long()
    {
        var answer = await Run(new StubGraph(_ => StubGraph.Json(HttpStatusCode.GatewayTimeout, "{}")));

        Assert.Equal((RunOutcome.Failed, "Log Analytics stopped the query after 10 minutes. Narrow the query or the timespan and try again."),
            (answer.Outcome, answer.Message));
    }

    [Fact]
    public async Task Over_64_MB_is_TooLarge()
    {
        var endless = new EndlessStream();
        var streamed = new StubGraph(_ => new HttpResponseMessage(HttpStatusCode.OK) { Content = new StreamContent(endless) });
        var declared = new StubGraph(_ =>
        {
            var response = new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent([]) };
            response.Content.Headers.ContentLength = LogsClient.MaxResponseBytes + 1;
            return response;
        });

        var fromStream = await Run(streamed);
        var fromLength = await Run(declared);

        Assert.Equal(64L * 1024 * 1024, LogsClient.MaxResponseBytes);
        Assert.Equal((RunOutcome.TooLarge, LogsClient.TooLarge), (fromStream.Outcome, fromStream.Message));
        Assert.Equal((RunOutcome.TooLarge, LogsClient.TooLarge), (fromLength.Outcome, fromLength.Message));
        Assert.Equal("The result is over Log Analytics' 64 MB limit. Add summarize, project or take.", LogsClient.TooLarge);
    }

    [Fact]
    public async Task A_timeout_is_Failed()
    {
        var stub = new StubGraph(_ => new HttpResponseMessage(HttpStatusCode.OK) { Content = new StreamContent(new StallingStream()) });

        var run = Run(stub);
        for (var i = 0; i < 800 && !run.IsCompleted; i++)
        {
            await Task.Delay(5, TestContext.Current.CancellationToken);
            _time.Advance(TimeSpan.FromSeconds(1));
        }

        var answer = await run;
        Assert.Equal(RunOutcome.Failed, answer.Outcome);
        Assert.Equal("Log Analytics didn't answer within 660 s. Narrow the query or the timespan and try again.", answer.Message);
        Assert.Equal(TimeSpan.FromMinutes(11), LogsClient.Timeout);
    }

    [Fact]
    public async Task A_lost_connection_is_Failed()
    {
        var answer = await Run(new StubGraph(_ => throw new HttpRequestException("reset")));

        Assert.Equal(RunOutcome.Failed, answer.Outcome);
    }

    [Fact]
    public async Task Cancelling_throws()
    {
        using var cts = new CancellationTokenSource();
        await cts.CancelAsync();
        var stub = Answering(HttpStatusCode.OK, "logs-query-200.json");

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            Client(stub).RunAsync(Account, Workspace, "T", "P1D", Diagnostics(), cts.Token));
    }

    [Theory]
    [InlineData("Query could not be parsed at 'x' on line [3,7]", 3, 7)]
    [InlineData("Syntax error at line 2, column 5: unexpected token", 2, 5)]
    [InlineData("Unexpected token at line 4, position 9", 4, 9)]
    public void Kusto_error_positions_are_parsed(string message, int line, int column)
    {
        Assert.Equal((line, column), KustoPosition.Of(message));
    }

    /// <summary>A body that never ends.</summary>
    private sealed class EndlessStream : Stream
    {
        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => 0; set => throw new NotSupportedException(); }

        public override int Read(byte[] buffer, int offset, int count)
        {
            Array.Fill(buffer, (byte)' ', offset, count);
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
