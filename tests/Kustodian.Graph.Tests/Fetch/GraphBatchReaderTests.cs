using System.Collections.Concurrent;
using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Kustodian.Graph.Fetch;
using Kustodian.Graph.Query;
using Kustodian.Graph.Schema;

namespace Kustodian.Graph.Tests;

/// <summary>Columns Graph won't serve in a list, read one object at a time through <c>$batch</c> after the list.</summary>
public sealed class GraphBatchReaderTests
{
    private const string Account = "account-1";

    /// <summary>A directory of <paramref name="count"/> applications. A list that selects <c>onPremisesPublishing</c> answers
    /// 404 with a web page (as Graph does in some tenants); <c>$batch</c> answers each item with <see cref="Item"/>.</summary>
    private sealed class Directory(int count) : HttpMessageHandler
    {
        public ConcurrentQueue<JsonObject> Batches { get; } = new();
        public Func<string, int, (int Status, object? Body, string? RetryAfter)> Item { get; set; }
            = (id, _) => (200, new { id, onPremisesPublishing = new { externalAuthenticationType = id == "3" ? "passthru" : "aadPreAuthentication" } }, null);
        private readonly ConcurrentDictionary<string, int> _tries = new();
        private int _inFlight;
        public int MaxInFlight { get; private set; }
        public int Lists { get; private set; }

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            if (request.Method == HttpMethod.Get)
            {
                Lists++;
                var query = Uri.UnescapeDataString(request.RequestUri!.OriginalString);
                if (query.Contains("onPremisesPublishing", StringComparison.Ordinal))
                    return Json(HttpStatusCode.NotFound, JsonSerializer.Serialize(new { error = new { code = "UnknownError", message = "<!DOCTYPE html><html><title>404 - File or directory not found.</title></html>" } }));
                var top = query.Contains("$top=1", StringComparison.Ordinal) && !query.Contains("$top=999", StringComparison.Ordinal) ? 1 : count;
                return Json(HttpStatusCode.OK, JsonSerializer.Serialize(new { value = Enumerable.Range(0, top).Select(i => new { id = i.ToString(), displayName = "App " + i }) }));
            }

            var inFlight = Interlocked.Increment(ref _inFlight);
            lock (this)
                MaxInFlight = Math.Max(MaxInFlight, inFlight);
            try
            {
                await Task.Delay(10, cancellationToken);
                var batch = JsonNode.Parse(await request.Content!.ReadAsStringAsync(cancellationToken))!.AsObject();
                Batches.Enqueue(batch);
                if (Item("batch", 0).Status == 500)
                    return Json(HttpStatusCode.InternalServerError, "{}");
                var responses = batch["requests"]!.AsArray().Select(r =>
                {
                    var url = r!["url"]!.GetValue<string>();
                    var id = url.Split('/')[2].Split('?')[0];
                    var (status, body, retryAfter) = Item(id, _tries.AddOrUpdate(id, 1, (_, n) => n + 1));
                    return new
                    {
                        id = r["id"]!.GetValue<string>(),
                        status,
                        headers = retryAfter is null ? null : new Dictionary<string, string> { ["Retry-After"] = retryAfter },
                        body,
                    };
                });
                return Json(HttpStatusCode.OK, JsonSerializer.Serialize(new { responses }));
            }
            finally
            {
                Interlocked.Decrement(ref _inFlight);
            }
        }
    }

    private static HttpResponseMessage Json(HttpStatusCode status, string body)
        => new(status) { Content = new StringContent(body, Encoding.UTF8, "application/json") };

    /// <summary>An <see cref="IGraphObjectCache"/> in a dictionary, keyed as the real one is: account, path, sorted columns, id.</summary>
    private sealed class Cache : IGraphObjectCache
    {
        public ConcurrentDictionary<string, GraphCachedValues> Entries { get; } = new();
        public DateTimeOffset Now { get; set; } = new(2026, 10, 20, 12, 0, 0, TimeSpan.Zero);

        public static string Key(string accountKey, string path, IReadOnlyList<string> columns, string id)
            => $"{accountKey}:{path}:{string.Join(",", columns.Order(StringComparer.Ordinal))}:{id}";

        public ValueTask<GraphCachedValues?> GetAsync(string accountKey, string path, IReadOnlyList<string> columns, string id, CancellationToken ct)
            => ValueTask.FromResult(Entries.GetValueOrDefault(Key(accountKey, path, columns, id)));

        public ValueTask SetAsync(string accountKey, string path, IReadOnlyList<string> columns, string id, string json, CancellationToken ct)
        {
            Entries[Key(accountKey, path, columns, id)] = new GraphCachedValues(json, Now);
            return ValueTask.CompletedTask;
        }

        public ValueTask RemoveAccountAsync(string accountKey, CancellationToken ct) => ValueTask.CompletedTask;

        /// <summary>Puts an application's value in, as a read at <paramref name="at"/> would have.</summary>
        public void Put(string id, string auth, DateTimeOffset at)
            => Entries[Key(Account, "applications", ["onPremisesPublishing"], id)] = new GraphCachedValues(
                JsonSerializer.Serialize(new { onPremisesPublishing = new { externalAuthenticationType = auth } }), at);
    }

    private static GraphCollectionReader Reader(HttpMessageHandler handler, IGraphObjectCache? cache = null)
        => new(new HttpClient(handler) { BaseAddress = new Uri("https://graph.microsoft.com/beta/") }, new GraphFetchBudget(),
            cache ?? NoGraphObjectCache.Instance);

    private static GraphFetch Fetch(string[] select, string[] named, string[]? unreadable = null)
        => new(new GraphTable("applications", "applications", "microsoft.graph.application", "", "https://learn.microsoft.com/x", []), select, null)
        {
            Named = named,
            Unreadable = unreadable ?? [],
        };

    private static Task<GraphCollection> Read(HttpMessageHandler handler, GraphFetch fetch, IGraphObjectCache? cache = null, bool refresh = false)
        => Reader(handler, cache).ReadAsync(Account, fetch, new GraphFetchBudget().Lease(), refresh, CancellationToken.None);

    private static GraphFetch Publishing() => Fetch(["id", "onPremisesPublishing"], ["onPremisesPublishing"]);

    private static string? Auth(JsonObject o) => o["onPremisesPublishing"]?["externalAuthenticationType"]?.GetValue<string>();

    [Fact]
    public async Task A_named_column_graph_refuses_in_a_list_is_read_one_object_at_a_time()
    {
        var graph = new Directory(45);

        var result = await Read(graph, Fetch(["id", "displayName", "onPremisesPublishing"], ["displayName", "onPremisesPublishing"]));

        Assert.Equal(45, result.Objects.Count);
        Assert.Equal("passthru", Auth(result.Objects.Single(o => o["id"]!.GetValue<string>() == "3")));
        Assert.All(result.Objects, o => Assert.NotNull(Auth(o)));
        Assert.Equal(["onPremisesPublishing"], result.PerObject);
        Assert.Empty(result.Unreadable);
        Assert.Equal(0, result.PerObjectFailed);
        Assert.False(result.PerObjectCapped);
        // 20 per batch, at most 4 at once, each item a GET of one object with id and the column.
        Assert.Equal([5, 20, 20], graph.Batches.Select(b => b["requests"]!.AsArray().Count).Order());
        Assert.True(graph.MaxInFlight <= GraphBatchReader.BatchesInFlight);
        var item = graph.Batches.First()["requests"]![0]!;
        Assert.Equal("GET", item["method"]!.GetValue<string>());
        Assert.Matches(@"^/applications/\d+\?\$select=id%2ConPremisesPublishing$", item["url"]!.GetValue<string>());
        Assert.Equal("applications/{id}?$select=id%2ConPremisesPublishing", result.Requests[^1]);
    }

    [Fact]
    public async Task A_get_only_column_the_plan_left_out_is_read_one_object_at_a_time()
    {
        var graph = new Directory(2);

        var result = await Read(graph, Fetch(["id", "displayName"], ["onPremisesPublishing"], unreadable: ["onPremisesPublishing"]));

        Assert.Equal(1, graph.Lists);   // no probing: the plan knew
        Assert.All(result.Objects, o => Assert.NotNull(Auth(o)));
        Assert.Equal(["onPremisesPublishing"], result.PerObject);
        Assert.Empty(result.Unreadable);
    }

    [Fact]
    public async Task A_column_the_query_only_passes_through_stays_empty_and_unread()
    {
        var graph = new Directory(3);

        var result = await Read(graph, Fetch(["id", "displayName", "onPremisesPublishing"], named: []));

        Assert.Empty(graph.Batches);
        Assert.Equal(["onPremisesPublishing"], result.Unreadable);
        Assert.Empty(result.PerObject);
        Assert.All(result.Objects, o => Assert.Null(o["onPremisesPublishing"]));
    }

    [Fact]
    public async Task Over_the_object_cap_the_columns_stay_empty_and_the_cap_is_reported()
    {
        var graph = new Directory(GraphBatchReader.MaxObjects + 1);

        var result = await Read(graph, Fetch(["id", "onPremisesPublishing"], ["onPremisesPublishing"]));

        Assert.Empty(graph.Batches);
        Assert.Equal(GraphBatchReader.MaxObjects + 1, result.Objects.Count);
        Assert.True(result.PerObjectCapped);
        Assert.Equal(["onPremisesPublishing"], result.Unreadable);
        Assert.Empty(result.PerObject);
        Assert.DoesNotContain(result.Requests, r => r.Contains("{id}", StringComparison.Ordinal));
    }

    [Fact]
    public async Task At_the_object_cap_every_object_is_read()
    {
        var graph = new Directory(GraphBatchReader.MaxObjects);

        var result = await Read(graph, Fetch(["id", "onPremisesPublishing"], ["onPremisesPublishing"]));

        Assert.False(result.PerObjectCapped);
        Assert.Equal(GraphBatchReader.MaxObjects / GraphBatchReader.BatchSize, graph.Batches.Count);
        Assert.All(result.Objects, o => Assert.NotNull(Auth(o)));
    }

    [Fact]
    public async Task Failed_items_stay_empty_and_are_counted()
    {
        var graph = new Directory(5)
        {
            Item = (id, _) => id switch
            {
                "1" => (404, new { error = new { code = "Request_ResourceNotFound", message = "gone" } }, null),
                "2" => (403, new { error = new { code = "Authorization_RequestDenied", message = "no" } }, null),
                _ => (200, new { id, onPremisesPublishing = new { externalAuthenticationType = "passthru" } }, null),
            },
        };

        var result = await Read(graph, Fetch(["id", "onPremisesPublishing"], ["onPremisesPublishing"]));

        Assert.Equal(2, result.PerObjectFailed);
        Assert.Equal(["onPremisesPublishing"], result.PerObject);
        Assert.Equal(["0", "3", "4"], result.Objects.Where(o => Auth(o) is not null).Select(o => o["id"]!.GetValue<string>()));
    }

    [Fact]
    public async Task A_batch_graph_doesnt_answer_counts_all_its_items()
    {
        var graph = new Directory(25) { Item = (_, _) => (500, null, null) };

        var result = await Read(graph, Fetch(["id", "onPremisesPublishing"], ["onPremisesPublishing"]));

        Assert.Equal(25, result.Objects.Count);
        Assert.Equal(25, result.PerObjectFailed);
        Assert.All(result.Objects, o => Assert.Null(Auth(o)));
    }

    [Fact]
    public async Task A_throttled_item_is_sent_once_more_then_counted()
    {
        var graph = new Directory(3)
        {
            Item = (id, tries) => id switch
            {
                "1" when tries == 1 => (429, null, "0"),
                "2" => (429, null, "0"),
                _ => (200, new { id, onPremisesPublishing = new { externalAuthenticationType = "passthru" } }, null),
            },
        };

        var result = await Read(graph, Fetch(["id", "onPremisesPublishing"], ["onPremisesPublishing"]));

        Assert.Equal(1, result.PerObjectFailed);
        Assert.Equal(["0", "1"], result.Objects.Where(o => Auth(o) is not null).Select(o => o["id"]!.GetValue<string>()));
        Assert.Equal(2, graph.Batches.Count);
    }

    [Fact]
    public async Task A_second_read_takes_the_values_from_the_cache_and_sends_no_batch()
    {
        var cache = new Cache();
        var graph = new Directory(45);
        await Read(graph, Publishing(), cache);
        var sent = graph.Batches.Count;

        var result = await Read(graph, Publishing(), cache);

        Assert.Equal(sent, graph.Batches.Count);
        Assert.Equal("passthru", Auth(result.Objects.Single(o => o["id"]!.GetValue<string>() == "3")));
        Assert.All(result.Objects, o => Assert.NotNull(Auth(o)));
        Assert.Equal(45, result.PerObjectCached);
        Assert.Equal(cache.Now, result.PerObjectCachedAt);
        Assert.Equal(["onPremisesPublishing"], result.PerObject);
        // Nothing was sent one object at a time, so no such request is shown.
        Assert.DoesNotContain(result.Requests, r => r.Contains("{id}", StringComparison.Ordinal));
    }

    [Fact]
    public async Task A_refresh_reads_every_object_from_graph_and_refills_the_cache()
    {
        var cache = new Cache();
        var graph = new Directory(5);
        await Read(graph, Publishing(), cache);
        graph.Item = (id, _) => (200, new { id, onPremisesPublishing = new { externalAuthenticationType = "fixed" } }, null);

        var result = await Read(graph, Publishing(), cache, refresh: true);

        Assert.Equal(2, graph.Batches.Count);
        Assert.Equal(0, result.PerObjectCached);
        Assert.Null(result.PerObjectCachedAt);
        Assert.All(result.Objects, o => Assert.Equal("fixed", Auth(o)));
        var after = await Read(graph, Publishing(), cache);
        Assert.Equal(2, graph.Batches.Count);
        Assert.All(after.Objects, o => Assert.Equal("fixed", Auth(o)));
    }

    [Fact]
    public async Task Cached_and_uncached_objects_mix_and_only_the_uncached_are_read()
    {
        var cache = new Cache();
        var old = cache.Now.AddMinutes(-12);
        cache.Put("0", "cached", old);
        cache.Put("4", "cached", cache.Now.AddMinutes(-3));
        var graph = new Directory(6);

        var result = await Read(graph, Publishing(), cache);

        var sent = graph.Batches.SelectMany(b => b["requests"]!.AsArray()).Select(r => r!["url"]!.GetValue<string>().Split('/')[2].Split('?')[0]);
        Assert.Equal(["1", "2", "3", "5"], sent.Order());
        Assert.Equal(["cached", "aadPreAuthentication", "aadPreAuthentication", "passthru", "cached", "aadPreAuthentication"],
            result.Objects.Select(Auth));
        Assert.Equal(2, result.PerObjectCached);
        Assert.Equal(old, result.PerObjectCachedAt);
        Assert.Equal("applications/{id}?$select=id%2ConPremisesPublishing", result.Requests[^1]);
        Assert.Equal(6, cache.Entries.Count);
    }

    [Fact]
    public async Task The_object_cap_counts_only_the_objects_not_in_the_cache()
    {
        var cache = new Cache();
        foreach (var i in Enumerable.Range(0, 10))
            cache.Put(i.ToString(), "cached", cache.Now);
        var graph = new Directory(GraphBatchReader.MaxObjects + 10);

        var result = await Read(graph, Publishing(), cache);

        Assert.False(result.PerObjectCapped);
        Assert.Equal(GraphBatchReader.MaxObjects / GraphBatchReader.BatchSize, graph.Batches.Count);
        Assert.Equal(10, result.PerObjectCached);
        Assert.All(result.Objects, o => Assert.NotNull(Auth(o)));
    }

    [Fact]
    public async Task Over_the_cap_of_uncached_objects_none_is_merged_from_the_cache()
    {
        var cache = new Cache();
        cache.Put("0", "cached", cache.Now);
        var graph = new Directory(GraphBatchReader.MaxObjects + 2);

        var result = await Read(graph, Publishing(), cache);

        Assert.True(result.PerObjectCapped);
        Assert.Empty(graph.Batches);
        Assert.Equal(0, result.PerObjectCached);
        Assert.All(result.Objects, o => Assert.Null(Auth(o)));
    }

    [Fact]
    public async Task Failed_items_are_never_cached()
    {
        var cache = new Cache();
        var graph = new Directory(4)
        {
            Item = (id, _) => id switch
            {
                "1" => (404, new { error = new { code = "Request_ResourceNotFound", message = "gone" } }, null),
                "2" => (429, null, "0"),
                _ => (200, new { id, onPremisesPublishing = new { externalAuthenticationType = "passthru" } }, null),
            },
        };

        await Read(graph, Publishing(), cache);

        Assert.Equal([Cache.Key(Account, "applications", ["onPremisesPublishing"], "0"), Cache.Key(Account, "applications", ["onPremisesPublishing"], "3")],
            cache.Entries.Keys.Order());
        var again = await Read(graph, Publishing(), cache);
        Assert.Equal(2, again.PerObjectCached);
        Assert.Equal(2, again.PerObjectFailed);
    }
}
