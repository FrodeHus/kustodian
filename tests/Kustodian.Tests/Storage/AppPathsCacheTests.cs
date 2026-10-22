using Kustodian.Storage;

namespace Kustodian.Tests.Storage;

public class AppPathsCacheTests
{
    [Fact]
    public void Cache_per_platform()
    {
        Assert.Equal(Path.Combine(@"C:\Users\a\AppData\Local", "Kustodian", "Cache"),
            AppPaths.CacheFor(AppPlatform.Windows, k => k == "LOCALAPPDATA" ? @"C:\Users\a\AppData\Local" : null, @"C:\Users\a"));
        Assert.Equal(Path.Combine(@"C:\Users\a", "AppData", "Local", "Kustodian", "Cache"),
            AppPaths.CacheFor(AppPlatform.Windows, _ => null, @"C:\Users\a"));
        Assert.Equal(Path.Combine("/Users/a", "Library", "Caches", "Kustodian"),
            AppPaths.CacheFor(AppPlatform.MacOS, _ => null, "/Users/a"));
        Assert.Equal(Path.Combine("/xdg-cache", "kustodian"),
            AppPaths.CacheFor(AppPlatform.Linux, k => k == "XDG_CACHE_HOME" ? "/xdg-cache" : null, "/home/a"));
        Assert.Equal(Path.Combine("/home/a", ".cache", "kustodian"),
            AppPaths.CacheFor(AppPlatform.Linux, _ => "", "/home/a"));
    }
}
