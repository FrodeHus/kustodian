using System.Reflection;
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

        var engineCommand = EngineCommand.Resolve(Environment.ProcessPath,
            Assembly.GetEntryAssembly()?.Location is { Length: > 0 } entry ? entry : typeof(AppHost).Assembly.Location);
        var services = AppServices.Build(startup, settings, accounts, cache, engineCommand, TimeProvider.System);
        try
        {
            AppWindow.Run(new EmbeddedAssets(typeof(AppHost).Assembly, AppOrigin.Current(startup.Theme)), services.Register,
                new StderrLogger<Bridge>());
        }
        finally
        {
            services.DisposeAsync().AsTask().GetAwaiter().GetResult();
        }

        return 0;
    }
}
