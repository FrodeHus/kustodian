using Kustodian.App;
using Kustodian.Auth.EntraApp;
using Kustodian.Graph.Fetch;
using Kustodian.Storage;

namespace Kustodian.Messaging.Handlers;

/// <summary><c>app.info</c>: the app's version and the platform it runs on. <c>cache.clear</c>: forgets every cached Graph
/// object and every column probing found a table can't serve in a list, of every account, so the next run reads them from Graph
/// (and probes again). <c>app.openTelemetryDocs</c>: opens the site's page on what sharing Graph compatibility findings
/// sends.</summary>
public sealed class AppHandler(MemoryGraphObjectCache objects, IGraphProbeCache probes, ISystemBrowser? browser = null)
{
    public static readonly Uri TelemetryDocs = new("https://frodehus.github.io/kustodian/telemetry.html");

    private static readonly AppInfo Info = new(AppVersion.Text, Platform());
    private readonly ISystemBrowser _browser = browser ?? new SystemBrowser();

    public void Register(Bridge bridge)
    {
        bridge.Register("app.info", (_, _) => Task.FromResult<object?>(Info));
        bridge.Register("cache.clear", async (_, ct) =>
        {
            objects.Clear();
            await probes.ClearAsync(ct);
            return null;
        });
        bridge.Register("app.openTelemetryDocs", (_, _) =>
        {
            _browser.Open(TelemetryDocs);
            return Task.FromResult<object?>(null);
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
