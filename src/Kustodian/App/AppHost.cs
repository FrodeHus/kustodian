using Kustodian.Auth;
using Kustodian.Messaging;
using Kustodian.Settings;
using Kustodian.Storage;
using Microsoft.Extensions.Logging;

namespace Kustodian.App;

/// <summary>Reads the settings once, builds the host's services from them (<see cref="AppServices"/>), opens the window and
/// tears the services down when it closes.</summary>
public static class AppHost
{
    public static int Run()
    {
        Directory.CreateDirectory(AppPaths.Root);
        var store = new JsonFileStore(AppPaths.Root);
        var settings = new SettingsService(store, new StderrLogger<SettingsService>());
        var startup = settings.GetAsync().GetAwaiter().GetResult();

        var cache = TokenCacheFactory.TryCreateAsync(AppPaths.Root).GetAwaiter().GetResult();
        if (cache is MemoryOnly memory)
        {
            new StderrLogger<AccountService>().LogWarning("Tokens are kept in memory only: {Reason}", memory.Reason);
        }

        var accounts = new AccountService(config => new MsalClient(config, cache), store);

        // On the dotnet host the worker is this app's .dll in the app's folder. (A single-file build has no .dll on disk, and
        // Assembly.Location is empty there; it runs as its own executable, so this path is never used.)
        var engineCommand = EngineCommand.Resolve(Environment.ProcessPath,
            Path.Combine(AppContext.BaseDirectory, typeof(AppHost).Assembly.GetName().Name + ".dll"));
        var services = AppServices.Build(startup, settings, accounts, cache, engineCommand, store, TimeProvider.System);
        try
        {
            AppWindow.Run(new EmbeddedAssets(typeof(AppHost).Assembly, AppOrigin.Current(startup.Theme)), services.Register, services.Window,
                new StderrLogger<Bridge>());
        }
        finally
        {
            services.DisposeAsync().AsTask().GetAwaiter().GetResult();
        }

        return 0;
    }
}
