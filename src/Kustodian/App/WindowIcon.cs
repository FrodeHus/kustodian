using Kustodian.Storage;

namespace Kustodian.App;

/// <summary>The window icon, embedded in the executable and written to a folder for Photino, whose <c>SetIconFile</c> takes a
/// path. Windows gets <c>icon.ico</c> (Photino loads it with <c>LoadImage(IMAGE_ICON)</c>, which reads .ico files only) and Linux
/// <c>icon.png</c> (GTK). macOS takes the icon from the app bundle, so it gets nothing.</summary>
public static class WindowIcon
{
    /// <summary>Writes the platform's icon to <paramref name="folder"/>, unless the file there already holds it, and returns its
    /// path; null on macOS.</summary>
    public static string? WriteTo(string folder, AppPlatform platform)
    {
        var name = platform switch
        {
            AppPlatform.Windows => "icon.ico",
            AppPlatform.Linux => "icon.png",
            _ => null,
        };
        if (name is null)
        {
            return null;
        }

        using var stream = typeof(WindowIcon).Assembly.GetManifestResourceStream(name)
            ?? throw new InvalidOperationException($"The embedded {name} is missing.");
        using var buffer = new MemoryStream();
        stream.CopyTo(buffer);
        var icon = buffer.ToArray();

        var path = Path.Combine(folder, name);
        if (File.Exists(path) && File.ReadAllBytes(path).AsSpan().SequenceEqual(icon))
        {
            return path;
        }

        Directory.CreateDirectory(folder);
        File.WriteAllBytes(path, icon);
        return path;
    }
}
