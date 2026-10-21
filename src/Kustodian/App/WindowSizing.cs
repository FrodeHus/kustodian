using System.Drawing;

namespace Kustodian.App;

/// <summary>The window's size. <see cref="Default"/> and <see cref="Minimum"/> are logical pixels (points on macOS, where
/// Photino takes them as they are). On Windows Photino passes sizes to Win32 as physical pixels, so they are scaled by the
/// monitor's DPI factor with <see cref="ForMonitor"/>.</summary>
public static class WindowSizing
{
    public static readonly Size Default = new(1440, 900);
    public static readonly Size Minimum = new(1024, 640);

    /// <summary>The window's physical bounds, centred in <paramref name="workArea"/>, and its physical minimum size, for a
    /// monitor with DPI factor <paramref name="scale"/> (1.0 = 96 DPI). Neither is ever larger than the work area. A scale that
    /// is not a positive finite number counts as 1.0.</summary>
    public static (Rectangle Bounds, Size MinSize) ForMonitor(double scale, Rectangle workArea)
    {
        if (!double.IsFinite(scale) || scale <= 0)
        {
            scale = 1.0;
        }

        var size = Fit(Scale(Default, scale), workArea.Size);
        var min = Fit(Scale(Minimum, scale), workArea.Size);
        var location = new Point(
            workArea.X + ((workArea.Width - size.Width) / 2),
            workArea.Y + ((workArea.Height - size.Height) / 2));
        return (new Rectangle(location, size), min);
    }

    private static Size Scale(Size size, double scale) =>
        new((int)Math.Round(size.Width * scale), (int)Math.Round(size.Height * scale));

    private static Size Fit(Size size, Size bound) =>
        new(Math.Min(size.Width, bound.Width), Math.Min(size.Height, bound.Height));
}
