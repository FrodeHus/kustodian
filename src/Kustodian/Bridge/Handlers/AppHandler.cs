using Kustodian.App;
using Kustodian.Graph.Fetch;
using Kustodian.Storage;

namespace Kustodian.Messaging.Handlers;

/// <summary><c>app.info</c>: the app's version and the platform it runs on. <c>cache.clear</c>: forgets every cached Graph
/// object and every column probing found a table can't serve in a list, of every account, so the next run reads them from Graph
/// (and probes again).</summary>
public sealed class AppHandler(MemoryGraphObjectCache objects, IGraphProbeCache probes)
{
    private static readonly AppInfo Info = new(AppVersion.Text, Platform());

    public void Register(Bridge bridge)
    {
        bridge.Register("app.info", (_, _) => Task.FromResult<object?>(Info));
        bridge.Register("cache.clear", async (_, ct) =>
        {
            objects.Clear();
            await probes.ClearAsync(ct);
            return null;
        });
    }

    private static string Platform() => AppPaths.CurrentPlatform() switch
    {
        AppPlatform.Windows => "windows",
        AppPlatform.MacOS => "macos",
        _ => "linux",
    };

    private sealed record AppInfo(string Version, string Platform);
}
