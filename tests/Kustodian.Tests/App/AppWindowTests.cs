using Kustodian.App;

namespace Kustodian.Tests.App;

public sealed class AppWindowTests
{
    [Fact]
    public void User_agent_names_the_os_the_way_Monaco_detects_it()
    {
        // Monaco picks Cmd or Ctrl for its Ctrl/Cmd bindings from these substrings of the user agent.
        var token = OperatingSystem.IsMacOS() ? "Macintosh" : OperatingSystem.IsWindows() ? "Windows" : "Linux";

        Assert.Contains(token, AppWindow.UserAgent, StringComparison.Ordinal);
    }
}
