using System.Globalization;
using System.Net;
using System.Text;
using Kustodian.Graph.Engine;
using Kustodian.Graph.Fetch;
using Kustodian.Graph.Query;
using Kustodian.Graph.Run;
using Kustodian.Graph.Schema;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Time.Testing;

namespace Kustodian.Graph.Tests.Run;

/// <summary>The limits the reader, the per-object reads, the runner and the object cache take from <see cref="GraphLimits"/>.</summary>
public sealed class GraphLimitsTests
{
    private const string Account = "account-1";
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static readonly string WorkerDll = Path.Combine(AppContext.BaseDirectory, "engine-worker", "Kustodian.EngineWorker.dll");

    private static readonly GraphTable Applications =
        new("applications", "applications", "microsoft.graph.application", "", "https://learn.microsoft.com/x", []);

    private static GraphCollectionReader Reader(FakeGraph graph, GraphLimits limits)
        => new(new HttpClient(graph) { BaseAddress = new Uri("https://graph.microsoft.com/beta/") }, new GraphFetchBudget(),
            NoGraphObjectCache.Instance, limits);

    private static object[] Ids(int from, int count)
        => [.. Enumerable.Range(from, count).Select(i => (object)new { id = i.ToString(CultureInfo.InvariantCulture) })];

    [Fact]
    public void Defaults_are_the_spec_limits()
    {
        var limits = GraphLimits.Default;

        Assert.Equal(50_000, limits.ObjectsPerTable);
        Assert.Equal(512L << 20, limits.FetchBudgetBytes);
        Assert.Equal(2_000, limits.PerObjectReadsPerTable);
        Assert.Equal(TimeSpan.FromMinutes(30), limits.PerObjectCacheTtl);
        Assert.Equal(50_000, limits.RowsPerRun);
    }

    [Fact]
    public async Task Reader_uses_limits_object_cap()
    {
        var graph = new FakeGraph();
        graph.Answer = (request, _) =>
        {
            // Pages of 600 until there are more than 1,000.
            var page = request.RequestUri!.Query.Contains("page=", StringComparison.Ordinal)
                ? int.Parse(request.RequestUri.Query.Split("page=")[1], CultureInfo.InvariantCulture)
                : 0;
            return Task.FromResult(FakeGraph.Page(Ids(page * 600, 600),
                $"https://graph.microsoft.com/beta/applications?page={page + 1}"));
        };
        var reader = Reader(graph, GraphLimits.Default with { ObjectsPerTable = 1_000 });

        var ex = await Assert.ThrowsAsync<GraphReadException>(() =>
            reader.ReadAsync(Account, new GraphFetch(Applications, ["id"], null), new GraphFetchBudget().Lease(), false, Ct));

        Assert.Equal(GraphReadFailure.TooManyObjects, ex.Failure);
        Assert.Equal("applications has more than 1,000 objects. Add a `where` Graph can filter on (see the schema list).", ex.Message);
        Assert.Equal(2, graph.Requests.Count);
    }

    [Theory]
    [InlineData(3, false)]
    [InlineData(2, true)]
    public async Task Batch_reader_uses_limits_per_object_cap(int cap, bool capped)
    {
        var graph = new FakeGraph();
        graph.Answer = (request, _) => Task.FromResult(request.Method == HttpMethod.Post
            ? new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("{\"responses\":[]}", Encoding.UTF8, "application/json") }
            : FakeGraph.Collection(Ids(0, 3)));
        var reader = Reader(graph, GraphLimits.Default with { PerObjectReadsPerTable = cap });
        var fetch = new GraphFetch(Applications, ["id"], null) { Named = ["onPremisesPublishing"], Unreadable = ["onPremisesPublishing"] };

        var result = await reader.ReadAsync(Account, fetch, new GraphFetchBudget().Lease(), false, Ct);

        Assert.Equal(capped, result.PerObjectCapped);
        Assert.Equal(capped ? 0 : 1, graph.Requests.Count(r => r.EndsWith("$batch", StringComparison.Ordinal)));
    }

    [Fact]
    public async Task Runner_caps_rows_at_limits_rows_per_run()
    {
        var options = new GraphEngineOptions { Workers = 1, WorkerPath = WorkerDll, WorkerArgs = [] };
        await using var engine = new GraphEnginePool(options, NullLogger<GraphEnginePool>.Instance, TimeProvider.System);
        var limits = GraphLimits.Default with { RowsPerRun = 1_000 };
        var budget = new GraphFetchBudget();
        var runner = new GraphRunner(GraphSchemaCatalog.Beta, Reader(new FakeGraph(), limits), budget, engine, limits, TimeProvider.System);

        var r = await runner.RunAsync(Account, "range x from 1 to 1500 step 1", refresh: false, progress: null, Ct);

        Assert.Equal(RunOutcome.Ok, r.Outcome);
        Assert.Equal(1_000, r.Rows.Count);
        Assert.Equal(1_500, r.Total);
    }

    [Fact]
    public async Task Cache_ttl_comes_from_limits()
    {
        var time = new FakeTimeProvider();
        var cache = new MemoryGraphObjectCache(time, GraphLimits.Default with { PerObjectCacheTtl = TimeSpan.FromMinutes(5) });
        await cache.SetAsync(Account, "applications", ["a"], "1", "{}", Ct);

        time.Advance(TimeSpan.FromMinutes(5) - TimeSpan.FromSeconds(1));
        var before = await cache.GetAsync(Account, "applications", ["a"], "1", Ct);
        time.Advance(TimeSpan.FromSeconds(1));
        var after = await cache.GetAsync(Account, "applications", ["a"], "1", Ct);

        Assert.NotNull(before);
        Assert.Null(after);
    }
}
