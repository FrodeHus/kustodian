using Kustodian.App;

namespace Kustodian.Tests.App;

public class EntryPointTests
{
    [Fact]
    public void Dispatch_with_version_flag_prints_version_only()
    {
        var engineRan = false;
        var windowOpened = false;

        var exit = EntryPoint.Dispatch([EntryPoint.VersionFlag], () =>
        {
            engineRan = true;
            return 3;
        }, () =>
        {
            windowOpened = true;
            return 4;
        }, () => 7);

        Assert.Equal(7, exit);
        Assert.False(engineRan);
        Assert.False(windowOpened);
    }

    [Fact]
    public void App_version_strips_commit_suffix()
    {
        Assert.Equal("1.0.0", AppVersion.Trim("1.0.0+abc123"));
        Assert.Equal("1.0.0", AppVersion.Trim("1.0.0"));
    }
}
