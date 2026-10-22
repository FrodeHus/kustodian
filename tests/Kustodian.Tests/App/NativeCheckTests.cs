using Kustodian.App;

namespace Kustodian.Tests.App;

public class NativeCheckTests
{
    private const string WebKit = "libwebkit2gtk-4.1.so.0";
    private const string Secret = "libsecret-1.so.0";
    private const string Notify = "libnotify.so.4";

    [Fact]
    public void Missing_lists_each_library_that_does_not_load()
    {
        Assert.Equal([WebKit, Secret, Notify], NativeCheck.Missing(_ => false, isLinux: true));
        Assert.Equal([Secret], NativeCheck.Missing(name => name != Secret, isLinux: true));
        Assert.Equal([WebKit], NativeCheck.Missing(name => name != WebKit, isLinux: true));
        Assert.Equal([WebKit, Notify], NativeCheck.Missing(name => name == Secret, isLinux: true));
    }

    [Fact]
    public void Missing_names_libnotify_when_only_it_does_not_load()
    {
        Assert.Equal([Notify], NativeCheck.Missing(name => name != Notify, isLinux: true));
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
            "Kustodian needs WebKitGTK 4.1, libsecret and libnotify: install libwebkit2gtk-4.1-0, libsecret-1-0 and libnotify4 "
            + "(Debian/Ubuntu) or webkit2gtk4.1, libsecret and libnotify (Fedora).",
            NativeCheck.Message([Notify]));
    }

    [Fact]
    public void Exit_code_is_3()
    {
        Assert.Equal(3, NativeCheck.ExitCode);
    }
}
