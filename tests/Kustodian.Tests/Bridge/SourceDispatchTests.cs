using System.Text.Json;
using Kustodian.Graph.Query;
using Kustodian.Graph.Run;
using Kustodian.Graph.Schema;
using Kustodian.Messaging.Handlers;

namespace Kustodian.Tests.Bridge;

public class SourceDispatchTests
{
    private const string RunId = "0b9d6f0e-5c1a-4c8e-9d2f-3a4b5c6d7e8f";

    private readonly FakeSource _graph = new("graph", (_, _, _, _, _, _, _) => Task.FromResult(Ok()));
    private readonly FakeSource _hunting = new("hunting", (_, _, _, _, _, _, _) => Task.FromResult(Ok()));

    [Fact]
    public async Task Run_dispatches_by_source()
    {
        var bridge = NewBridge();

        var reply = await Send(bridge, "query.run", new
        {
            tabId = "t1",
            source = "hunting",
            kql = "DeviceInfo | take {n}",
            refresh = true,
            runId = RunId,
            parameters = new[] { new { name = "n", type = "number", value = "5", required = true } },
            options = new { timespan = "P7D" },
        });

        Assert.Equal("ok", reply.GetProperty("result").GetProperty("outcome").GetString());
        Assert.Empty(_graph.Requests);
        var request = Assert.Single(_hunting.Requests);
        Assert.Equal("acct-1", request.AccountKey);
        Assert.Equal("DeviceInfo | take {n}", request.Kql);
        Assert.Equal([new ParameterValue("n", "number", "5", true)], request.Parameters);
        Assert.True(request.Refresh);
        Assert.Equal(RunId, request.RunId);
        Assert.Equal("P7D", request.Options?.Timespan);
        Assert.Null(request.Options?.Scope);

        await Send(bridge, "query.run", new { tabId = "t2", source = "graph", kql = "users", refresh = false });

        var graphRequest = Assert.Single(_graph.Requests);
        Assert.Equal("users", graphRequest.Kql);
        Assert.Null(graphRequest.Options);
    }

    [Fact]
    public async Task Unknown_source_is_bad_request()
    {
        var bridge = NewBridge();

        var reply = await Send(bridge, "query.run", new { tabId = "t1", source = "arg", kql = "resources", refresh = false });

        AssertBadRequest(reply, "Unknown source arg.");
        Assert.Empty(_graph.Requests);
        Assert.Empty(_hunting.Requests);
    }

    [Fact]
    public async Task Explain_for_hunting_is_refused_with_copy()
    {
        var bridge = NewBridge();

        var explain = await Send(bridge, "query.explain", new { source = "hunting", kql = "DeviceInfo" });
        var complete = await Send(bridge, "query.complete", new { source = "hunting", kql = "DeviceInfo", position = 0 });
        var unknown = await Send(bridge, "query.explain", new { source = "nope", kql = "x" });
        var graph = await Send(bridge, "query.explain", new { source = "graph", kql = "users" });

        AssertBadRequest(explain, "Explain is only available for Microsoft Graph.");
        AssertBadRequest(complete, "Completion comes from the editor for this source.");
        AssertBadRequest(unknown, "Unknown source nope.");
        Assert.True(graph.TryGetProperty("result", out _));
    }

    public static TheoryData<string> InvalidOptions => new()
    {
        """{"timespan":"P31D"}""",
        """{"timespan":"2026-10-01T00:00:00Z/2026-11-01T00:00:01Z"}""",
        """{"timespan":"P1M"}""",
        """{"timespan":"seven days"}""",
        """{"timespan":"PT0S"}""",
        """{"scope":{"kind":"subscriptions","ids":["not-a-guid"]}}""",
        JsonSerializer.Serialize(new { scope = new { kind = "subscriptions", ids = Enumerable.Range(0, 101).Select(_ => Guid.NewGuid().ToString("D")) } }),
        """{"scope":{"kind":"subscriptions","ids":[]}}""",
        """{"scope":{"kind":"managementGroup","ids":["bad/name"]}}""",
        """{"scope":{"kind":"managementGroup","ids":["a","b"]}}""",
        """{"scope":{"kind":"all","ids":["11111111-1111-1111-1111-111111111111"]}}""",
        """{"scope":{"kind":"tenant","ids":[]}}""",
    };

    [Theory]
    [MemberData(nameof(InvalidOptions))]
    public async Task Invalid_options_are_bad_request(string options)
    {
        var bridge = NewBridge();

        var reply = await Send(bridge, "query.run", new
        {
            tabId = "t1",
            source = "hunting",
            kql = "DeviceInfo",
            refresh = false,
            options = JsonDocument.Parse(options).RootElement,
        });

        Assert.Equal("bad_request", reply.GetProperty("error").GetProperty("code").GetString());
        Assert.Empty(_hunting.Requests);
    }

    [Theory]
    [InlineData("""{"timespan":"P1D"}""")]
    [InlineData("""{"timespan":"P30D"}""")]
    [InlineData("""{"timespan":"PT12H"}""")]
    [InlineData("""{"timespan":"2026-10-01T00:00:00Z/2026-10-31T00:00:00Z"}""")]
    [InlineData("""{"scope":{"kind":"subscriptions","ids":["11111111-1111-1111-1111-111111111111"]}}""")]
    [InlineData("""{"scope":{"kind":"managementGroup","ids":["contoso-root_(prod).1"]}}""")]
    [InlineData("""{"scope":{"kind":"all","ids":[]}}""")]
    [InlineData("""{"scope":{"kind":"all"}}""")]
    [InlineData("""{}""")]
    public async Task Valid_options_reach_the_source(string options)
    {
        var bridge = NewBridge();

        var reply = await Send(bridge, "query.run", new
        {
            tabId = "t1",
            source = "hunting",
            kql = "DeviceInfo",
            refresh = false,
            options = JsonDocument.Parse(options).RootElement,
        });

        Assert.True(reply.TryGetProperty("result", out _), reply.GetRawText());
        Assert.NotNull(Assert.Single(_hunting.Requests).Options);
    }

    private Messaging.Bridge NewBridge()
    {
        var bridge = new Messaging.Bridge(_ => { });
        new QueryHandler(GraphSchemaCatalog.Beta, () => Task.FromResult<string?>("acct-1"), FakeSource.Map(_graph, _hunting))
            .Register(bridge);
        return bridge;
    }

    private static async Task<JsonElement> Send(Messaging.Bridge bridge, string method, object parameters)
    {
        var reply = await bridge.HandleAsync(JsonSerializer.Serialize(new { id = "1", method, @params = parameters }));
        Assert.NotNull(reply);
        using var doc = JsonDocument.Parse(reply);
        return doc.RootElement.Clone();
    }

    private static void AssertBadRequest(JsonElement reply, string message)
    {
        var error = reply.GetProperty("error");
        Assert.Equal("bad_request", error.GetProperty("code").GetString());
        Assert.Equal(message, error.GetProperty("message").GetString());
    }

    private static RunResult Ok() => new(RunOutcome.Ok, null, null, [], [], 0, [], TimeSpan.Zero);
}
