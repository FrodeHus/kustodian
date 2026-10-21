using Kustodian.Auth;
using Kustodian.Auth.EntraApp;
using Kustodian.Files;
using Kustodian.Graph.Engine;
using Kustodian.Graph.Fetch;
using Kustodian.Graph.Run;
using Kustodian.Graph.Schema;
using Kustodian.Library;
using Kustodian.Messaging;
using Kustodian.Messaging.Handlers;
using Kustodian.Raw;
using Kustodian.Sessions;
using Kustodian.Settings;
using Kustodian.Snippets;
using Kustodian.Sources;
using Kustodian.Sources.Arg;
using Kustodian.Sources.Hunting;
using Kustodian.Storage;

namespace Kustodian.App;

/// <summary>
/// The host's services, built once from the settings the app started with: the fetch budget, the object cache, the reader, the
/// runner, the engine pool and the Resource Graph source (its rows per run) all take their limits from <c>startup</c>, and keep
/// them until the app restarts. Disposing stops
/// the engine workers and closes the Graph, hunting and ARM HTTP clients (<see cref="ArmHttp"/>).
/// </summary>
public sealed class AppServices : IAsyncDisposable
{
    private readonly AppSettings _startup;
    private readonly TimeProvider _time;
    private readonly SettingsService _settings;
    private readonly AccountService _accounts;
    private readonly TokenCacheStatus _tokenCache;
    private readonly HttpClient _http;
    private readonly HttpClient _arm;
    private readonly HttpClient _hunting;
    private readonly HuntingSchemaSource _huntingSchema;
    private readonly ArgClient _arg;
    private readonly ArmDirectory _armDirectory;
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
        _arm = ArmHttp.CreateClient(accounts, new StderrLogger<ArmAuthHandler>());
        // Graph's chain, with a timeout past advanced hunting's own 3 minutes.
        _hunting = GraphHttp.CreateClient(accounts, new StderrLogger<GraphAuthHandler>(), HuntingClient.Timeout);
        _huntingSchema = new HuntingSchemaSource(_http, time);
        _arg = new ArgClient(_arm, time);
        _armDirectory = new ArmDirectory(_arm, time);
        Budget = new GraphFetchBudget(Limits.FetchBudgetBytes);
        Objects = new MemoryGraphObjectCache(time, Limits);
        Probes = new FileGraphProbeCache(store, time, Limits);
        Runner = new GraphRunner(_schema, new GraphCollectionReader(_http, Budget, Objects, Limits, Probes, time), Budget, Pool, Limits, time,
            new StderrLogger<GraphRunner>());
    }

    /// <summary>The window, set by <see cref="AppWindow"/> once it exists; the file dialogs read it from here.</summary>
    public WindowHolder Window { get; } = new();

    /// <summary>The Graph limits the app started with.</summary>
    public GraphLimits Limits { get; }

    public GraphEnginePool Pool { get; }

    public GraphFetchBudget Budget { get; }

    public MemoryGraphObjectCache Objects { get; }

    /// <summary>The columns probing found each table can't serve in a list, kept on disk.</summary>
    public IGraphProbeCache Probes { get; }

    public GraphRunner Runner { get; }

    /// <summary>Builds the services from <paramref name="startup"/>, the settings as read once when the app starts.</summary>
    public static AppServices Build(AppSettings startup, SettingsService settings, AccountService accounts, TokenCacheStatus tokenCache,
        EngineCommand engine, JsonFileStore store, TimeProvider time) =>
        new(startup, settings, accounts, tokenCache, engine, store, time);

    /// <summary>Registers every bridge method.</summary>
    public void Register(Bridge bridge)
    {
        new AppHandler(Objects, Probes).Register(bridge);
        new SettingsHandler(_settings, _startup.Limits).Register(bridge);
        new SchemaHandler(_schema, _huntingSchema, ActiveAccountAsync, Probes).Register(bridge);
        new QueryHandler(_schema, ActiveAccountAsync, Sources(), _recent, _time, new StderrLogger<QueryHandler>(), Limits)
            .Register(bridge);
        new LibraryHandler(_library, _recent).Register(bridge);
        new SessionHandler(_session, _allowedFiles).Register(bridge);
        new SnippetHandler(_snippets).Register(bridge);
        new FileHandler(new PhotinoFileDialogs(Window), _allowedFiles).Register(bridge);
        new AccountHandler(_accounts, _tokenCache, Objects, Probes, _huntingSchema, _armDirectory).Register(bridge);
        new RawHandler(new RawRequestService(_http, _time), ActiveAccountAsync).Register(bridge);
        new ArmHandler(_armDirectory, ActiveAccountAsync).Register(bridge);
        new EntraAppHandler(new EntraAppClient(_http, _time), ActiveAccountInfoAsync, new SystemBrowser()).Register(bridge);
    }

    /// <summary>The query sources by the name <c>query.run</c> gives them.</summary>
    private Dictionary<string, IQuerySource> Sources()
    {
        IQuerySource[] sources =
        [
            new GraphQuerySource(Runner),
            new HuntingQuerySource(new HuntingClient(_hunting, _time), _time, new StderrLogger<HuntingQuerySource>()),
            new ArgQuerySource(_arg, _startup.Limits.ArgRowsPerRun, _time, new StderrLogger<ArgQuerySource>()),
        ];
        return sources.ToDictionary(s => s.Name, StringComparer.Ordinal);
    }

    public async ValueTask DisposeAsync()
    {
        _http.Dispose();
        _arm.Dispose();
        _hunting.Dispose();
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

    /// <summary>The active account with its details (client, expiry, scopes), or null when nobody is signed in.</summary>
    private async Task<AccountInfo?> ActiveAccountInfoAsync()
    {
        var accounts = await _accounts.ListAccountsAsync();
        return accounts.FirstOrDefault(a => a.Active);
    }
}
