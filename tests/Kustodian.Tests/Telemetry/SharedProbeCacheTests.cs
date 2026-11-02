using System.Collections.Concurrent;
using System.Net;
using System.Text.Json.Nodes;
using Kustodian.App;
using Kustodian.Graph.Fetch;
using Kustodian.Telemetry;
using Microsoft.Extensions.Time.Testing;

namespace Kustodian.Tests.Telemetry;

/// <summary>What is shared when the user opted in: one event per new probe finding, with nothing in it but the table's path, the
/// kind of finding and its detail; and nothing at all when they didn't.</summary>
public sealed class SharedProbeCacheTests : IDisposable
{
    private const string Connection = "InstrumentationKey=key-1;IngestionEndpoint=https://ingest.example/";
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private readonly FakeTimeProvider _time = new(new DateTimeOffset(2026, 11, 2, 12, 0, 0, TimeSpan.Zero));
    private readonly Recorder _sent = new();
    private readonly HttpClient _http;

    public SharedProbeCacheTests() => _http = new HttpClient(_sent);

    public void Dispose() => _http.Dispose();

    private SharedProbeCache Cache(bool? sharing, string connection = Connection) =>
        new(new MemoryGraphProbeCache(_time), _ => Task.FromResult(sharing == true), new AppInsightsTelemetry(_http, connection, _time));

    [Fact]
    public async Task Each_new_finding_is_one_event_with_only_path_finding_and_detail()
    {
        var cache = Cache(sharing: true);

        await cache.SetTopLimitAsync("account-1", "auditLogs/signIns", 500, Ct);
        await cache.SetRefusedAsync("account-1", "users", GraphCollectionReader.CountClause, true, Ct);
        await cache.SetAsync("account-1", "users", ["signInActivity"], ["deniedColumn"], Ct);
        var bodies = await _sent.WaitForAsync(3);

        var events = bodies.Select(b => JsonNode.Parse(b)!.AsArray().Single()!.AsObject()).ToList();
        Assert.All(events, e =>
        {
            Assert.Equal(["name", "time", "iKey", "tags", "data"], e.Select(p => p.Key));
            Assert.Equal("key-1", (string?)e["iKey"]);
            Assert.Equal("2026-11-02T12:00:00.0000000+00:00", (string?)e["time"]);
            Assert.Equal(new JsonObject { ["ai.application.ver"] = AppVersion.Text, ["ai.location.ip"] = "0.0.0.0" }.ToJsonString(),
                e["tags"]!.ToJsonString());
            Assert.Equal(["ver", "name", "properties"], e["data"]!["baseData"]!.AsObject().Select(p => p.Key));
            Assert.Equal(SharedProbeCache.EventName, (string?)e["data"]!["baseData"]!["name"]);
        });
        Assert.Equal(
            [
                """{"path":"auditLogs/signIns","finding":"topLimit","detail":"500"}""",
                """{"path":"users","finding":"notListed","detail":"signInActivity"}""",
                """{"path":"users","finding":"refused","detail":"$count"}""",
            ],
            events.Select(e => e["data"]!["baseData"]!["properties"]!.ToJsonString()).Order(StringComparer.Ordinal));
        Assert.All(bodies, b => Assert.DoesNotContain("account-1", b, StringComparison.Ordinal));
        Assert.All(bodies, b => Assert.DoesNotContain("deniedColumn", b, StringComparison.Ordinal));
        Assert.All(_sent.Uris, u => Assert.Equal("https://ingest.example/v2/track", u.AbsoluteUri));
    }

    [Fact]
    public async Task A_finding_already_held_is_not_shared_again()
    {
        var cache = Cache(sharing: true);

        await cache.SetTopLimitAsync("account-1", "users", 500, Ct);
        await cache.SetTopLimitAsync("account-1", "users", 500, Ct);
        await cache.SetAsync("account-1", "users", ["a"], [], Ct);
        await cache.SetAsync("account-1", "users", ["a", "b"], [], Ct);
        var bodies = await _sent.WaitForAsync(3);
        await Task.Delay(100, Ct);

        Assert.Equal(3, _sent.Bodies.Count);
        Assert.Contains(bodies, b => b.Contains("\"detail\":\"b\"", StringComparison.Ordinal));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(null)]
    public async Task Nothing_is_sent_unless_the_user_opted_in(bool? sharing)
    {
        var cache = Cache(sharing);

        await cache.SetTopLimitAsync("account-1", "users", 500, Ct);
        await cache.SetRefusedAsync("account-1", "users", GraphCollectionReader.OrderByClause, true, Ct);
        await Task.Delay(100, Ct);

        Assert.Empty(_sent.Bodies);
        Assert.Equal(500, await cache.TopLimitAsync("account-1", "users", Ct));
    }

    [Fact]
    public async Task Nothing_is_sent_without_a_connection_string()
    {
        var cache = Cache(sharing: true, connection: "");

        await cache.SetTopLimitAsync("account-1", "users", 500, Ct);
        await Task.Delay(100, Ct);

        Assert.Empty(_sent.Bodies);
    }

    [Fact]
    public async Task A_failed_send_is_dropped()
    {
        _sent.Fail = true;
        var telemetry = new AppInsightsTelemetry(_http, Connection, _time);

        await telemetry.TrackEventAsync("x", new Dictionary<string, string>(), Ct);

        Assert.Single(_sent.Uris);
    }

    private sealed class Recorder : HttpMessageHandler
    {
        public ConcurrentQueue<string> Bodies { get; } = new();
        public ConcurrentQueue<Uri> Uris { get; } = new();
        public bool Fail { get; set; }

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            Uris.Enqueue(request.RequestUri!);
            if (Fail)
                throw new HttpRequestException("unreachable");
            Bodies.Enqueue(await request.Content!.ReadAsStringAsync(ct));
            return new HttpResponseMessage(HttpStatusCode.OK);
        }

        /// <summary>The bodies once <paramref name="count"/> have arrived: the sends aren't awaited by the cache.</summary>
        public async Task<List<string>> WaitForAsync(int count)
        {
            for (var i = 0; i < 100 && Bodies.Count < count; i++)
                await Task.Delay(20);
            return [.. Bodies];
        }
    }
}
