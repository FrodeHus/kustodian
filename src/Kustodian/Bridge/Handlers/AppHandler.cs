using Kustodian.App;
using Kustodian.Graph.Fetch;
using Kustodian.Storage;

namespace Kustodian.Messaging.Handlers;

/// <summary><c>app.info</c>: the app's version and the platform it runs on. <c>cache.clear</c>: forgets every cached Graph
/// object and every column probing found a table can't serve in a list, of every account, so the next run reads them from Graph
/// (and probes again). <c>app.checkUpdate</c>: whether GitHub has a newer release. <c>app.openRelease</c>: opens a version's
/// release page in the user's browser.</summary>
public sealed class AppHandler(MemoryGraphObjectCache objects, IGraphProbeCache probes, UpdateCheck updates, Action<Uri> open)
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
                open(page);
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
