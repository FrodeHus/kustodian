using System.Diagnostics;

namespace Kustodian.Auth.EntraApp;

/// <summary>Opens a page in the user's own browser.</summary>
public interface ISystemBrowser
{
    /// <summary>Opens <paramref name="url"/>; throws <see cref="ArgumentException"/> when the address is not one Kustodian may open.</summary>
    void Open(Uri url);
}

/// <summary>Opens the OS default browser, but only for the Microsoft sign-in and Entra portal pages. The URL is never logged:
/// the consent URL carries a <c>state</c>.</summary>
public sealed class SystemBrowser(Action<Uri>? launch = null) : ISystemBrowser
{
    private static readonly string[] AllowedHosts = ["login.microsoftonline.com", "entra.microsoft.com"];

    private readonly Action<Uri> _launch = launch ?? Launch;

    /// <summary>Whether <paramref name="url"/> is an https address on one of the two allowed hosts, on the default port and without credentials.</summary>
    public static bool IsAllowed(Uri url) =>
        url.IsAbsoluteUri
        && url.Scheme == Uri.UriSchemeHttps
        && url.IsDefaultPort
        && string.IsNullOrEmpty(url.UserInfo)
        && AllowedHosts.Contains(url.Host, StringComparer.OrdinalIgnoreCase);

    public void Open(Uri url)
    {
        if (!IsAllowed(url))
        {
            throw new ArgumentException("Kustodian only opens Microsoft sign-in and Entra pages.", nameof(url));
        }

        _launch(url);
    }

    private static void Launch(Uri url)
    {
        var info = new ProcessStartInfo();
        if (OperatingSystem.IsWindows())
        {
            info.FileName = url.AbsoluteUri;
            info.UseShellExecute = true;
        }
        else
        {
            info.FileName = OperatingSystem.IsMacOS() ? "open" : "xdg-open";
            info.ArgumentList.Add(url.AbsoluteUri);
            info.UseShellExecute = false;
        }

        using var process = Process.Start(info);
    }
}
