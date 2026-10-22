using System.Runtime.InteropServices;

namespace Kustodian.App;

/// <summary>The distribution libraries the window needs on Linux (spec 10: never bundled). Without them Photino throws
/// <see cref="DllNotFoundException"/> deep in startup; this check runs before Photino loads and names the packages
/// instead.</summary>
public static class NativeCheck
{
    /// <summary>The exit code when a library is missing.</summary>
    public const int ExitCode = 3;

    private static readonly string[] LinuxLibraries = ["libwebkit2gtk-4.1.so.0", "libsecret-1.so.0"];

    /// <summary>The libraries that don't load on this platform: on Linux, WebKitGTK 4.1 and libsecret, each tried with
    /// <paramref name="canLoad"/>; elsewhere none.</summary>
    public static IReadOnlyList<string> Missing(Func<string, bool> canLoad) => Missing(canLoad, OperatingSystem.IsLinux());

    /// <summary><see cref="Missing(Func{string, bool})"/> with the platform given.</summary>
    public static IReadOnlyList<string> Missing(Func<string, bool> canLoad, bool isLinux)
    {
        ArgumentNullException.ThrowIfNull(canLoad);
        return isLinux ? [.. LinuxLibraries.Where(library => !canLoad(library))] : [];
    }

    /// <summary>Whether the native library <paramref name="name"/> loads (it is unloaded again).</summary>
    public static bool CanLoad(string name)
    {
        if (!NativeLibrary.TryLoad(name, out var handle))
            return false;
        NativeLibrary.Free(handle);
        return true;
    }

    /// <summary>What to tell the user when <paramref name="missing"/> isn't empty: both packages, for Debian/Ubuntu and
    /// Fedora, since installing them is the fix whichever one is missing.</summary>
    public static string Message(IReadOnlyList<string> missing)
    {
        ArgumentNullException.ThrowIfNull(missing);
        return "Kustodian needs WebKitGTK 4.1 and libsecret: install libwebkit2gtk-4.1-0 and libsecret-1-0 (Debian/Ubuntu) or "
            + "webkit2gtk4.1 and libsecret (Fedora).";
    }
}
