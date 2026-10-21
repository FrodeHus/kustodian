using Kustodian.Auth;
using Kustodian.Files;
using Kustodian.Graph.Engine;
using Kustodian.Graph.Fetch;
using Kustodian.Graph.Run;
using Kustodian.Graph.Schema;
using Kustodian.Library;
using Kustodian.Messaging;
using Kustodian.Messaging.Handlers;
using Kustodian.Sessions;
using Kustodian.Settings;
using Kustodian.Snippets;
using Kustodian.Storage;

namespace Kustodian.App;

/// <summary>
/// The host's services, built once from the settings the app started with: the fetch budget, the object cache, the reader, the
/// runner and the engine pool all take their limits from <c>startup</c>, and keep them until the app restarts. Disposing stops
/// the engine workers.
/// </summary>
public sealed class AppServices : IAsyncDisposable
{
    private readonly AppSettings _startup;
    private readonly TimeProvider _time;
    private readonly SettingsService _settings;
    private readonly AccountService _accounts;
    private readonly TokenCacheStatus _tokenCache;
    private readonly HttpClient _http;
    private readonly LibraryService _library;
    private readonly RecentService _recent;
    private readonly SessionService _session;
    private readonly SnippetService _snippets;
    private readonly AllowedFilePaths _allowedFiles;
    private readonly GraphSchema _schema = GraphSchemaCatalog.Beta;

    private AppServices(AppSettings startup, SettingsService settings, AccountService accounts, TokenCacheStatus tokenCache,
        EngineCommand engine, JsonFileStore store, TimeProvider time)
    {
        _startup = startup;
        _time = time;
        _settings = settings;
        _accounts = accounts;
        _tokenCache = tokenCache;
        _library = new LibraryService(store, time, new StderrLogger<LibraryService>());
        _recent = new RecentService(store, new StderrLogger<RecentService>());
        _session = new SessionService(store);
        _snippets = new SnippetService(store, new StderrLogger<SnippetService>());
        _allowedFiles = new AllowedFilePaths(_session, new StderrLogger<AllowedFilePaths>());
        Limits = SettingsService.ToGraphLimits(startup.Limits);

        var options = new GraphEngineOptions { WorkerPath = engine.WorkerPath, WorkerArgs = engine.WorkerArgs };
        SettingsService.Apply(startup.Limits, options);
        Pool = new GraphEnginePool(options, new StderrLogger<GraphEnginePool>(), time);
        _http = GraphHttp.CreateClient(accounts, new StderrLogger<GraphAuthHandler>());
        Budget = new GraphFetchBudget(Limits.FetchBudgetBytes);
        Objects = new MemoryGraphObjectCache(time, Limits);
        Runner = new GraphRunner(_schema, new GraphCollectionReader(_http, Budget, Objects, Limits), Budget, Pool, Limits, time,
            new StderrLogger<GraphRunner>());
    }

    /// <summary>The window, set by <see cref="AppWindow"/> once it exists; the file dialogs read it from here.</summary>
    public WindowHolder Window { get; } = new();

    /// <summary>The Graph limits the app started with.</summary>
    public GraphLimits Limits { get; }

    public GraphEnginePool Pool { get; }

    public GraphFetchBudget Budget { get; }

    public MemoryGraphObjectCache Objects { get; }

    public GraphRunner Runner { get; }

    /// <summary>Builds the services from <paramref name="startup"/>, the settings as read once when the app starts.</summary>
    public static AppServices Build(AppSettings startup, SettingsService settings, AccountService accounts, TokenCacheStatus tokenCache,
        EngineCommand engine, JsonFileStore store, TimeProvider time) =>
        new(startup, settings, accounts, tokenCache, engine, store, time);

    /// <summary>Registers every bridge method.</summary>
    public void Register(Bridge bridge)
    {
        new AppHandler(Objects).Register(bridge);
        new SettingsHandler(_settings, _startup.Limits).Register(bridge);
        new SchemaHandler(_schema).Register(bridge);
        new QueryHandler(_schema, ActiveAccountAsync, Runner.RunAsync, _recent, _time, new StderrLogger<QueryHandler>(), Limits)
            .Register(bridge);
        new LibraryHandler(_library, _recent).Register(bridge);
        new SessionHandler(_session, _allowedFiles).Register(bridge);
        new SnippetHandler(_snippets).Register(bridge);
        new FileHandler(new PhotinoFileDialogs(Window), _allowedFiles).Register(bridge);
        new AccountHandler(_accounts, _tokenCache, Objects).Register(bridge);
    }

    public async ValueTask DisposeAsync()
    {
        _http.Dispose();
        await Pool.DisposeAsync();
    }

    /// <summary>The active account. The service reads <c>accounts.json</c> on its first call, so until something has asked for
    /// the accounts it knows of none: ask once before answering that nobody is signed in.</summary>
    private async Task<string?> ActiveAccountAsync()
    {
        if (_accounts.ActiveAccountKey is null)
        {
            await _accounts.ListAccountsAsync();
        }

        return _accounts.ActiveAccountKey;
    }
}
