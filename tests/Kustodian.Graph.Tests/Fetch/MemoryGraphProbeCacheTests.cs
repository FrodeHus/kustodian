using Kustodian.Graph.Fetch;
using Kustodian.Graph.Run;
using Microsoft.Extensions.Time.Testing;

namespace Kustodian.Graph.Tests;

public sealed class MemoryGraphProbeCacheTests
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task Findings_are_kept_for_the_ttl_then_forgotten()
    {
        var time = new FakeTimeProvider(new DateTimeOffset(2026, 10, 21, 12, 0, 0, TimeSpan.Zero));
        var cache = new MemoryGraphProbeCache(time);
        await cache.SetAsync("a", "auditLogs/signIns", ["status"], ["mfaDetail"], Ct);

        time.Advance(GraphLimits.Default.ProbeCacheTtl - TimeSpan.FromSeconds(1));
        var kept = await cache.GetAsync("a", "auditLogs/signIns", Ct);
        time.Advance(TimeSpan.FromSeconds(1));

        Assert.Equal(["status"], kept!.NotListed);
        Assert.Equal(["mfaDetail"], kept.Denied);
        Assert.Equal(time.Start, kept.FoundAt);
        Assert.Null(await cache.GetAsync("a", "auditLogs/signIns", Ct));
    }

    [Fact]
    public async Task Default_columns_are_kept_for_the_ttl_and_listed_per_account()
    {
        var time = new FakeTimeProvider();
        var cache = new MemoryGraphProbeCache(time);
        await cache.SetDefaultsAsync("a", "users", ["id", "displayName"], Ct);
        await cache.SetDefaultsAsync("b", "groups", ["id"], Ct);

        Assert.Equal(["id", "displayName"], (await cache.GetDefaultsAsync("a", "users", Ct))!.Columns);
        Assert.Equal(["users"], (await cache.DefaultsOfAsync("a", Ct)).Keys);
        time.Advance(GraphLimits.Default.ProbeCacheTtl);
        Assert.Null(await cache.GetDefaultsAsync("a", "users", Ct));
        Assert.Empty(await cache.DefaultsOfAsync("a", Ct));
    }

    [Fact]
    public async Task Setting_nothing_forgets_the_table()
    {
        var cache = new MemoryGraphProbeCache(new FakeTimeProvider());
        await cache.SetAsync("a", "users", ["x"], [], Ct);

        await cache.SetAsync("a", "users", [], [], Ct);

        Assert.Null(await cache.GetAsync("a", "users", Ct));
    }

    [Fact]
    public async Task Removing_an_account_keeps_the_others()
    {
        var cache = new MemoryGraphProbeCache(new FakeTimeProvider());
        await cache.SetAsync("a", "users", ["x"], [], Ct);
        await cache.SetAsync("b", "users", ["x"], [], Ct);

        await cache.RemoveAccountAsync("a", Ct);

        Assert.Null(await cache.GetAsync("a", "users", Ct));
        Assert.NotNull(await cache.GetAsync("b", "users", Ct));
        await cache.ClearAsync(Ct);
        Assert.Null(await cache.GetAsync("b", "users", Ct));
    }
    [Fact]
    public async Task A_top_refusal_is_kept_per_account_until_the_ttl_or_it_is_forgotten()
    {
        var time = new FakeTimeProvider();
        var cache = new MemoryGraphProbeCache(time);
        await cache.SetRefusesTopAsync("a", "users", true, Ct);

        Assert.True(await cache.RefusesTopAsync("a", "users", Ct));
        Assert.False(await cache.RefusesTopAsync("b", "users", Ct));
        await cache.SetRefusesTopAsync("a", "users", false, Ct);
        Assert.False(await cache.RefusesTopAsync("a", "users", Ct));

        await cache.SetRefusesTopAsync("a", "users", true, Ct);
        time.Advance(GraphLimits.Default.ProbeCacheTtl);
        Assert.False(await cache.RefusesTopAsync("a", "users", Ct));

        await cache.SetRefusesTopAsync("a", "users", true, Ct);
        await cache.RemoveAccountAsync("a", Ct);
        Assert.False(await cache.RefusesTopAsync("a", "users", Ct));
    }
}
