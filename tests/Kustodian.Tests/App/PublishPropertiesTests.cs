using System.Diagnostics;
using System.Text.Json;

namespace Kustodian.Tests.App;

/// <summary>The host project's publish properties as MSBuild evaluates them: a runtime identifier turns on the single-file,
/// self-contained publish (and, for Windows, a GUI executable); without one, <c>dotnet build</c> and <c>dotnet test</c> are
/// unchanged.</summary>
public class PublishPropertiesTests
{
    private static readonly string[] Names =
    [
        "OutputType", "AssemblyName", "SelfContained", "PublishSingleFile", "IncludeNativeLibrariesForSelfExtract",
        "EnableCompressionInSingleFile", "DebugType", "PublishTrimmed", "ApplicationIcon",
    ];

    [Theory]
    [InlineData("win-x64")]
    [InlineData("win-arm64")]
    public void Windows_publish_is_a_gui_executable(string rid)
    {
        Assert.Equal("WinExe", Evaluate(rid)["OutputType"]);
    }

    [Theory]
    [InlineData("osx-arm64")]
    [InlineData("osx-x64")]
    [InlineData("linux-x64")]
    public void Other_publishes_stay_console_executables(string rid)
    {
        Assert.Equal("Exe", Evaluate(rid)["OutputType"]);
    }

    [Theory]
    [InlineData("win-x64")]
    [InlineData("win-arm64")]
    [InlineData("osx-arm64")]
    [InlineData("osx-x64")]
    [InlineData("linux-x64")]
    public void A_runtime_identifier_publishes_one_self_contained_file(string rid)
    {
        var properties = Evaluate(rid);

        Assert.Equal("Kustodian", properties["AssemblyName"]);
        Assert.Equal("true", properties["SelfContained"]);
        Assert.Equal("true", properties["PublishSingleFile"]);
        Assert.Equal("true", properties["IncludeNativeLibrariesForSelfExtract"]);
        Assert.Equal("true", properties["EnableCompressionInSingleFile"]);
        Assert.Equal("embedded", properties["DebugType"]);
        Assert.Equal("false", properties["PublishTrimmed"]);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("win-x64")]
    [InlineData("win-arm64")]
    public void The_executable_carries_the_app_icon(string? rid)
    {
        // MSBuild returns the path as the project writes it, with Windows separators.
        var icon = Evaluate(rid)["ApplicationIcon"].Replace('\\', Path.DirectorySeparatorChar);

        Assert.Equal("icon.ico", Path.GetFileName(icon));
        Assert.True(File.Exists(Path.Combine(Path.GetDirectoryName(HostProject())!, icon)), $"{icon} doesn't exist");
    }

    [Fact]
    public void Without_a_runtime_identifier_nothing_changes()
    {
        var properties = Evaluate(null);

        Assert.Equal("Exe", properties["OutputType"]);
        Assert.NotEqual("true", properties["SelfContained"]);
        Assert.NotEqual("true", properties["PublishSingleFile"]);
        Assert.NotEqual("true", properties["IncludeNativeLibrariesForSelfExtract"]);
        Assert.NotEqual("embedded", properties["DebugType"]);
    }

    private static Dictionary<string, string> Evaluate(string? rid)
    {
        var start = new ProcessStartInfo(Environment.GetEnvironmentVariable("DOTNET_HOST_PATH") is { Length: > 0 } host ? host : "dotnet")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };
        start.ArgumentList.Add("msbuild");
        start.ArgumentList.Add(HostProject());
        foreach (var name in Names)
            start.ArgumentList.Add($"-getProperty:{name}");
        if (rid is not null)
            start.ArgumentList.Add($"-p:RuntimeIdentifier={rid}");

        using var process = Process.Start(start)!;
        var stderr = process.StandardError.ReadToEndAsync(TestContext.Current.CancellationToken);
        var stdout = process.StandardOutput.ReadToEnd();
        process.WaitForExit();
        Assert.True(process.ExitCode == 0, $"dotnet msbuild exited with {process.ExitCode}: {stdout}{stderr.Result}");

        using var json = JsonDocument.Parse(stdout);
        return json.RootElement.GetProperty("Properties").EnumerateObject().ToDictionary(p => p.Name, p => p.Value.GetString() ?? "");
    }

    private static string HostProject()
    {
        for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir is not null; dir = dir.Parent)
        {
            if (File.Exists(Path.Combine(dir.FullName, "Kustodian.slnx")))
                return Path.Combine(dir.FullName, "src", "Kustodian", "Kustodian.csproj");
        }
        throw new InvalidOperationException($"No Kustodian.slnx above {AppContext.BaseDirectory}.");
    }
}
