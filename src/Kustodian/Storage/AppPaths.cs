namespace Kustodian.Storage;

public enum AppPlatform
{
    Windows,
    MacOS,
    Linux,
}

/// <summary>Where Kustodian keeps its local files, per platform.</summary>
public static class AppPaths
{
    public static string Root { get; } = RootFor(CurrentPlatform(), Environment.GetEnvironmentVariable,
        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile));

    public static AppPlatform CurrentPlatform() =>
        OperatingSystem.IsWindows() ? AppPlatform.Windows
        : OperatingSystem.IsMacOS() ? AppPlatform.MacOS
        : AppPlatform.Linux;

    /// <summary>Windows: %APPDATA%\Kustodian. macOS: ~/Library/Application Support/Kustodian. Linux: $XDG_CONFIG_HOME/kustodian,
    /// else ~/.config/kustodian.</summary>
    public static string RootFor(AppPlatform platform, Func<string, string?> env, string home) => platform switch
    {
        AppPlatform.Windows => Path.Combine(NonEmpty(env("APPDATA")) ?? Path.Combine(home, "AppData", "Roaming"), "Kustodian"),
        AppPlatform.MacOS => Path.Combine(home, "Library", "Application Support", "Kustodian"),
        _ => Path.Combine(NonEmpty(env("XDG_CONFIG_HOME")) ?? Path.Combine(home, ".config"), "kustodian"),
    };

    /// <summary>Files Kustodian can rebuild at any time (the window icon).</summary>
    public static string Cache { get; } = CacheFor(CurrentPlatform(), Environment.GetEnvironmentVariable,
        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile));

    /// <summary>Windows: %LOCALAPPDATA%\Kustodian\Cache. macOS: ~/Library/Caches/Kustodian. Linux: $XDG_CACHE_HOME/kustodian, else
    /// ~/.cache/kustodian.</summary>
    public static string CacheFor(AppPlatform platform, Func<string, string?> env, string home) => platform switch
    {
        AppPlatform.Windows => Path.Combine(NonEmpty(env("LOCALAPPDATA")) ?? Path.Combine(home, "AppData", "Local"), "Kustodian",
            "Cache"),
        AppPlatform.MacOS => Path.Combine(home, "Library", "Caches", "Kustodian"),
        _ => Path.Combine(NonEmpty(env("XDG_CACHE_HOME")) ?? Path.Combine(home, ".cache"), "kustodian"),
    };

    private static string? NonEmpty(string? value) => string.IsNullOrWhiteSpace(value) ? null : value;
}
