using System.Text.Json;
using Kustodian.Graph.Engine;
using Kustodian.Graph.Fetch;
using Kustodian.Graph.Query;
using Kustodian.Graph.Run;
using Kustodian.Graph.Schema;
using Kustodian.Messaging;
using Kustodian.Messaging.Handlers;
using Kustodian.Telemetry;
using Kustodian.Tests.Telemetry;

namespace Kustodian.Tests.Bridge;

/// <summary>Every error the host answers with gets a report ID: the bridge's, and a run's that didn't end <c>ok</c>. Only the
/// unexpected ones send an automatic report, and that never holds their text.</summary>
public sealed class ErrorCaptureTests : IDisposable
{
    private const string Connection = "InstrumentationKey=key-1;IngestionEndpoint=https://ingest.example/";
    private const string Secret = "alice@contoso.com";
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private readonly Recorder _posted = new();
    private readonly HttpClient _http;
    private readonly ErrorTrail _trail = new(TimeProvider.System);
    private readonly ErrorReporter _reporter;

    public ErrorCaptureTests()
    {
        _http = new HttpClient(_posted);
        _reporter = new ErrorReporter(new AppInsightsTelemetry(_http, Connection, TimeProvider.System), _ => Task.FromResult(true),
            _trail, TimeProvider.System);
    }

    public void Dispose() => _http.Dispose();

    private Messaging.Bridge NewBridge(FakeRun? run = null)
    {
        var bridge = new Messaging.Bridge(_ => { }, null, _reporter, _trail);
        if (run is not null)
            new QueryHandler(GraphSchemaCatalog.Beta, () => Task.FromResult<string?>("acct-1"), FakeSource.Graph(run),
                reporter: _reporter, trail: _trail).Register(bridge);
        return bridge;
    }

    /// <summary>The automatic reports sent, once the started sends have run.</summary>
    private async Task<List<string>> PostedAsync()
    {
        await _reporter.FlushAsync(TimeSpan.FromSeconds(5));
        return [.. _posted.Bodies];
    }

    private static JsonElement Parse(string? json)
    {
        Assert.NotNull(json);
        using var doc = JsonDocument.Parse(json);
        return doc.RootElement.Clone();
    }

    private static FullReportSection Section(FullReport report, string key) => Assert.Single(report.Sections, s => s.Key == key);

    [Fact]
    public async Task Unexpected_handler_exception_is_reported_with_its_id()
    {
        var bridge = NewBridge();
        bridge.Register("boom", (_, _) => throw new InvalidOperationException($"Broke for {Secret}"));

        var error = Parse(await bridge.HandleAsync("""{"id":"1","method":"boom","params":{}}""")).GetProperty("error");

        Assert.Equal("failed", error.GetProperty("code").GetString());
        var id = error.GetProperty("reportId").GetString()!;
        Assert.Matches("^[0-9A-HJKMNP-TV-Z]{8}$", id);
        var report = Assert.IsType<FullReport>(_reporter.Details(id));
        Assert.Equal("bridge.failed", report.Kind);
        Assert.Equal("boom", Section(report, "method").Text);
        Assert.Contains(Secret, Section(report, "exception").Text, StringComparison.Ordinal);
        var posted = Assert.Single(await PostedAsync());
        Assert.Contains("bridge.failed", posted, StringComparison.Ordinal);
        Assert.DoesNotContain(Secret, posted, StringComparison.Ordinal);
    }

    [Fact]
    public async Task BridgeException_is_captured_as_expected()
    {
        var bridge = NewBridge();
        bridge.Register("refuse", (_, _) => throw new BridgeException(BridgeErrorCodes.BadRequest, "Not like that."));

        var error = Parse(await bridge.HandleAsync("""{"id":"1","method":"refuse","params":{}}""")).GetProperty("error");

        var report = Assert.IsType<FullReport>(_reporter.Details(error.GetProperty("reportId").GetString()!));
        Assert.Equal("bridge.refused.bad_request", report.Kind);
        Assert.Equal("Not like that.", Section(report, "message").Text);
        Assert.Contains("bridge.error(bad_request)", _trail.Render(), StringComparison.Ordinal);
        Assert.Empty(await PostedAsync());
    }

    [Fact]
    public async Task BridgeException_with_code_failed_is_expected_not_a_bug()
    {
        var bridge = NewBridge();
        bridge.Register("save", (_, _) => throw new BridgeException(BridgeErrorCodes.Failed, "The file couldn't be written."));

        var error = Parse(await bridge.HandleAsync("""{"id":"1","method":"save","params":{}}""")).GetProperty("error");

        Assert.Equal("failed", error.GetProperty("code").GetString());
        var report = Assert.IsType<FullReport>(_reporter.Details(error.GetProperty("reportId").GetString()!));
        Assert.Equal("bridge.refused.failed", report.Kind);
        Assert.Empty(await PostedAsync());
    }

    [Fact]
    public async Task Cancelled_gets_no_report_id()
    {
        var bridge = NewBridge();
        bridge.Register("stop", (_, _) => throw new OperationCanceledException());

        var error = Parse(await bridge.HandleAsync("""{"id":"1","method":"stop","params":{}}""")).GetProperty("error");

        Assert.Equal("cancelled", error.GetProperty("code").GetString());
        Assert.False(error.TryGetProperty("reportId", out _));
    }

    [Fact]
    public async Task Failed_run_gets_a_report_id()
    {
        var results = new Queue<RunResult>(
        [
            Result(RunOutcome.Ok),
            Result(RunOutcome.NoPermission, "You don't have permission to read groups.") with
            {
                ReadFailure = new RunReadFailure("groups", GraphReadFailure.NoPermission, 403, "Authorization_RequestDenied")
                {
                    Body = $$$"""{"error":{"code":"Authorization_RequestDenied","message":"Missing GroupMember.Read.All for {{{Secret}}}"}}""",
                },
                Tables = [new TableFetch("groups", ["groups?$select=id"], false, [], [], [], 0, false, 0)],
            },
            Result(RunOutcome.Failed, "The query engine stopped unexpectedly") with
            {
                Cause = new GraphEngineException(GraphEngineFailure.Crashed)
                {
                    ExitCode = 134,
                    StderrTail = [$"stderr names {Secret}"],
                    PeakBytes = 300L << 20,
                    WorkerUptime = TimeSpan.FromSeconds(42),
                    Crash = new EngineCrash([new EngineCrashException("System.InvalidOperationException", $"crash for {Secret}",
                        [new EngineStackFrame("Kustodian.Engine.EngineHandler.Handle", "Kustodian.Engine")])]),
                },
            },
        ]);
        var bridge = NewBridge((_, _, _, _, _, _, _) => Task.FromResult(results.Dequeue()));

        var ok = await RunAsync(bridge);
        var denied = await RunAsync(bridge);
        var crashed = await RunAsync(bridge);

        Assert.False(ok.TryGetProperty("reportId", out _));

        var deniedReport = Assert.IsType<FullReport>(_reporter.Details(denied.GetProperty("reportId").GetString()!));
        Assert.Equal("run.noPermission", deniedReport.Kind);
        Assert.Equal(["query", "parameters", "message", "graphError", "report", "trail"], deniedReport.Sections.Select(s => s.Key));
        Assert.Equal(("groups | where id == {id}", true), (Section(deniedReport, "query").Text, Section(deniedReport, "query").Editable));
        Assert.Equal($"id (text) = {Secret}", Section(deniedReport, "parameters").Text);
        Assert.Contains("groups?$select=id", Section(deniedReport, "graphError").Text, StringComparison.Ordinal);
        Assert.Contains("Authorization_RequestDenied", Section(deniedReport, "graphError").Text, StringComparison.Ordinal);
        Assert.Contains($"Missing GroupMember.Read.All for {Secret}", Section(deniedReport, "graphError").Text, StringComparison.Ordinal);
        // Graph's body is the full report's only: not on the wire, not in the trail.
        Assert.DoesNotContain(Secret, denied.GetRawText(), StringComparison.Ordinal);
        Assert.DoesNotContain("GroupMember", denied.GetRawText(), StringComparison.Ordinal);

        var crashReport = Assert.IsType<FullReport>(_reporter.Details(crashed.GetProperty("reportId").GetString()!));
        Assert.Equal("engine.crash", crashReport.Kind);
        Assert.Contains($"crash for {Secret}", Section(crashReport, "exception").Text, StringComparison.Ordinal);
        Assert.Equal($"stderr names {Secret}", Section(crashReport, "engineStderr").Text);

        // Only the crash is unexpected; its automatic report has the worker's own frames and the engine's numbers, no text.
        var posted = Assert.Single(await PostedAsync());
        Assert.DoesNotContain(Secret, posted, StringComparison.Ordinal);
        Assert.DoesNotContain(Secret, _trail.Render(), StringComparison.Ordinal);
        Assert.Contains("Kustodian.Engine.EngineHandler.Handle", posted, StringComparison.Ordinal);
        Assert.Contains("\"exitCode\":\"134\"", posted, StringComparison.Ordinal);
        Assert.Contains("\"peakMemoryMb\":\"300\"", posted, StringComparison.Ordinal);
        Assert.Contains("\"workerUptimeS\":\"42\"", posted, StringComparison.Ordinal);
        Assert.Contains("\"source\":\"graph\"", posted, StringComparison.Ordinal);
        Assert.Equal(["run.start(graph)", "run.end(ok)", "run.start(graph)", "run.end(noPermission)", "run.start(graph)", "run.end(failed)"],
            _trail.Render().Split("; ").Select(e => e[..e.IndexOf(' ', StringComparison.Ordinal)]));

        static RunResult Result(RunOutcome outcome, string? message = null) => new(outcome, message, null, [], [], 0, [], TimeSpan.Zero);
    }

    [Fact]
    public void Run_result_wire_has_the_report_id_and_never_the_cause()
    {
        var result = new RunResult(RunOutcome.Failed, "Failed.", null, [], [], 0, [], TimeSpan.Zero)
        {
            ReportId = "K7Q2M9XD",
            Cause = new InvalidOperationException($"Broke for {Secret}"),
        };

        var json = JsonSerializer.Serialize(result, BridgeJson.Options);

        Assert.Equal("K7Q2M9XD", Parse(json).GetProperty("reportId").GetString());
        Assert.DoesNotContain(Secret, json, StringComparison.Ordinal);
        Assert.DoesNotContain("InvalidOperationException", json, StringComparison.Ordinal);
        Assert.DoesNotContain("cause", json, StringComparison.OrdinalIgnoreCase);
    }

    private static async Task<JsonElement> RunAsync(Messaging.Bridge bridge) =>
        Parse(await bridge.HandleAsync(JsonSerializer.Serialize(new
        {
            id = "r",
            method = "query.run",
            @params = new
            {
                tabId = "t1",
                source = "graph",
                kql = "groups | where id == {id}",
                refresh = false,
                parameters = new[] { new { name = "id", type = "text", value = Secret, required = true } },
            },
        }))).GetProperty("result");
}
