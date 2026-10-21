using Kustodian.Graph.Run;
using Kustodian.Storage;
using Microsoft.Extensions.Time.Testing;

namespace Kustodian.Tests.Storage;

/// <summary>What probing found, kept in <c>graph-probes.json</c> so it outlasts the app: a restarted app doesn't probe again.</summary>
public sealed class FileGraphProbeCacheTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "kustodian-tests-" + Guid.NewGuid().ToString("N"));
    private readonly FakeTimeProvider _time = new(new DateTimeOffset(2026, 10, 21, 12, 0, 0, TimeSpan.Zero));
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    public void Dispose()
    {
        if (Directory.Exists(_dir))
        {
            Directory.Delete(_dir, recursive: true);
        }
    }

    private FileGraphProbeCache Cache() => new(new JsonFileStore(_dir), _time);

    [Fact]
    public async Task Findings_outlast_the_app()
    {
        await Cache().SetAsync("account-1", "auditLogs/signIns", ["mfaDetail"], ["riskEventTypes"], Ct);

        var read = await Cache().GetAsync("account-1", "auditLogs/signIns", Ct);

        Assert.NotNull(read);
        Assert.Equal(["mfaDetail"], read.NotListed);
        Assert.Equal(["riskEventTypes"], read.Denied);
        Assert.Equal(_time.GetUtcNow(), read.FoundAt);
        Assert.Null(await Cache().GetAsync("account-2", "auditLogs/signIns", Ct));
    }

    [Fact]
    public async Task Findings_expire_after_the_ttl()
    {
        await Cache().SetAsync("account-1", "users", ["x"], [], Ct);

        _time.Advance(GraphLimits.Default.ProbeCacheTtl);

        Assert.Null(await Cache().GetAsync("account-1", "users", Ct));
    }

    [Fact]
    public async Task Removing_an_account_and_clearing_are_kept_too()
    {
        var cache = Cache();
        await cache.SetAsync("account-1", "users", ["x"], [], Ct);
        await cache.SetAsync("account-2", "users", ["y"], [], Ct);

        await cache.RemoveAccountAsync("account-1", Ct);
        Assert.Null(await Cache().GetAsync("account-1", "users", Ct));
        Assert.NotNull(await Cache().GetAsync("account-2", "users", Ct));

        await cache.ClearAsync(Ct);
        Assert.Null(await Cache().GetAsync("account-2", "users", Ct));
    }

    [Fact]
    public async Task Default_columns_outlast_the_app_and_are_listed_per_account()
    {
        await Cache().SetDefaultsAsync("account-1", "auditLogs/signIns", ["id", "createdDateTime"], Ct);
        await Cache().SetDefaultsAsync("account-2", "users", ["id"], Ct);

        var read = await Cache().GetDefaultsAsync("account-1", "auditLogs/signIns", Ct);
        var of = await Cache().DefaultsOfAsync("account-1", Ct);

        Assert.Equal(["id", "createdDateTime"], read!.Columns);
        Assert.Equal(["auditLogs/signIns"], of.Keys);
        _time.Advance(GraphLimits.Default.ProbeCacheTtl);
        Assert.Null(await Cache().GetDefaultsAsync("account-1", "auditLogs/signIns", Ct));
        Assert.Empty(await Cache().DefaultsOfAsync("account-1", Ct));
    }

    // A file from before the default columns were kept reads as it was.
    [Fact]
    public async Task A_file_without_default_columns_reads_its_findings()
    {
        Directory.CreateDirectory(_dir);
        var foundAt = _time.GetUtcNow().ToString("O", System.Globalization.CultureInfo.InvariantCulture);
        await File.WriteAllTextAsync(Path.Combine(_dir, FileGraphProbeCache.FileName), $$"""
            {"version":1,"tables":[{"account":"account-1","path":"users","notListed":["x"],"denied":[],"foundAt":"{{foundAt}}"}]}
            """, Ct);

        Assert.Equal(["x"], (await Cache().GetAsync("account-1", "users", Ct))!.NotListed);
        Assert.Null(await Cache().GetDefaultsAsync("account-1", "users", Ct));
    }

    [Fact]
    public async Task Removing_an_account_forgets_its_default_columns()
    {
        var cache = Cache();
        await cache.SetDefaultsAsync("account-1", "users", ["id"], Ct);

        await cache.RemoveAccountAsync("account-1", Ct);

        Assert.Null(await Cache().GetDefaultsAsync("account-1", "users", Ct));
    }

    [Fact]
    public async Task A_corrupt_file_is_moved_aside_and_reads_as_none()
    {
        Directory.CreateDirectory(_dir);
        await File.WriteAllTextAsync(Path.Combine(_dir, FileGraphProbeCache.FileName), "{not json", Ct);

        Assert.Null(await Cache().GetAsync("account-1", "users", Ct));
        Assert.True(File.Exists(Path.Combine(_dir, FileGraphProbeCache.FileName + ".corrupt")));
    }
}
