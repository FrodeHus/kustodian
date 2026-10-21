using Kustodian.App;
using Kustodian.Auth;

namespace Kustodian.Tests.Bridge;

public class HostTests
{
    [Fact]
    public void Program_with_engine_flag_runs_engine_main_and_never_opens_window()
    {
        var engineRan = false;
        var windowOpened = false;

        var exit = EntryPoint.Dispatch(["--engine"], () =>
        {
            engineRan = true;
            return 3;
        }, () =>
        {
            windowOpened = true;
            return 0;
        });

        Assert.Equal(3, exit);
        Assert.True(engineRan);
        Assert.False(windowOpened);
    }

    [Fact]
    public void Program_without_engine_flag_opens_window()
    {
        var engineRan = false;

        var exit = EntryPoint.Dispatch([], () =>
        {
            engineRan = true;
            return 3;
        }, () => 0);

        Assert.Equal(0, exit);
        Assert.False(engineRan);
    }

    [Theory]
    [InlineData("/usr/local/share/dotnet/dotnet")]
    [InlineData(@"C:\Program Files\dotnet\dotnet.exe")]
    [InlineData("/usr/share/dotnet/DOTNET")]
    public void Engine_command_under_dotnet_host_runs_the_entry_dll(string processPath)
    {
        var command = EngineCommand.Resolve(processPath, "/apps/kustodian/Kustodian.dll");

        Assert.Equal("/apps/kustodian/Kustodian.dll", command.WorkerPath);
        Assert.Equal(["--engine"], command.WorkerArgs);
    }

    [Theory]
    [InlineData("/Applications/Kustodian.app/Contents/MacOS/Kustodian")]
    [InlineData(@"C:\Program Files\Kustodian\Kustodian.exe")]
    public void Engine_command_for_app_host_runs_the_process_itself(string processPath)
    {
        var command = EngineCommand.Resolve(processPath, "/apps/kustodian/Kustodian.dll");

        Assert.Equal(processPath, command.WorkerPath);
        Assert.Equal(["--engine"], command.WorkerArgs);
    }

    [Fact]
    public void Engine_command_without_process_path_runs_the_entry_dll()
    {
        var command = EngineCommand.Resolve(null, "/apps/kustodian/Kustodian.dll");

        Assert.Equal("/apps/kustodian/Kustodian.dll", command.WorkerPath);
        Assert.Equal(["--engine"], command.WorkerArgs);
    }

    [Fact]
    public void Graph_client_follows_no_redirects_and_carries_the_auth_handler()
    {
        var tokens = new NoTokens();

        var handler = GraphHttp.CreateHandler(tokens);
        using var client = GraphHttp.CreateClient(tokens);

        var auth = Assert.IsType<GraphAuthHandler>(handler);
        var sockets = Assert.IsType<SocketsHttpHandler>(auth.InnerHandler);
        Assert.False(sockets.AllowAutoRedirect);
        Assert.Equal(new Uri("https://graph.microsoft.com/beta/"), client.BaseAddress);
        handler.Dispose();
    }

    [Fact]
    public void Embedded_assets_serve_index_for_root_and_nothing_for_unknown_files()
    {
        var assets = new EmbeddedAssets(typeof(EmbeddedAssets).Assembly, AppOrigin.For(windows: false));

        using var root = assets.Open("app://localhost/", out var rootType);
        using var index = assets.Open("app://localhost/index.html?x=1", out var indexType);
        using var missing = assets.Open("app://localhost/nope.js", out _);

        Assert.NotNull(root);
        Assert.StartsWith("text/html", rootType, StringComparison.Ordinal);
        Assert.NotNull(index);
        Assert.StartsWith("text/html", indexType, StringComparison.Ordinal);
        Assert.Contains("Kustodian", new StreamReader(index).ReadToEnd(), StringComparison.Ordinal);
        Assert.Null(missing);
    }

    [Theory]
    [InlineData("app://localhost/assets/index-abc.js", "text/javascript")]
    [InlineData("app://localhost/assets/index.css", "text/css")]
    [InlineData("app://localhost/fonts/inter.woff2", "font/woff2")]
    [InlineData("app://localhost/icon.svg", "image/svg+xml")]
    public void Embedded_assets_content_type_follows_extension(string url, string expected)
    {
        Assert.Equal(expected, EmbeddedAssets.ContentTypeFor(url));
    }

    [Fact]
    public async Task Message_pump_starts_each_message_in_arrival_order()
    {
        var started = new List<string>();
        var done = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var never = new TaskCompletionSource();
        var pump = new MessagePump(message =>
        {
            lock (started)
            {
                started.Add(message);
                if (started.Count == 50)
                {
                    done.SetResult();
                }
            }

            // Each handling stays pending: the next one is still started, in order.
            return never.Task;
        });

        for (var i = 0; i < 50; i++)
        {
            pump.Post(i.ToString(System.Globalization.CultureInfo.InvariantCulture));
        }

        await done.Task.WaitAsync(TimeSpan.FromSeconds(10), TestContext.Current.CancellationToken);
        await pump.CompleteAsync();

        Assert.Equal(Enumerable.Range(0, 50).Select(i => i.ToString(System.Globalization.CultureInfo.InvariantCulture)), started);
    }

    private sealed class NoTokens : ITokenSource
    {
        public Task<string> GetTokenAsync(string accountKey, Audience audience, CancellationToken ct) => throw new NotSupportedException();
    }
}
