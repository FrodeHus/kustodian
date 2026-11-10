using System.Text.Json;
using Kustodian.Graph.Run;
using Kustodian.Graph.Schema;
using Kustodian.Messaging.Handlers;

namespace Kustodian.Tests.Bridge;

public class QueryHandlerFilterAtTests
{
    private readonly FakeSource _graph = new("graph", (_, _, _, _, _, _, _) => Task.FromResult(Ok()));

    [Fact]
    public async Task Offset_is_after_the_line_before_the_take()
    {
        var reply = await Send(NewBridge(), new { source = "hunting", kql = "T | project a | take 10", column = "a" });

        Assert.Equal("T | project a".Length, reply.GetProperty("result").GetProperty("offset").GetInt32());
    }

    [Fact]
    public async Task Not_a_query_has_no_offset()
    {
        var reply = await Send(NewBridge(), new { source = "hunting", kql = ".show tables", column = "x" });

        Assert.Equal(JsonValueKind.Null, reply.GetProperty("result").GetProperty("offset").ValueKind);
    }

    [Fact]
    public async Task GraphPlaceholders()
    {
        const string kql = "users | where displayName == {name} | take 5";

        var reply = await Send(NewBridge(), new
        {
            source = "graph",
            kql,
            column = "displayName",
            parameters = new[] { new { name = "name", type = "text", value = "x", required = false } },
        });

        Assert.Equal(kql.IndexOf("{name}", StringComparison.Ordinal) + "{name}".Length,
            reply.GetProperty("result").GetProperty("offset").GetInt32());
    }

    [Theory]
    [InlineData("to", "['to']")]
    [InlineData("desc", "['desc']")]
    [InlineData("displayName", "displayName")]
    public async Task Name_is_the_column_as_written_in_KQL(string column, string name)
    {
        var reply = await Send(NewBridge(), new { source = "hunting", kql = "T | take 10", column });

        Assert.Equal(name, reply.GetProperty("result").GetProperty("name").GetString());
    }

    [Fact]
    public async Task Not_a_query_still_names_the_column()
    {
        var reply = await Send(NewBridge(), new { source = "hunting", kql = ".show tables", column = "to" });

        Assert.Equal("['to']", reply.GetProperty("result").GetProperty("name").GetString());
    }

    [Fact]
    public async Task Log_analytics_is_placed_like_hunting()
    {
        var reply = await Send(NewBridge(), new { source = "logs", kql = "SigninLogs | project a | take 10", column = "a" });

        Assert.Equal("SigninLogs | project a".Length, reply.GetProperty("result").GetProperty("offset").GetInt32());
    }

    [Fact]
    public async Task Unknown_source_is_bad_request()
    {
        var reply = await Send(NewBridge(), new { source = "nope", kql = "T", column = "a" });

        Assert.Equal("bad_request", reply.GetProperty("error").GetProperty("code").GetString());
    }

    private Messaging.Bridge NewBridge()
    {
        var bridge = new Messaging.Bridge(_ => { });
        new QueryHandler(GraphSchemaCatalog.Beta, () => Task.FromResult<string?>("acct-1"), FakeSource.Map(_graph)).Register(bridge);
        return bridge;
    }

    private static async Task<JsonElement> Send(Messaging.Bridge bridge, object parameters)
    {
        var reply = await bridge.HandleAsync(JsonSerializer.Serialize(new { id = "1", method = "query.filterAt", @params = parameters }));
        Assert.NotNull(reply);
        using var doc = JsonDocument.Parse(reply);
        return doc.RootElement.Clone();
    }

    private static RunResult Ok() => new(RunOutcome.Ok, null, null, [], [], 0, [], TimeSpan.Zero);
}
