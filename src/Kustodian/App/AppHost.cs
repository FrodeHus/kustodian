using System.Reflection;
using Kustodian.Auth;
using Kustodian.Graph.Engine;
using Kustodian.Graph.Fetch;
using Kustodian.Graph.Run;
using Kustodian.Graph.Schema;
using Kustodian.Messaging;
using Kustodian.Messaging.Handlers;
using Kustodian.Storage;
using Microsoft.Extensions.Logging;

namespace Kustodian.App;

/// <summary>Builds the host's services, opens the window and tears the services down when it closes.</summary>
public static class AppHost
{
    public static int Run()
    {
        var time = TimeProvider.System;
        var schema = GraphSchemaCatalog.Beta;

        Directory.CreateDirectory(AppPaths.Root);
        var cache = TokenCacheFactory.TryCreateAsync(AppPaths.Root).GetAwaiter().GetResult();
        if (cache is MemoryOnly memory)
        {
            new StderrLogger<AccountService>().LogWarning("Tokens are kept in memory only: {Reason}", memory.Reason);
        }

        var accounts = new AccountService(config => new MsalClient(config, cache), new JsonFileStore(AppPaths.Root));

        var engineCommand = EngineCommand.Resolve(Environment.ProcessPath,
            Assembly.GetEntryAssembly()?.Location is { Length: > 0 } entry ? entry : typeof(AppHost).Assembly.Location);
        var pool = new GraphEnginePool(
            new GraphEngineOptions { WorkerPath = engineCommand.WorkerPath, WorkerArgs = engineCommand.WorkerArgs },
            new StderrLogger<GraphEnginePool>(), time);
        try
        {
            using var http = GraphHttp.CreateClient(accounts, new StderrLogger<GraphAuthHandler>());
            var budget = new GraphFetchBudget();
            var objects = new MemoryGraphObjectCache(time);
            var runner = new GraphRunner(schema, new GraphCollectionReader(http, budget, objects), budget, pool, time,
                new StderrLogger<GraphRunner>());

            AppWindow.Run(new EmbeddedAssets(typeof(AppHost).Assembly, AppOrigin.Current), bridge =>
            {
                new AppHandler().Register(bridge);
                new SchemaHandler(schema).Register(bridge);
                new QueryHandler(schema, () => ActiveAccountAsync(accounts), runner.RunAsync).Register(bridge);
                new AccountHandler(accounts, cache, objects).Register(bridge);
            }, new StderrLogger<Bridge>());
        }
        finally
        {
            pool.DisposeAsync().AsTask().GetAwaiter().GetResult();
        }

        return 0;
    }

    /// <summary>The active account. The service reads <c>accounts.json</c> on its first call, so until something has asked for
    /// the accounts it knows of none: ask once before answering that nobody is signed in.</summary>
    private static async Task<string?> ActiveAccountAsync(AccountService accounts)
    {
        if (accounts.ActiveAccountKey is null)
        {
            await accounts.ListAccountsAsync();
        }

        return accounts.ActiveAccountKey;
    }
}
