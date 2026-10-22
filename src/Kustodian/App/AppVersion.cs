using System.Reflection;

namespace Kustodian.App;

/// <summary>The app's version as people see it: the assembly's informational version without the SDK's <c>+&lt;commit&gt;</c>
/// suffix. <c>app.info</c> and <c>--version</c> both show it.</summary>
public static class AppVersion
{
    public static string Text { get; } = Resolve();

    /// <summary>Drops the SDK's <c>+&lt;commit&gt;</c> suffix.</summary>
    public static string Trim(string version)
    {
        var plus = version.IndexOf('+', StringComparison.Ordinal);
        return plus >= 0 ? version[..plus] : version;
    }

    private static string Resolve()
    {
        var assembly = typeof(AppVersion).Assembly;
        return Trim(assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion
            ?? assembly.GetName().Version?.ToString()
            ?? "0.0.0");
    }
}
