using Kustodian.App;

namespace Kustodian.Tests.App;

public class NativeCheckTests
{
    [Fact]
    public void Missing_lists_each_library_that_does_not_load()
    {
        Assert.Equal(["libwebkit2gtk-4.1.so.0", "libsecret-1.so.0"], NativeCheck.Missing(_ => false, isLinux: true));
        Assert.Equal(["libsecret-1.so.0"], NativeCheck.Missing(name => name != "libsecret-1.so.0", isLinux: true));
        Assert.Equal(["libwebkit2gtk-4.1.so.0"], NativeCheck.Missing(name => name != "libwebkit2gtk-4.1.so.0", isLinux: true));
    }

    [Fact]
    public void Missing_is_empty_when_all_load()
    {
        Assert.Empty(NativeCheck.Missing(_ => true, isLinux: true));
    }

    [Fact]
    public void Missing_is_empty_off_linux_without_trying_to_load()
    {
        var tried = false;

        var missing = NativeCheck.Missing(_ =>
        {
            tried = true;
            return false;
        }, isLinux: false);

        Assert.Empty(missing);
        Assert.False(tried);
    }

    [Fact]
    public void Message_names_debian_and_fedora_packages()
    {
        Assert.Equal(
            "Kustodian needs WebKitGTK 4.1 and libsecret: install libwebkit2gtk-4.1-0 and libsecret-1-0 (Debian/Ubuntu) or "
            + "webkit2gtk4.1 and libsecret (Fedora).",
            NativeCheck.Message(["libsecret-1.so.0"]));
    }

    [Fact]
    public void Exit_code_is_3()
    {
        Assert.Equal(3, NativeCheck.ExitCode);
    }
}
