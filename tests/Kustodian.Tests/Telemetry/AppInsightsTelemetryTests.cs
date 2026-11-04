using System.Text.Json.Nodes;
using Kustodian.App;
using Kustodian.Telemetry;
using Microsoft.Extensions.Time.Testing;

namespace Kustodian.Tests.Telemetry;

/// <summary>The envelopes <see cref="AppInsightsTelemetry"/> posts.</summary>
public sealed class AppInsightsTelemetryTests : IDisposable
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private readonly FakeTimeProvider _time = new(new DateTimeOffset(2026, 11, 2, 12, 0, 0, TimeSpan.Zero));
    private readonly Recorder _sent = new();
    private readonly HttpClient _http;

    public AppInsightsTelemetryTests() => _http = new HttpClient(_sent);

    public void Dispose() => _http.Dispose();

    [Fact]
    public async Task Exception_envelope_has_types_frames_and_kind_only()
    {
        var telemetry = new AppInsightsTelemetry(_http, "InstrumentationKey=key-1;IngestionEndpoint=https://ingest.example/", _time);

        await telemetry.TrackExceptionAsync("engine.crash",
            [
                new ScrubbedException("System.InvalidOperationException",
                    [new ErrorFrame("Kustodian.Graph.Run.GraphRunner.RunAsync", "Kustodian.Graph")]),
                new ScrubbedException("System.IO.IOException", []),
            ],
            new Dictionary<string, string> { ["reportId"] = "K7Q2M9XD" }, Ct);

        var body = Assert.Single(_sent.Bodies);
        Assert.Equal("https://ingest.example/v2/track", Assert.Single(_sent.Uris).AbsoluteUri);
        var envelope = JsonNode.Parse(body)!.AsArray().Single()!.AsObject();
        Assert.Equal("Microsoft.ApplicationInsights.Exception", (string?)envelope["name"]);
        Assert.Equal(new JsonObject { ["ai.application.ver"] = AppVersion.Text, ["ai.location.ip"] = "0.0.0.0" }.ToJsonString(),
            envelope["tags"]!.ToJsonString());
        Assert.Equal("ExceptionData", (string?)envelope["data"]!["baseType"]);

        var data = envelope["data"]!["baseData"]!;
        Assert.Equal("""{"reportId":"K7Q2M9XD"}""", data["properties"]!.ToJsonString());
        var exceptions = data["exceptions"]!.AsArray();
        Assert.Equal(2, exceptions.Count);
        Assert.Equal((int?)exceptions[0]!["id"], (int?)exceptions[1]!["outerId"]);
        Assert.Equal(["System.InvalidOperationException", "System.IO.IOException"], exceptions.Select(e => (string?)e!["typeName"]));
        Assert.All(exceptions, e =>
        {
            Assert.Equal("engine.crash", (string?)e!["message"]);
            Assert.True((bool?)e["hasFullStack"]);
        });
        Assert.Equal("""[{"level":0,"method":"Kustodian.Graph.Run.GraphRunner.RunAsync","assembly":"Kustodian.Graph"}]""",
            exceptions[0]!["parsedStack"]!.ToJsonString());
        Assert.Empty(exceptions[1]!["parsedStack"]!.AsArray());
        Assert.DoesNotContain("fileName", body, StringComparison.Ordinal);
        Assert.DoesNotContain("\"line\"", body, StringComparison.Ordinal);
    }
}
