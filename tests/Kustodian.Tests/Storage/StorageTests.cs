using Kustodian.Storage;

namespace Kustodian.Tests.Storage;

public class StorageTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "kustodian-tests-" + Guid.NewGuid().ToString("N"));

    public void Dispose()
    {
        if (Directory.Exists(_dir))
        {
            Directory.Delete(_dir, recursive: true);
        }

        GC.SuppressFinalize(this);
    }

    private sealed record Sample(string Name, int Count);

    [Fact]
    public void AppPaths_root_per_platform()
    {
        Assert.Equal(Path.Combine(@"C:\Users\a\AppData\Roaming", "Kustodian"),
            AppPaths.RootFor(AppPlatform.Windows, k => k == "APPDATA" ? @"C:\Users\a\AppData\Roaming" : null, "/home/a"));
        Assert.Equal(Path.Combine("/Users/a", "Library", "Application Support", "Kustodian"),
            AppPaths.RootFor(AppPlatform.MacOS, _ => null, "/Users/a"));
        Assert.Equal(Path.Combine("/xdg", "kustodian"),
            AppPaths.RootFor(AppPlatform.Linux, k => k == "XDG_CONFIG_HOME" ? "/xdg" : null, "/home/a"));
        Assert.Equal(Path.Combine("/home/a", ".config", "kustodian"),
            AppPaths.RootFor(AppPlatform.Linux, _ => null, "/home/a"));
        Assert.Equal(Path.Combine("/home/a", ".config", "kustodian"),
            AppPaths.RootFor(AppPlatform.Linux, _ => "", "/home/a"));
    }

    [Fact]
    public async Task Write_is_atomic_and_leaves_no_temp_files()
    {
        var store = new JsonFileStore(_dir);

        await store.WriteAsync("sub/a.json", new Sample("x", 1), TestContext.Current.CancellationToken);
        await store.WriteAsync("sub/a.json", new Sample("y", 2), TestContext.Current.CancellationToken);

        var read = await store.ReadAsync("sub/a.json", new Sample("", 0), TestContext.Current.CancellationToken);
        Assert.Equal(new Sample("y", 2), read.Value);
        Assert.False(read.Corrupt);
        Assert.Equal(["a.json"], Directory.GetFiles(Path.Combine(_dir, "sub")).Select(Path.GetFileName));
    }

    [Fact]
    public async Task Failed_write_keeps_the_previous_file()
    {
        var store = new JsonFileStore(_dir);
        await store.WriteAsync("a.json", new Sample("keep", 1), TestContext.Current.CancellationToken);
        using var cts = new CancellationTokenSource();
        await cts.CancelAsync();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => store.WriteAsync("a.json", new Sample("lost", 2), cts.Token));

        Assert.Equal(new Sample("keep", 1), (await store.ReadAsync("a.json", new Sample("", 0), TestContext.Current.CancellationToken)).Value);
        Assert.Equal(["a.json"], Directory.GetFiles(_dir).Select(Path.GetFileName));
    }

    [Fact]
    public async Task Corrupt_file_is_moved_aside()
    {
        var store = new JsonFileStore(_dir);
        Directory.CreateDirectory(_dir);
        await File.WriteAllTextAsync(Path.Combine(_dir, "a.json"), "{ not json", TestContext.Current.CancellationToken);
        var fallback = new Sample("fallback", 0);

        var read = await store.ReadAsync("a.json", fallback, TestContext.Current.CancellationToken);

        Assert.True(read.Corrupt);
        Assert.Same(fallback, read.Value);
        Assert.False(File.Exists(Path.Combine(_dir, "a.json")));
        Assert.Equal("{ not json", await File.ReadAllTextAsync(Path.Combine(_dir, "a.json.corrupt"), TestContext.Current.CancellationToken));
    }

    [Fact]
    public async Task Missing_file_returns_fallback_without_corrupt()
    {
        var read = await new JsonFileStore(_dir).ReadAsync("nope.json", new Sample("f", 0), TestContext.Current.CancellationToken);

        Assert.False(read.Corrupt);
        Assert.Equal("f", read.Value.Name);
    }

    [Fact]
    public async Task Paths_outside_the_root_are_refused()
    {
        var store = new JsonFileStore(_dir);

        await Assert.ThrowsAsync<ArgumentException>(() => store.WriteAsync("../escape.json", new Sample("x", 1), TestContext.Current.CancellationToken));
    }
}
