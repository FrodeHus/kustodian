using System.Collections.Concurrent;
using System.Globalization;
using System.Net;
using System.Text.Json;
using System.Text.Json.Nodes;
using Kustodian.Graph.Fetch;
using Kustodian.Graph.Query;
using Kustodian.Graph.Run;
using Kustodian.Graph.Schema;
using Kustodian.Graph.Tests.Run;
using Microsoft.Extensions.Time.Testing;

namespace Kustodian.Graph.Tests;

/// <summary>Relationship columns (<c>owners</c>) read through their own reader, cap and cache entries, beside the get-only
/// properties read one object at a time.</summary>
public sealed partial class GraphCollectionReaderTests
{
    private static readonly GraphTable FixtureApplications = TestSchemas.Fixture().Tables.Single(t => t.Name == "applications");

    private static GraphFetch Naming(string? filter, params string[] named)
        => new(FixtureApplications, ["id", "displayName"], filter) { Named = named, Unreadable = named };

    /// <summary>Graph with <paramref name="count"/> applications <c>a0</c>…: a list with a <c>$filter</c> is refused when
    /// <paramref name="refusesFilter"/>; in a <c>$batch</c>, <c>owners</c> answers two owners per object and a property read
    /// answers <c>getOnlyGroup</c>.</summary>
    private static FakeGraph Applications(int count, bool refusesFilter = false) => new()
    {
        Answer = (request, _) =>
        {
            if (request.Method == HttpMethod.Get)
                return Task.FromResult(refusesFilter && request.RequestUri!.OriginalString.Contains("$filter", StringComparison.Ordinal)
                    ? FakeGraph.Error(HttpStatusCode.BadRequest, "Request_UnsupportedQuery", "Unsupported or invalid query filter clause.")
                    : FakeGraph.Collection(Enumerable.Range(0, count).Select(i => new { id = "a" + i.ToString(CultureInfo.InvariantCulture), displayName = "App" })));
            using var batch = JsonDocument.Parse(request.Content!.ReadAsStringAsync().GetAwaiter().GetResult());
            var responses = batch.RootElement.GetProperty("requests").EnumerateArray().Select(item =>
            {
                var url = item.GetProperty("url").GetString()!;
                var id = url.Split('/')[2].Split('?')[0];
                object body = url.Contains("/owners?", StringComparison.Ordinal)
                    ? new
                    {
                        value = new object[]
                        {
                            new Dictionary<string, object> { ["@odata.type"] = "#microsoft.graph.user", ["id"] = id + "-u1", ["displayName"] = "One" },
                            new Dictionary<string, object> { ["@odata.type"] = "#microsoft.graph.user", ["id"] = id + "-u2" },
                        },
                    }
                    : new { id, getOnlyGroup = true };
                return new { id = item.GetProperty("id").GetString(), status = 200, body };
            }).ToList();
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(JsonSerializer.Serialize(new { responses }), System.Text.Encoding.UTF8, "application/json"),
            });
        },
    };

    private static GraphCollectionReader RelationshipReader(FakeGraph graph, IGraphObjectCache? cache = null, GraphLimits? limits = null)
        => new(new HttpClient(graph) { BaseAddress = new Uri("https://graph.microsoft.com/beta/") }, new GraphFetchBudget(),
            cache ?? NoGraphObjectCache.Instance, limits ?? GraphLimits.Default, time: new InstantTime());

    /// <summary>The bodies of the <c>$batch</c>es <paramref name="graph"/> answers from now on.</summary>
    private static ConcurrentQueue<string> Batches(FakeGraph graph)
    {
        var batches = new ConcurrentQueue<string>();
        var answer = graph.Answer;
        graph.Answer = async (request, ct) =>
        {
            if (request.Method == HttpMethod.Post)
                batches.Enqueue(Uri.UnescapeDataString(await request.Content!.ReadAsStringAsync(ct)));
            return await answer(request, ct);
        };
        return batches;
    }

    private static bool IsBatch(string request) => request.Contains("$batch", StringComparison.Ordinal);

    [Fact]
    public async Task Relationship_reads_only_listed_objects()
    {
        var graph = Applications(2);
        var batches = Batches(graph);

        var result = await Read(RelationshipReader(graph), Naming("displayName eq 'App'", "owners"));

        var sent = Assert.Single(batches);
        Assert.Contains("/applications/a0/owners?", sent);
        Assert.Contains("/applications/a1/owners?", sent);
        Assert.All(result.Objects, o => Assert.Equal(2, Assert.IsType<JsonArray>(o["owners"]).Count));
        Assert.Equal("""{"id":"a0-u1","objectType":"user","displayName":"One"}""", result.Objects[0]["owners"]![0]!.ToJsonString());
        Assert.Contains(GraphRelationshipReader.Template("applications", "owners", true), result.Requests);
        Assert.Empty(result.PerObject);
        Assert.False(result.PerObjectCapped);
        var outcome = Assert.Single(result.Relationships);
        // Each object's second owner came back without a displayName: limited information.
        Assert.Equal(new GraphRelationshipOutcome("owners", 2, 0, 0, 0, false, 0, 2), outcome);
    }

    [Fact]
    public async Task Relationship_over_its_own_cap_stays_empty()
    {
        var graph = Applications(101);
        var batches = Batches(graph);

        var result = await Read(RelationshipReader(graph), Naming(null, "owners", "getOnlyGroup"));

        Assert.NotEmpty(batches);
        Assert.All(batches, b => Assert.DoesNotContain("/owners", b));
        Assert.DoesNotContain(result.Requests, r => r.Contains("/owners", StringComparison.Ordinal));
        var outcome = Assert.Single(result.Relationships);
        Assert.True(outcome.Capped);
        Assert.Equal(101, outcome.Objects);
        Assert.All(result.Objects, o => Assert.False(o.ContainsKey("owners")));
        // The property column on the same objects is under its own cap (2,000): read.
        Assert.Equal(["getOnlyGroup"], result.PerObject);
        Assert.False(result.PerObjectCapped);
        Assert.All(result.Objects, o => Assert.True(o["getOnlyGroup"]!.GetValue<bool>()));
    }

    [Fact]
    public async Task Relationship_and_property_cache_entries_do_not_mix()
    {
        var cache = new MemoryGraphObjectCache(new FakeTimeProvider(DateTimeOffset.UtcNow));
        var limits = GraphLimits.Default with { RelationshipEntriesPerObject = 1 };
        // A property-style entry under the relationship's own name must never be served for the relationship.
        await cache.SetAsync(Account, "applications", ["owners"], "a0", """{"owners":"a property"}""", CancellationToken.None);

        var property = Applications(1);
        await Read(RelationshipReader(property, cache, limits), Naming(null, "getOnlyGroup"));
        Assert.Contains(property.Requests, IsBatch);

        var first = Applications(1);
        var read = await Read(RelationshipReader(first, cache, limits), Naming(null, "owners"));
        Assert.Contains(first.Requests, IsBatch);
        Assert.Equal(new GraphRelationshipOutcome("owners", 1, 1, 0, 0, false, 0, 0), Assert.Single(read.Relationships));

        var second = Applications(1);
        var cached = await Read(RelationshipReader(second, cache, limits), Naming(null, "owners"));
        Assert.DoesNotContain(second.Requests, IsBatch);
        Assert.Equal(new GraphRelationshipOutcome("owners", 1, 1, 0, 0, false, 1, 0), Assert.Single(cached.Relationships));
        Assert.Single(Assert.IsType<JsonArray>(cached.Objects[0]["owners"]));
        Assert.Equal(0, cached.PerObjectCached);

        // And the reverse: the property entries are as they were.
        var entry = await cache.GetAsync(Account, "applications", ["owners"], "a0", CancellationToken.None);
        Assert.Equal("""{"owners":"a property"}""", entry!.Json);
    }

    [Fact]
    public async Task Entries_without_a_display_name_are_counted_as_limited_also_from_the_cache()
    {
        // Graph answers a directory object of a type the account can't read with only @odata.type and id.
        var cache = new MemoryGraphObjectCache(new FakeTimeProvider(DateTimeOffset.UtcNow));

        var read = await Read(RelationshipReader(Applications(1), cache), Naming(null, "owners"));
        Assert.Equal(1, Assert.Single(read.Relationships).Limited);

        var again = Applications(1);
        var cached = await Read(RelationshipReader(again, cache), Naming(null, "owners"));
        Assert.DoesNotContain(again.Requests, IsBatch);
        var outcome = Assert.Single(cached.Relationships);
        Assert.Equal(1, outcome.Cached);
        Assert.Equal(1, outcome.Limited);
    }

    [Fact]
    public async Task Capped_and_unfiltered_together()
    {
        var graph = Applications(150, refusesFilter: true);

        var result = await Read(RelationshipReader(graph), Naming("displayName eq 'App'", "owners"));

        Assert.True(result.Unfiltered);
        Assert.DoesNotContain(graph.Requests, IsBatch);
        Assert.True(Assert.Single(result.Relationships).Capped);
        Assert.False(result.PerObjectCapped);
    }

    [Fact]
    public async Task Refresh_skips_the_relationship_cache()
    {
        var cache = new MemoryGraphObjectCache(new FakeTimeProvider(DateTimeOffset.UtcNow));
        await Read(RelationshipReader(Applications(1), cache), Naming(null, "owners"));

        var again = Applications(1);
        var result = await Read(RelationshipReader(again, cache), Naming(null, "owners"), refresh: true);

        Assert.Contains(again.Requests, IsBatch);
        Assert.Equal(0, Assert.Single(result.Relationships).Cached);
    }

    [Fact]
    public async Task Diagnostics_name_the_relationship()
    {
        var diagnostics = new RunDiagnostics(TimeProvider.System);

        await Read(RelationshipReader(Applications(2)), Naming(null, "owners"), diagnostics: diagnostics);

        Assert.Contains(OfKind(diagnostics, DiagnosticKinds.PerObject), e => e.Detail.Contains("applications.owners", StringComparison.Ordinal));
    }
}
