using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Kustodian.Graph.Fetch;
using Kustodian.Graph.Run;
using Kustodian.Graph.Schema;
using Kustodian.Graph.Tests.Run;

namespace Kustodian.Graph.Tests;

/// <summary>One relationship (<c>memberOf</c>, <c>manager</c>) of each object, read through <c>$batch</c>.</summary>
public sealed class GraphRelationshipReaderTests
{
    private static readonly GraphColumn MemberOf = new("memberOf", "dynamic", "", [], false, null, Collection: true) { Relationship = true };
    private static readonly GraphColumn Manager = new("manager", "dynamic", "", [], false, null) { Relationship = true };

    private static JsonObject Obj(string id) => new() { ["id"] = id };

    private static HttpResponseMessage Batch(HttpRequestMessage request, Func<string, (int Status, object? Body)> item)
    {
        var batch = JsonNode.Parse(request.Content!.ReadAsStringAsync().GetAwaiter().GetResult())!.AsObject();
        var responses = batch["requests"]!.AsArray().Select(r =>
        {
            var (status, body) = item(r!["url"]!.GetValue<string>().Split('/')[2]);
            var headers = status == 429 ? new Dictionary<string, string> { ["Retry-After"] = "0" } : null;
            return new { id = r["id"]!.GetValue<string>(), status, headers, body };
        }).ToList();
        return new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent(JsonSerializer.Serialize(new { responses }), Encoding.UTF8, "application/json"),
        };
    }

    private static GraphRelationshipReader Reader(FakeGraph graph, GraphLimits? limits = null)
        => new(new HttpClient(graph) { BaseAddress = new Uri("https://graph.microsoft.com/beta/") }, limits ?? GraphLimits.Default);

    private static Task<GraphRelationshipRead> Read(GraphRelationshipReader reader, GraphColumn column, params string[] ids)
        => reader.ReadAsync("account-1", "users", column, [.. ids.Select(Obj)], new GraphFetchBudget().Lease(), null, CancellationToken.None);

    [Fact]
    public void Template_matches_the_spec()
    {
        Assert.Equal("users/{id}/memberOf?$select=id,displayName,userPrincipalName,mail,appId,deviceId&$top=999",
            GraphRelationshipReader.Template("users", "memberOf", true));
        Assert.Equal("users/{id}/manager?$select=id,displayName,userPrincipalName,mail,appId,deviceId",
            GraphRelationshipReader.Template("users", "manager", false));
    }

    [Fact]
    public void Entry_maps_type_and_drops_absent_fields()
    {
        var group = JsonNode.Parse("""{"@odata.type":"#microsoft.graph.group","id":"g1","displayName":"SOC","mail":"soc@x","securityEnabled":true}""")!.AsObject();
        var user = JsonNode.Parse("""{"@odata.type":"#microsoft.graph.user","id":"u1","userPrincipalName":"a@x","mail":null}""")!.AsObject();

        Assert.Equal("""{"id":"g1","objectType":"group","displayName":"SOC","mail":"soc@x"}""", GraphRelationshipReader.Entry(group).ToJsonString());
        Assert.Equal("""{"id":"u1","objectType":"user","userPrincipalName":"a@x","mail":null}""", GraphRelationshipReader.Entry(user).ToJsonString());
    }

    [Fact]
    public async Task Collection_values_become_arrays()
    {
        var graph = new FakeGraph
        {
            Answer = (request, _) => Task.FromResult(Batch(request, id => (200, new
            {
                value = new object[]
                {
                    new Dictionary<string, object> { ["@odata.type"] = "#microsoft.graph.group", ["id"] = id + "-g1", ["displayName"] = "One", ["x"] = 1 },
                    new Dictionary<string, object> { ["@odata.type"] = "#microsoft.graph.group", ["id"] = id + "-g2" },
                },
            }))),
        };

        var result = await Read(Reader(graph), MemberOf, "u1", "u2");

        var values = Assert.IsType<JsonArray>(result.Values["u1"]);
        Assert.Equal(2, values.Count);
        Assert.Equal("""{"id":"u1-g1","objectType":"group","displayName":"One"}""", values[0]!.ToJsonString());
        Assert.IsType<JsonArray>(result.Values["u2"]);
        Assert.Equal((0, 0), (result.Refused, result.Failed));
        Assert.Empty(result.Truncated);
        Assert.Single(graph.Requests, r => r.Contains("$batch", StringComparison.Ordinal));
    }

    [Fact]
    public async Task Follows_next_link_until_the_entry_cap()
    {
        var graph = new FakeGraph
        {
            Answer = (request, _) => Task.FromResult(request.Method == HttpMethod.Post
                ? Batch(request, _ => (200, new Dictionary<string, object>
                {
                    ["value"] = new object[] { new { id = "a" }, new { id = "b" } },
                    ["@odata.nextLink"] = "https://graph.microsoft.com/beta/users/u1/memberOf?$skiptoken=p2",
                }))
                : FakeGraph.Page([new { id = "c" }, new { id = "d" }], "https://graph.microsoft.com/beta/users/u1/memberOf?$skiptoken=p3")),
        };

        var result = await Read(Reader(graph, new GraphLimits { RelationshipEntriesPerObject = 3 }), MemberOf, "u1");

        Assert.Equal(3, Assert.IsType<JsonArray>(result.Values["u1"]).Count);
        Assert.Equal(["u1"], result.Truncated);
        Assert.DoesNotContain(graph.Requests, r => r.Contains("p3", StringComparison.Ordinal));
        Assert.Contains(graph.Requests, r => r.Contains("p2", StringComparison.Ordinal));
    }

    [Fact]
    public async Task Single_relationship_404_is_null()
    {
        var graph = new FakeGraph
        {
            Answer = (request, _) => Task.FromResult(Batch(request, id => id == "u1"
                ? (404, new { error = new { code = "Request_ResourceNotFound" } })
                : (200, new Dictionary<string, object> { ["@odata.type"] = "#microsoft.graph.user", ["id"] = "m1", ["displayName"] = "Boss" }))),
        };

        var result = await Read(Reader(graph), Manager, "u1", "u2");

        Assert.True(result.Values.ContainsKey("u1"));
        Assert.Null(result.Values["u1"]);
        Assert.Equal("""{"id":"m1","objectType":"user","displayName":"Boss"}""", result.Values["u2"]!.ToJsonString());
        Assert.Equal((0, 0), (result.Refused, result.Failed));
    }

    [Fact]
    public async Task Collection_404_fails_the_object()
    {
        // Unlike a single relationship's 404 (no manager), a collection's 404 isn't an empty answer.
        var graph = new FakeGraph
        {
            Answer = (request, _) => Task.FromResult(Batch(request, id => id == "u1"
                ? (404, new { error = new { code = "Request_ResourceNotFound" } })
                : (200, new { value = Array.Empty<object>() }))),
        };

        var result = await Read(Reader(graph), MemberOf, "u1", "u2");

        Assert.Equal((0, 1), (result.Refused, result.Failed));
        Assert.Equal(["u2"], result.Values.Keys);
    }

    [Fact]
    public async Task Refused_items_are_counted()
    {
        var graph = new FakeGraph
        {
            Answer = (request, _) => Task.FromResult(Batch(request, id => id == "u3"
                ? (200, new { value = Array.Empty<object>() })
                : (403, new { error = new { code = "Authorization_RequestDenied" } }))),
        };

        var result = await Read(Reader(graph), MemberOf, "u1", "u2", "u3");

        Assert.Equal(2, result.Refused);
        Assert.Equal(0, result.Failed);
        Assert.Equal(["u3"], result.Values.Keys);
    }

    [Fact]
    public async Task Foreign_next_link_fails_the_object()
    {
        var graph = new FakeGraph
        {
            Answer = (request, _) => Task.FromResult(Batch(request, _ => (200, new Dictionary<string, object>
            {
                ["value"] = new object[] { new { id = "a" } },
                ["@odata.nextLink"] = "https://evil.example/steal",
            }))),
        };

        var result = await Read(Reader(graph), MemberOf, "u1");

        Assert.Equal(1, result.Failed);
        Assert.Empty(result.Values);
        Assert.DoesNotContain(graph.Requests, r => r.Contains("evil", StringComparison.Ordinal) || r.Contains("steal", StringComparison.Ordinal));
        Assert.Single(graph.Requests);
    }

    [Fact]
    public async Task Throttled_items_are_sent_once_more()
    {
        var tries = 0;
        var graph = new FakeGraph
        {
            Answer = (request, _) => Task.FromResult(Batch(request, _ => Interlocked.Increment(ref tries) == 1
                ? (429, null)
                : (200, new { value = Array.Empty<object>() }))),
        };

        var result = await Read(Reader(graph), MemberOf, "u1");

        Assert.Equal(0, result.Failed);
        Assert.IsType<JsonArray>(result.Values["u1"]);
    }

    [Fact]
    public async Task Every_body_is_charged_to_the_lease()
    {
        var big = Enumerable.Range(0, 200).Select(i => new { id = "group-" + i, displayName = new string('x', 200) }).ToArray();
        var graph = new FakeGraph { Answer = (request, _) => Task.FromResult(Batch(request, _ => (200, new { value = big }))) };
        using var lease = new GraphFetchBudget(maxBytes: 30_000).Lease();

        var failed = await Assert.ThrowsAsync<GraphReadException>(() =>
            Reader(graph).ReadAsync("account-1", "users", MemberOf, [Obj("u1")], lease, null, CancellationToken.None));

        Assert.Equal(GraphReadFailure.TooLarge, failed.Failure);
    }

    [Fact]
    public async Task A_follow_up_page_is_charged_to_the_lease()
    {
        var big = Enumerable.Range(0, 200).Select(i => new { id = "group-" + i, displayName = new string('x', 200) }).ToArray();
        var graph = new FakeGraph
        {
            Answer = (request, _) => Task.FromResult(request.Method == HttpMethod.Post
                ? Batch(request, _ => (200, new Dictionary<string, object>
                {
                    ["value"] = new object[] { new { id = "a" } },
                    ["@odata.nextLink"] = "https://graph.microsoft.com/beta/users/u1/memberOf?$skiptoken=p2",
                }))
                : FakeGraph.Collection(big)),
        };
        using var lease = new GraphFetchBudget(maxBytes: 30_000).Lease();

        var failed = await Assert.ThrowsAsync<GraphReadException>(() =>
            Reader(graph).ReadAsync("account-1", "users", MemberOf, [Obj("u1")], lease, null, CancellationToken.None));

        Assert.Equal(GraphReadFailure.TooLarge, failed.Failure);
        Assert.Contains(graph.Requests, r => r.Contains("p2", StringComparison.Ordinal));
    }
}
