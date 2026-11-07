using Kustodian.App;
using Kustodian.Auth.EntraApp;
using Kustodian.Files;
using Kustodian.Graph.Fetch;
using Kustodian.Storage;

namespace Kustodian.Messaging.Handlers;

/// <summary><c>app.info</c>: the app's version and the platform it runs on. <c>cache.clear</c>: forgets every cached Graph
/// object and every column probing found a table can't serve in a list, of every account, so the next run reads them from Graph
/// (and probes again). <c>app.openTelemetryDocs</c>: opens the site's page on what sharing Graph compatibility findings
/// sends. <c>app.checkUpdate</c>: whether GitHub has a newer release. <c>app.openRelease</c>: opens a version's release page.
/// <c>app.openLink</c>: opens an https link from a Markdown widget. <c>app.print</c>: on macOS, opens the print dialog for the
/// page and answers true; elsewhere answers false, and the page calls <c>window.print()</c> itself.</summary>
public sealed class AppHandler(MemoryGraphObjectCache objects, IGraphProbeCache probes, UpdateCheck updates, ISystemBrowser? browser = null,
    WindowHolder? window = null)
{
    public static readonly Uri TelemetryDocs = new("https://frodehus.github.io/kustodian/telemetry.html");

    private static readonly AppInfo Info = new(AppVersion.Text, Platform());
    private readonly ISystemBrowser _browser = browser ?? new SystemBrowser();

    public void Register(Bridge bridge)
    {
        bridge.Register("app.info", (_, _) => Task.FromResult<object?>(Info));
        bridge.Register("app.print", async (_, _) =>
        {
            if (!OperatingSystem.IsMacOS())
            {
                return false;
            }

            Action print = MacPrint.Print;
            var shown = window?.Window ?? throw new BridgeException(BridgeErrorCodes.Failed, "The window isn't open.");
            var done = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            shown.Invoke(() =>
            {
                try
                {
                    print();
                    done.SetResult();
                }
                catch (Exception ex)
                {
                    done.SetException(ex);
                }
            });
            try
            {
                await done.Task;
            }
            catch (Exception ex) when (ex is InvalidOperationException or EntryPointNotFoundException or DllNotFoundException)
            {
                throw new BridgeException(BridgeErrorCodes.Failed, "Kustodian couldn't open the print dialog.");
            }

            return true;
        });
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
        bridge.Register("app.openLink", (p, _) =>
        {
            if (!Uri.TryCreate(BridgeJson.Params<LinkParams>(p).Url, UriKind.Absolute, out var link) || link.Scheme != Uri.UriSchemeHttps)
            {
                throw new BridgeException(BridgeErrorCodes.BadRequest, "Only https links open.");
            }

            // The allowlist stays as it is; the widget tells the user which host it refused.
            if (!SystemBrowser.IsAllowed(link))
            {
                // github.com is allowed for the release pages only, so "can't open links to github.com" would be wrong.
                throw new BridgeException(BridgeErrorCodes.BadRequest, link.Host.Equals("github.com", StringComparison.OrdinalIgnoreCase)
                    ? "Kustodian opens only its own release pages on github.com."
                    : $"Kustodian can't open links to {link.Host}.");
            }

            try
            {
                _browser.Open(link);
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

    private sealed record LinkParams(string? Url);

    private sealed record ReleaseParams(string? Version);
}
