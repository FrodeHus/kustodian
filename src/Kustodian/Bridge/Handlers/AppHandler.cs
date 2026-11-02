using Kustodian.App;
using Kustodian.Auth.EntraApp;
using Kustodian.Graph.Fetch;
using Kustodian.Storage;

namespace Kustodian.Messaging.Handlers;

/// <summary><c>app.info</c>: the app's version and the platform it runs on. <c>cache.clear</c>: forgets every cached Graph
/// object and every column probing found a table can't serve in a list, of every account, so the next run reads them from Graph
/// (and probes again). <c>app.openTelemetryDocs</c>: opens the site's page on what sharing Graph compatibility findings
/// sends. <c>app.checkUpdate</c>: whether GitHub has a newer release. <c>app.openRelease</c>: opens a version's release page.</summary>
public sealed class AppHandler(MemoryGraphObjectCache objects, IGraphProbeCache probes, UpdateCheck updates, ISystemBrowser? browser = null)
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
        bridge.Register("app.checkUpdate", async (_, ct) =>
        {
            try
            {
                return await updates.CheckAsync(ct);
            }
            catch (Exception ex) when (ex is HttpRequestException or FormatException or System.Text.Json.JsonException
                || (ex is TaskCanceledException && !ct.IsCancellationRequested))
            {
                throw new BridgeException(BridgeErrorCodes.Failed, "Kustodian couldn't find out the latest version on GitHub.");
            }
        });
        bridge.Register("app.openRelease", (p, _) =>
        {
            var page = UpdateCheck.ReleasePage(BridgeJson.Params<ReleaseParams>(p).Version)
                ?? throw new BridgeException(BridgeErrorCodes.BadRequest, "The version isn't valid.");
            try
            {
                _browser.Open(page);
            }
            catch (Exception ex) when (ex is System.ComponentModel.Win32Exception or InvalidOperationException)
            {
                throw new BridgeException(BridgeErrorCodes.Failed, "Kustodian couldn't open your browser.");
            }

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

    private sealed record ReleaseParams(string? Version);
}
