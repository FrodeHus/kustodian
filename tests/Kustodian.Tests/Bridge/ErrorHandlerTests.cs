using System.Text.Json;
using Kustodian.Messaging.Handlers;
using Kustodian.Telemetry;
using Kustodian.Tests.Telemetry;

namespace Kustodian.Tests.Bridge;

/// <summary>The "Send details" dialog's bridge methods: the full report, sending it, and the UI's own errors.</summary>
public sealed class ErrorHandlerTests : IDisposable
{
    private const string Connection = "InstrumentationKey=key-1;IngestionEndpoint=https://ingest.example/";
    private const string Secret = "alice@contoso.com";

    private readonly Recorder _posted = new();
    private readonly HttpClient _http;

    public ErrorHandlerTests() => _http = new HttpClient(_posted);

    public void Dispose() => _http.Dispose();

    private (Messaging.Bridge Bridge, ErrorReporter Reporter) NewBridge(string connection = Connection)
    {
        var reporter = new ErrorReporter(new AppInsightsTelemetry(_http, connection, TimeProvider.System), _ => Task.FromResult(true),
            new ErrorTrail(TimeProvider.System), TimeProvider.System);
        var bridge = new Messaging.Bridge(_ => { });
        new ErrorHandler(reporter).Register(bridge);
        return (bridge, reporter);
    }

    private static string Expected(ErrorReporter reporter) => reporter.Capture(new ErrorCapture("run.failed", false, [], new ErrorFacts(),
        [new FullReportSection("query", "Query", $"users | where mail == '{Secret}'", true), new FullReportSection("message", "Message", "No.", false)]));

    private static async Task<JsonElement> Send(Messaging.Bridge bridge, string method, object @params)
    {
        var reply = await bridge.HandleAsync(JsonSerializer.Serialize(new { id = "1", method, @params }));
        Assert.NotNull(reply);
        using var doc = JsonDocument.Parse(reply);
        return doc.RootElement.Clone();
    }

    [Fact]
    public async Task Details_answers_the_report_by_its_shown_id()
    {
        var (bridge, reporter) = NewBridge();
        var id = Expected(reporter);

        var result = (await Send(bridge, "errors.details", new { reportId = $"{id[..4]}-{id[4..]}" })).GetProperty("result");
        var unknown = (await Send(bridge, "errors.details", new { reportId = "00000000" })).GetProperty("result");

        Assert.True(result.GetProperty("canSend").GetBoolean());
        var report = result.GetProperty("report");
        Assert.Equal(id, report.GetProperty("reportId").GetString());
        Assert.Equal("run.failed", report.GetProperty("kind").GetString());
        Assert.Equal(["query", "message", "report", "trail"],
            report.GetProperty("sections").EnumerateArray().Select(s => s.GetProperty("key").GetString()));
        Assert.Equal(JsonValueKind.Null, unknown.GetProperty("report").ValueKind);
    }

    [Fact]
    public async Task Send_refuses_changed_sections()
    {
        var (bridge, reporter) = NewBridge();
        var id = Expected(reporter);

        var changed = await Send(bridge, "errors.send", new { reportId = id, sections = new Dictionary<string, string> { ["message"] = "Edited." } });
        var edited = await Send(bridge, "errors.send", new
        {
            reportId = id,
            sections = new Dictionary<string, string> { ["query"] = "users | where mail == '…'", ["message"] = "No." },
        });
        await reporter.FlushAsync(TimeSpan.FromSeconds(5));

        Assert.Equal("bad_request", changed.GetProperty("error").GetProperty("code").GetString());
        Assert.True(edited.GetProperty("result").GetProperty("sent").GetBoolean());
        var body = Assert.Single(_posted.Bodies);
        Assert.Contains(ErrorReporter.FullReportEvent, body, StringComparison.Ordinal);
        Assert.DoesNotContain(Secret, body, StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_build_that_cannot_send_says_so_and_refuses()
    {
        var (bridge, reporter) = NewBridge(connection: "");
        var id = Expected(reporter);

        var details = (await Send(bridge, "errors.details", new { reportId = id })).GetProperty("result");
        var sent = await Send(bridge, "errors.send", new { reportId = id, sections = new Dictionary<string, string>() });

        Assert.False(details.GetProperty("canSend").GetBoolean());
        Assert.Equal(id, details.GetProperty("report").GetProperty("reportId").GetString());
        Assert.Equal("bad_request", sent.GetProperty("error").GetProperty("code").GetString());
    }

    [Fact]
    public async Task Report_from_the_ui_is_scrubbed()
    {
        var (bridge, reporter) = NewBridge();
        const string Stack = "TypeError: x\n    at render (app://kustodian/assets/index-abc123.js:1:200)";

        var result = (await Send(bridge, "errors.report", new { name = "TypeError", message = $"No user {Secret}", stack = Stack, source = "boundary" }))
            .GetProperty("result");
        var refused = await Send(bridge, "errors.report", new { name = "TypeError", message = "x", stack = "", source = "elsewhere" });
        await reporter.FlushAsync(TimeSpan.FromSeconds(5));

        var report = Assert.IsType<FullReport>(reporter.Details(result.GetProperty("reportId").GetString()!));
        Assert.Equal("ui.boundary", report.Kind);
        Assert.Equal($"No user {Secret}", Assert.Single(report.Sections, s => s.Key == "message").Text);
        var posted = Assert.Single(_posted.Bodies);
        Assert.Contains("ui.boundary", posted, StringComparison.Ordinal);
        Assert.Contains("TypeError", posted, StringComparison.Ordinal);
        Assert.DoesNotContain(Secret, posted, StringComparison.Ordinal);
        Assert.Equal("bad_request", refused.GetProperty("error").GetProperty("code").GetString());
    }
}
