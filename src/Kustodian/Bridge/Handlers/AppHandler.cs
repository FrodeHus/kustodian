using System.Reflection;
using Kustodian.Storage;

namespace Kustodian.Messaging.Handlers;

/// <summary><c>app.info</c>: the app's version and the platform it runs on.</summary>
public sealed class AppHandler
{
    private static readonly AppInfo Info = new(Version(), Platform());

    public void Register(Bridge bridge) => bridge.Register("app.info", (_, _) => Task.FromResult<object?>(Info));

    private static string Version()
    {
        var assembly = typeof(AppHandler).Assembly;
        var version = assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion
            ?? assembly.GetName().Version?.ToString()
            ?? "0.0.0";
        // The SDK appends "+<commit>"; the UI shows the version alone.
        var plus = version.IndexOf('+', StringComparison.Ordinal);
        return plus >= 0 ? version[..plus] : version;
    }

    private static string Platform() => AppPaths.CurrentPlatform() switch
    {
        AppPlatform.Windows => "windows",
        AppPlatform.MacOS => "macos",
        _ => "linux",
    };

    private sealed record AppInfo(string Version, string Platform);
}
