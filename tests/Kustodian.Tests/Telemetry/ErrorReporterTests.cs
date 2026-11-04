using System.Text.Json.Nodes;
using Kustodian.Telemetry;
using Microsoft.Extensions.Time.Testing;

namespace Kustodian.Tests.Telemetry;

/// <summary>Report IDs, the automatic report sent when the user opted in, the full-report store and the full report sent on
/// request.</summary>
public sealed class ErrorReporterTests : IDisposable
{
    private const string Connection = "InstrumentationKey=key-1;IngestionEndpoint=https://ingest.example/";
    private const string Secret = "alice@contoso.com in C:\\Users\\alice\\query.kql";
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private readonly FakeTimeProvider _time = new(new DateTimeOffset(2026, 11, 4, 12, 0, 0, TimeSpan.Zero));
    private readonly Recorder _sent = new();
    private readonly HttpClient _http;
    private readonly ErrorTrail _trail;

    public ErrorReporterTests()
    {
        _http = new HttpClient(_sent);
        _trail = new ErrorTrail(_time);
    }

    public void Dispose() => _http.Dispose();

    private ErrorReporter Reporter(bool enabled = true, string connection = Connection, HttpClient? http = null) =>
        new(new AppInsightsTelemetry(http ?? _http, connection, _time), _ => Task.FromResult(enabled), _trail, _time);

    private static ErrorCapture Capture(bool unexpected = true, string kind = "engine.crash",
        string type = "System.InvalidOperationException", string frame = "Kustodian.Graph.Run.GraphRunner.RunAsync",
        ErrorFacts? facts = null, IReadOnlyList<FullReportSection>? details = null) =>
        new(kind, unexpected,
            [new ScrubbedException(type, [new ErrorFrame("<external>", ""), new ErrorFrame(frame, "Kustodian.Graph")])],
            facts ?? new ErrorFacts(), details ?? []);

    private static JsonObject BaseData(string body) => JsonNode.Parse(body)!.AsArray().Single()!["data"]!["baseData"]!.AsObject();

    private static List<string> Keys(JsonNode properties) => [.. properties.AsObject().Select(p => p.Key)];

    /// <summary>Lets the started sends run to the end; they aren't awaited by <see cref="ErrorReporter.Capture"/>.</summary>
    private static Task Settle(ErrorReporter reporter) => reporter.FlushAsync(TimeSpan.FromSeconds(5));

    [Fact]
    public void Capture_returns_an_id_even_when_keeping_the_material_throws()
    {
        var reporter = Reporter();
        var broken = Capture(details: [new FullReportSection("bad", "Bad", null!, false)]);

        var id = reporter.Capture(broken);

        Assert.Equal(8, id.Length);
    }

    [Fact]
    public void Capture_returns_a_new_id_each_time()
    {
        var reporter = Reporter();

        var ids = Enumerable.Range(0, 50).Select(_ => reporter.Capture(Capture(unexpected: false))).ToList();

        Assert.Equal(ids.Count, ids.Distinct().Count());
        Assert.All(ids, id => Assert.Matches("^[0-9A-HJKMNP-TV-Z]{8}$", id));
    }

    [Fact]
    public async Task Unexpected_error_sends_one_exception_report_when_enabled()
    {
        var reporter = Reporter();
        _trail.Add("run.start(graph)");

        var id = reporter.Capture(Capture(
            facts: new ErrorFacts(Source: "graph", ExitCode: 134, PeakMemoryMb: 900, Paused: false),
            details: [new FullReportSection("query", "Query", Secret, true), new FullReportSection("message", "Message", Secret, false)]));
        await Settle(reporter);

        var body = Assert.Single(_sent.Bodies);
        Assert.Equal("Microsoft.ApplicationInsights.Exception", (string?)JsonNode.Parse(body)!.AsArray().Single()!["name"]);
        var properties = BaseData(body)["properties"]!;
        Assert.Equal(["reportId", "kind", "os", "arch", "runtime", "trail", "source", "exitCode", "peakMemoryMb", "paused"],
            Keys(properties));
        Assert.Equal(id, (string?)properties["reportId"]);
        Assert.Equal("engine.crash", (string?)properties["kind"]);
        Assert.Equal("run.start(graph) +0s", (string?)properties["trail"]);
        Assert.Equal("134", (string?)properties["exitCode"]);
        Assert.Equal("false", (string?)properties["paused"]);
        Assert.Equal(Environment.Version.ToString(), (string?)properties["runtime"]);
        Assert.DoesNotContain(Environment.MachineName, (string?)properties["os"], StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("alice", body, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Expected_error_sends_nothing()
    {
        var reporter = Reporter();

        reporter.Capture(Capture(unexpected: false));
        await Settle(reporter);

        Assert.Empty(_sent.Uris);
    }

    [Fact]
    public async Task Disabled_sends_nothing()
    {
        var reporter = Reporter(enabled: false);

        reporter.Capture(Capture());
        await Settle(reporter);

        Assert.Empty(_sent.Uris);
    }

    [Fact]
    public async Task Unconfigured_sends_nothing()
    {
        var reporter = Reporter(connection: "");

        reporter.Capture(Capture());
        await Settle(reporter);

        Assert.Empty(_sent.Uris);
    }

    [Fact]
    public async Task Same_problem_is_reported_once_per_session()
    {
        var reporter = Reporter();

        reporter.Capture(Capture());
        reporter.Capture(Capture());
        await Settle(reporter);
        Assert.Single(_sent.Bodies);

        reporter.Capture(Capture(frame: "Kustodian.Graph.Run.GraphRunner.FetchAsync"));
        await Settle(reporter);
        Assert.Equal(2, _sent.Bodies.Count);
    }

    [Fact]
    public async Task At_most_twenty_reports_per_session()
    {
        var reporter = Reporter();

        for (var i = 0; i < 25; i++)
            reporter.Capture(Capture(frame: $"Kustodian.Graph.Run.GraphRunner.Step{i}"));
        await Settle(reporter);

        Assert.Equal(20, _sent.Bodies.Count);
    }

    [Fact]
    public void Details_are_kept_ten_unexpected_and_twenty_expected_for_thirty_minutes()
    {
        var reporter = Reporter(enabled: false);

        var first = reporter.Capture(Capture());
        for (var i = 0; i < 25; i++)
            reporter.Capture(Capture(unexpected: false));
        Assert.NotNull(reporter.Details(first));

        var unexpected = Enumerable.Range(0, 10).Select(_ => reporter.Capture(Capture())).ToList();
        Assert.Null(reporter.Details(first));
        Assert.NotNull(reporter.Details(unexpected[0]));

        _time.Advance(TimeSpan.FromMinutes(30));
        Assert.Null(reporter.Details(unexpected[^1]));
    }

    [Fact]
    public void Details_include_the_scrubbed_report_and_trail_as_sections()
    {
        var reporter = Reporter(enabled: false);
        _trail.Add("run.start(graph)");

        var id = reporter.Capture(Capture(facts: new ErrorFacts(ExitCode: 134),
            details: [new FullReportSection("query", "Query", "Users | take 5", true)]));
        _trail.Add("run.start(hunting)");

        var report = reporter.Details(id)!;
        Assert.Equal(id, report.ReportId);
        Assert.Equal("engine.crash", report.Kind);
        Assert.Equal(["query", "report", "trail"], report.Sections.Select(s => s.Key));
        Assert.Equal([true, false, false], report.Sections.Select(s => s.Editable));
        var text = report.Sections[1].Text;
        Assert.Contains("engine.crash", text, StringComparison.Ordinal);
        Assert.Contains("System.InvalidOperationException", text, StringComparison.Ordinal);
        Assert.Contains("Kustodian.Graph.Run.GraphRunner.RunAsync", text, StringComparison.Ordinal);
        Assert.Contains("exitCode: 134", text, StringComparison.Ordinal);
        Assert.Equal("run.start(graph) +0s", report.Sections[2].Text);
    }

    [Fact]
    public async Task SendAsync_sends_the_given_sections_as_one_event()
    {
        var reporter = Reporter(enabled: false);
        var id = reporter.Capture(Capture(unexpected: false, kind: "bridge.failed", details:
        [
            new FullReportSection("query", "Query", "Users | take 5", true),
            new FullReportSection("stderr", "Engine output", new string('x', 10_000), false),
        ]));
        var shown = reporter.Details(id)!;
        var stderr = shown.Sections.Single(s => s.Key == "stderr").Text;
        Assert.Equal(8192, stderr.Length);
        Assert.EndsWith("… (cut)", stderr, StringComparison.Ordinal);

        Assert.True(await reporter.SendAsync(id, new Dictionary<string, string>
        {
            ["query"] = "Users | take ##",
            ["stderr"] = stderr,
        }, Ct));
        await Settle(reporter);

        var body = Assert.Single(_sent.Bodies);
        Assert.Equal("Microsoft.ApplicationInsights.Event", (string?)JsonNode.Parse(body)!.AsArray().Single()!["name"]);
        var data = BaseData(body);
        Assert.Equal(ErrorReporter.FullReportEvent, (string?)data["name"]);
        Assert.Equal(["reportId", "kind", "query", "stderr"], Keys(data["properties"]!));
        Assert.Equal(id, (string?)data["properties"]!["reportId"]);
        Assert.Equal("bridge.failed", (string?)data["properties"]!["kind"]);
        Assert.Equal("Users | take ##", (string?)data["properties"]!["query"]);
        Assert.Equal(stderr, (string?)data["properties"]!["stderr"]);
    }

    [Fact]
    public async Task SendAsync_refuses_changed_or_unknown_sections()
    {
        var reporter = Reporter();
        var id = reporter.Capture(Capture(unexpected: false,
            details: [new FullReportSection("message", "Message", "Bad request", false)]));

        Assert.False(await reporter.SendAsync(id, new Dictionary<string, string> { ["message"] = "Changed" }, Ct));
        Assert.False(await reporter.SendAsync(id, new Dictionary<string, string> { ["extra"] = "Anything" }, Ct));
        await Settle(reporter);
        Assert.Empty(_sent.Uris);

        Assert.True(await reporter.SendAsync(id, new Dictionary<string, string>(), Ct));
        await Settle(reporter);
        Assert.Equal(["reportId", "kind"], Keys(BaseData(Assert.Single(_sent.Bodies))["properties"]!));
    }

    [Fact]
    public async Task SendAsync_for_an_expired_report_sends_the_ui_sections_only()
    {
        var reporter = Reporter();

        Assert.True(await reporter.SendAsync("K7Q2M9XD", new Dictionary<string, string>
        {
            ["query"] = "Users",
            ["message"] = "Boom",
            ["uiStack"] = "at render",
            ["stderr"] = "from nowhere",
        }, Ct));
        await Settle(reporter);

        var properties = BaseData(Assert.Single(_sent.Bodies))["properties"]!;
        Assert.Equal(["reportId", "query", "message", "uiStack"], Keys(properties));
        Assert.Equal("K7Q2M9XD", (string?)properties["reportId"]);
    }

    [Fact]
    public async Task A_send_that_fails_changes_nothing()
    {
        _sent.Fail = true;
        var reporter = Reporter();

        var id = reporter.Capture(Capture());
        await Settle(reporter);

        Assert.Single(_sent.Uris);
        Assert.NotNull(reporter.Details(id));
    }

    [Fact]
    public async Task FlushAsync_waits_at_most_the_given_time()
    {
        using var http = new HttpClient(new Hang());
        var reporter = Reporter(http: http);
        reporter.Capture(Capture());

        var flush = reporter.FlushAsync(TimeSpan.FromSeconds(2));
        Assert.False(flush.IsCompleted);
        _time.Advance(TimeSpan.FromSeconds(2));

        await flush.WaitAsync(TimeSpan.FromSeconds(5), Ct);
    }

    /// <summary>Never answers.</summary>
    private sealed class Hang : HttpMessageHandler
    {
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            await Task.Delay(Timeout.Infinite, ct);
            throw new InvalidOperationException("unreachable");
        }
    }
}
