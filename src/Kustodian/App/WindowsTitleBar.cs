using System.Globalization;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;

namespace Kustodian.App;

/// <summary>The Windows window's title bar in the theme's colours: dark mode for the caption buttons, and the page's top-bar
/// colour for the caption and border, so the system title bar runs into the page's own. Windows 10 and Windows 11 before
/// build 22000 ignore the colours and keep only dark mode.</summary>
internal static partial class WindowsTitleBar
{
    private const int UseImmersiveDarkMode = 20;
    private const int BorderColor = 34;
    private const int CaptionColor = 35;
    private const int TextColor = 36;
    private const int DefaultColor = unchecked((int)0xFFFFFFFF);

    /// <summary>Sets the title bar of <paramref name="hwnd"/>; a colour that isn't <c>#rrggbb</c> is the system's own.</summary>
    [SupportedOSPlatform("windows")]
    public static void Apply(nint hwnd, bool dark, string? caption, string? text)
    {
        // Failures (an older Windows without the attribute) leave that part of the title bar as it was.
        Set(hwnd, UseImmersiveDarkMode, dark ? 1 : 0);
        var background = ColorRef(caption) ?? DefaultColor;
        Set(hwnd, CaptionColor, background);
        Set(hwnd, BorderColor, background);
        Set(hwnd, TextColor, ColorRef(text) ?? DefaultColor);
    }

    /// <summary>A <c>#rrggbb</c> colour as a Win32 COLORREF (0x00bbggrr), or null for anything else.</summary>
    internal static int? ColorRef(string? hex)
    {
        if (hex is not { Length: 7 } || hex[0] != '#'
            || !int.TryParse(hex.AsSpan(1), NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture, out var rgb))
        {
            return null;
        }

        return ((rgb & 0xFF) << 16) | (rgb & 0xFF00) | ((rgb >> 16) & 0xFF);
    }

    [SupportedOSPlatform("windows")]
    private static void Set(nint hwnd, int attribute, int value) => _ = DwmSetWindowAttribute(hwnd, attribute, ref value, sizeof(int));

    [LibraryImport("dwmapi.dll")]
    [SupportedOSPlatform("windows")]
    private static partial int DwmSetWindowAttribute(nint hwnd, int attribute, ref int value, int size);
}
