using System.Buffers.Binary;
using Kustodian.App;
using Kustodian.Storage;

namespace Kustodian.Tests.App;

public class WindowIconTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "kustodian-tests-" + Guid.NewGuid().ToString("N"));

    public void Dispose()
    {
        if (Directory.Exists(_dir))
        {
            Directory.Delete(_dir, recursive: true);
        }

        GC.SuppressFinalize(this);
    }

    [Fact]
    public void Linux_gets_the_256_px_png()
    {
        var path = WindowIcon.WriteTo(_dir, AppPlatform.Linux);

        Assert.Equal(Path.Combine(_dir, "icon.png"), path);
        var png = File.ReadAllBytes(path!);
        Assert.Equal([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A], png[..8]);
        Assert.Equal(256, BinaryPrimitives.ReadInt32BigEndian(png.AsSpan(16)));
        Assert.Equal(256, BinaryPrimitives.ReadInt32BigEndian(png.AsSpan(20)));
    }

    [Fact]
    public void Windows_gets_the_ico()
    {
        // Photino loads a Windows window icon with LoadImage(IMAGE_ICON), which reads .ico files only.
        var path = WindowIcon.WriteTo(_dir, AppPlatform.Windows);

        Assert.Equal(Path.Combine(_dir, "icon.ico"), path);
        var ico = File.ReadAllBytes(path!);
        Assert.Equal([0, 0, 1, 0], ico[..4]);
        Assert.Equal(4, BinaryPrimitives.ReadUInt16LittleEndian(ico.AsSpan(4)));
    }

    [Fact]
    public void MacOS_takes_the_icon_from_the_bundle()
    {
        Assert.Null(WindowIcon.WriteTo(_dir, AppPlatform.MacOS));
        Assert.False(Directory.Exists(_dir));
    }

    [Fact]
    public void An_up_to_date_icon_is_not_written_again()
    {
        var path = WindowIcon.WriteTo(_dir, AppPlatform.Linux)!;
        var then = new DateTime(2020, 1, 1, 0, 0, 0, DateTimeKind.Utc);
        File.SetLastWriteTimeUtc(path, then);

        WindowIcon.WriteTo(_dir, AppPlatform.Linux);

        Assert.Equal(then, File.GetLastWriteTimeUtc(path));
    }

    [Fact]
    public void A_stale_icon_is_replaced()
    {
        var expected = File.ReadAllBytes(WindowIcon.WriteTo(_dir, AppPlatform.Linux)!);
        File.WriteAllBytes(Path.Combine(_dir, "icon.png"), [1, 2, 3]);

        var path = WindowIcon.WriteTo(_dir, AppPlatform.Linux)!;

        Assert.Equal(expected, File.ReadAllBytes(path));
    }
}
