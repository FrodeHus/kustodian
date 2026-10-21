using Kustodian.Graph.Fetch;
using Kustodian.Graph.Run;
using Microsoft.Extensions.Time.Testing;

namespace Kustodian.Graph.Tests;

public sealed class MemoryGraphObjectCacheTests
{
    private static readonly string[] Columns = ["b", "a"];
    private static readonly GraphLimits OneMinute = GraphLimits.Default with { PerObjectCacheTtl = TimeSpan.FromMinutes(1) };

    [Fact]
    public async Task Entries_expire_after_30_minutes()
    {
        var time = new FakeTimeProvider(new DateTimeOffset(2026, 10, 21, 12, 0, 0, TimeSpan.Zero));
        var cache = new MemoryGraphObjectCache(time);
        await cache.SetAsync("acc", "applications", Columns, "1", "{\"a\":1}", CancellationToken.None);

        time.Advance(TimeSpan.FromMinutes(29) + TimeSpan.FromSeconds(59));
        var before = await cache.GetAsync("acc", "applications", Columns, "1", CancellationToken.None);
        time.Advance(TimeSpan.FromSeconds(1));
        var after = await cache.GetAsync("acc", "applications", Columns, "1", CancellationToken.None);

        Assert.Equal("{\"a\":1}", before?.Json);
        Assert.Equal(new DateTimeOffset(2026, 10, 21, 12, 0, 0, TimeSpan.Zero), before?.ReadAt);
        Assert.Null(after);
    }

    [Fact]
    public async Task Entries_use_the_ttl_given()
    {
        var time = new FakeTimeProvider();
        var cache = new MemoryGraphObjectCache(time, OneMinute);
        await cache.SetAsync("acc", "applications", Columns, "1", "{}", CancellationToken.None);

        time.Advance(TimeSpan.FromMinutes(1));

        Assert.Null(await cache.GetAsync("acc", "applications", Columns, "1", CancellationToken.None));
    }

    [Fact]
    public async Task Columns_match_in_any_order_and_accounts_stay_apart()
    {
        var cache = new MemoryGraphObjectCache(new FakeTimeProvider());
        await cache.SetAsync("acc", "applications", ["a", "b"], "1", "{}", CancellationToken.None);

        Assert.NotNull(await cache.GetAsync("acc", "applications", ["b", "a"], "1", CancellationToken.None));
        Assert.Null(await cache.GetAsync("other", "applications", ["a", "b"], "1", CancellationToken.None));
        Assert.Null(await cache.GetAsync("acc", "applications", ["a"], "1", CancellationToken.None));
        Assert.Null(await cache.GetAsync("acc", "applications", ["a", "b"], "2", CancellationToken.None));
    }

    [Fact]
    public async Task Setting_an_entry_sweeps_the_expired_ones()
    {
        var time = new FakeTimeProvider();
        var cache = new MemoryGraphObjectCache(time, OneMinute);
        await cache.SetAsync("acc", "applications", Columns, "old", "{}", CancellationToken.None);
        time.Advance(TimeSpan.FromSeconds(30));
        await cache.SetAsync("acc", "applications", Columns, "mid", "{}", CancellationToken.None);
        time.Advance(TimeSpan.FromSeconds(31));

        await cache.SetAsync("acc", "applications", Columns, "new", "{}", CancellationToken.None);

        Assert.Equal(2, cache.Count);
    }

    [Fact]
    public async Task Clear_removes_everything()
    {
        var cache = new MemoryGraphObjectCache(new FakeTimeProvider());
        await cache.SetAsync("acc", "applications", Columns, "1", "{}", CancellationToken.None);
        await cache.SetAsync("other", "groups", Columns, "2", "{}", CancellationToken.None);

        cache.Clear();

        Assert.Null(await cache.GetAsync("acc", "applications", Columns, "1", CancellationToken.None));
        Assert.Null(await cache.GetAsync("other", "groups", Columns, "2", CancellationToken.None));
    }

    [Fact]
    public async Task RemoveAccount_removes_only_that_accounts_entries()
    {
        var cache = new MemoryGraphObjectCache(new FakeTimeProvider());
        await cache.SetAsync("acc", "applications", Columns, "1", "{}", CancellationToken.None);
        await cache.SetAsync("acc:2", "applications", Columns, "1", "{}", CancellationToken.None);

        await cache.RemoveAccountAsync("acc", CancellationToken.None);

        Assert.Null(await cache.GetAsync("acc", "applications", Columns, "1", CancellationToken.None));
        Assert.NotNull(await cache.GetAsync("acc:2", "applications", Columns, "1", CancellationToken.None));
    }
}
