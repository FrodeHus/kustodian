using System.Text.Json;
using Kustodian.Auth;
using Kustodian.Graph.Fetch;
using Kustodian.Messaging.Handlers;
using Kustodian.Sources.Arg;
using Kustodian.Sources.Hunting;
using Kustodian.Storage;

namespace Kustodian.Tests.Bridge;

public class AccountHandlerTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "kustodian-tests-" + Guid.NewGuid().ToString("N"));
    private readonly List<string> _sent = [];

    public void Dispose()
    {
        if (Directory.Exists(_dir))
        {
            Directory.Delete(_dir, recursive: true);
        }

        GC.SuppressFinalize(this);
    }

    [Fact]
    public async Task Account_list_memory_only_has_accounts_cache_and_reason()
    {
        var bridge = NewBridge(new MemoryOnly("The OS secure store is not available."));
        await bridge.HandleAsync("""{"id":"s","method":"account.signIn","params":{}}""");

        var result = Parse(await bridge.HandleAsync("""{"id":"l","method":"account.list","params":{}}""")).GetProperty("result");

        Assert.Equal(["accounts", "cache", "cacheReason"], result.EnumerateObject().Select(p => p.Name));
        Assert.Equal("memoryOnly", result.GetProperty("cache").GetString());
        Assert.Equal("The OS secure store is not available.", result.GetProperty("cacheReason").GetString());
        var account = Assert.Single(result.GetProperty("accounts").EnumerateArray());
        Assert.Equal("ada@contoso.com", account.GetProperty("username").GetString());
        Assert.Equal("contoso.com", account.GetProperty("tenantName").GetString());
        Assert.Equal(ClientConfig.AzureCliClientId, account.GetProperty("clientId").GetString());
        Assert.True(account.GetProperty("active").GetBoolean());
        Assert.False(account.GetProperty("expired").GetBoolean());
    }

    [Fact]
    public async Task Account_list_persistent_omits_cache_reason()
    {
        var bridge = NewBridge(new Persistent(new NoPersistence()));

        var result = Parse(await bridge.HandleAsync("""{"id":"l","method":"account.list","params":{}}""")).GetProperty("result");

        Assert.Equal(["accounts", "cache"], result.EnumerateObject().Select(p => p.Name));
        Assert.Equal("persistent", result.GetProperty("cache").GetString());
        Assert.Empty(result.GetProperty("accounts").EnumerateArray());
    }

    [Fact]
    public async Task Account_use_unknown_key_returns_bad_request()
    {
        var bridge = NewBridge(new MemoryOnly("x"));

        var reply = Parse(await bridge.HandleAsync("""{"id":"u","method":"account.use","params":{"key":"nobody"}}"""));

        Assert.Equal("bad_request", reply.GetProperty("error").GetProperty("code").GetString());
    }

    [Fact]
    public async Task Device_code_sign_in_sends_the_code_as_an_event()
    {
        var bridge = NewBridge(new MemoryOnly("x"));

        var reply = Parse(await bridge.HandleAsync("""{"id":"s","method":"account.signIn","params":{"deviceCode":true}}"""));

        Assert.Equal("ada@contoso.com", reply.GetProperty("result").GetProperty("username").GetString());
        var evt = Parse(Assert.Single(_sent));
        Assert.Equal("account.deviceCode", evt.GetProperty("event").GetString());
        Assert.Equal(FakeMsal.DeviceCodeMessage, evt.GetProperty("data").GetProperty("message").GetString());
    }

    [Fact]
    public async Task Sign_out_forgets_what_probing_found_for_the_account()
    {
        var probes = new MemoryGraphProbeCache(TimeProvider.System);
        var bridge = NewBridge(new MemoryOnly("x"), probes);
        var key = Parse(await bridge.HandleAsync("""{"id":"s","method":"account.signIn","params":{"deviceCode":true}}"""))
            .GetProperty("result").GetProperty("key").GetString()!;
        await probes.SetAsync(key, "auditLogs/signIns", ["mfaDetail"], [], CancellationToken.None);
        await probes.SetAsync("someone-else", "auditLogs/signIns", ["mfaDetail"], [], CancellationToken.None);

        await bridge.HandleAsync($$$"""{"id":"o","method":"account.signOut","params":{"key":"{{{key}}}"}}""");

        Assert.Null(await probes.GetAsync(key, "auditLogs/signIns", CancellationToken.None));
        Assert.NotNull(await probes.GetAsync("someone-else", "auditLogs/signIns", CancellationToken.None));
    }

    [Fact]
    public async Task Sign_out_drops_the_accounts_hunting_schema_and_azure_lists()
    {
        var http = new CountingHandler();
        using var client = new HttpClient(http, disposeHandler: false);
        var hunting = new HuntingSchemaSource(client, TimeProvider.System);
        var directory = new ArmDirectory(client, TimeProvider.System);
        var bridge = NewBridge(new MemoryOnly("x"), hunting: hunting, directory: directory);
        var key = Parse(await bridge.HandleAsync("""{"id":"s","method":"account.signIn","params":{"deviceCode":true}}"""))
            .GetProperty("result").GetProperty("key").GetString()!;
        var ct = TestContext.Current.CancellationToken;
        await hunting.GetAsync(key, false, ct);
        await directory.SubscriptionsAsync(key, ct);
        await directory.ResourceTypesAsync(key, ct);
        await hunting.GetAsync("someone-else", false, ct);
        await hunting.GetAsync(key, false, ct);
        await directory.SubscriptionsAsync(key, ct);
        await directory.ResourceTypesAsync(key, ct);
        Assert.Equal((2, 1, 1), (http.Schema, http.Subscriptions, http.ResourceGraph));

        await bridge.HandleAsync($$$"""{"id":"o","method":"account.signOut","params":{"key":"{{{key}}}"}}""");
        await hunting.GetAsync(key, false, ct);
        await directory.SubscriptionsAsync(key, ct);
        await directory.ResourceTypesAsync(key, ct);
        await hunting.GetAsync("someone-else", false, ct);

        Assert.Equal((3, 2, 2), (http.Schema, http.Subscriptions, http.ResourceGraph));
    }

    [Fact]
    public async Task Sign_in_and_sign_out_drop_the_accounts_licenses()
    {
        var licenses = new RecordingLicenses();
        var bridge = NewBridge(new MemoryOnly("x"), licenses: licenses);

        var key = Parse(await bridge.HandleAsync("""{"id":"s","method":"account.signIn","params":{"deviceCode":true}}"""))
            .GetProperty("result").GetProperty("key").GetString()!;
        await bridge.HandleAsync($$$"""{"id":"o","method":"account.signOut","params":{"key":"{{{key}}}"}}""");

        Assert.Equal([key, key], licenses.Removed);
    }

    private sealed class RecordingLicenses : ITenantLicenses
    {
        public List<string> Removed { get; } = [];

        public ValueTask<TenantLicenses> GetAsync(string accountKey, bool refresh, CancellationToken ct)
            => ValueTask.FromResult(TenantLicenses.Unknown("test"));

        public void RemoveAccount(string accountKey) => Removed.Add(accountKey);
    }

    /// <summary>Answers the hunting schema, the subscription list and Resource Graph, counting each.</summary>
    private sealed class CountingHandler : HttpMessageHandler
    {
        public int Schema { get; private set; }

        public int Subscriptions { get; private set; }

        public int ResourceGraph { get; private set; }

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var path = request.RequestUri!.AbsolutePath;
            string json;
            if (path.EndsWith("getHuntingSchema", StringComparison.Ordinal))
            {
                Schema++;
                json = """{"tables":[{"name":"DeviceEvents","columns":[]}]}""";
            }
            else if (path == "/subscriptions")
            {
                Subscriptions++;
                json = """{"value":[{"subscriptionId":"s1","displayName":"Production"}]}""";
            }
            else
            {
                ResourceGraph++;
                json = """{"totalRecords":1,"data":[{"type":"microsoft.compute/virtualmachines"}]}""";
            }

            return Task.FromResult(new HttpResponseMessage(System.Net.HttpStatusCode.OK)
            {
                Content = new StringContent(json, System.Text.Encoding.UTF8, "application/json"),
            });
        }
    }

    private Messaging.Bridge NewBridge(TokenCacheStatus cache, IGraphProbeCache? probes = null, HuntingSchemaSource? hunting = null,
        ArmDirectory? directory = null, ITenantLicenses? licenses = null)
    {
        var bridge = new Messaging.Bridge(message =>
        {
            lock (_sent)
            {
                _sent.Add(message);
            }
        });
        var msal = new FakeMsal();
        var accounts = new AccountService(_ => msal, new JsonFileStore(_dir));
        new AccountHandler(accounts, cache, new MemoryGraphObjectCache(TimeProvider.System), probes ?? NoGraphProbeCache.Instance, hunting, directory,
            licenses).Register(bridge);
        return bridge;
    }

    private static JsonElement Parse(string? json)
    {
        Assert.NotNull(json);
        using var doc = JsonDocument.Parse(json);
        return doc.RootElement.Clone();
    }

    private sealed class NoPersistence : ICachePersistence
    {
        public void Verify()
        {
        }

        public void Register(Microsoft.Identity.Client.ITokenCache cache)
        {
        }
    }

    private sealed class FakeMsal : IMsalClient
    {
        public const string DeviceCodeMessage = "Go to https://microsoft.com/devicelogin and enter CODE";

        private readonly List<MsalAccount> _accounts = [];

        public Task<MsalSignIn> AcquireInteractiveAsync(string scope, string? loginHint, CancellationToken ct, bool forceConsent = false) => Task.FromResult(SignIn());

        public Task<MsalSignIn> AcquireDeviceCodeAsync(string scope, Action<string> showCode, CancellationToken ct)
        {
            showCode(DeviceCodeMessage);
            return Task.FromResult(SignIn());
        }

        public Task<MsalToken> AcquireSilentAsync(string homeAccountId, string scope, CancellationToken ct, bool forceRefresh = false) =>
            throw new NotSupportedException();

        public Task<IReadOnlyList<MsalAccount>> GetAccountsAsync() => Task.FromResult<IReadOnlyList<MsalAccount>>([.. _accounts]);

        public Task RemoveAsync(string homeAccountId)
        {
            _accounts.RemoveAll(a => a.HomeAccountId == homeAccountId);
            return Task.CompletedTask;
        }

        private MsalSignIn SignIn()
        {
            var account = new MsalAccount("home-1", "ada@contoso.com", "tenant-1");
            _accounts.Add(account);
            return new MsalSignIn(account, new MsalToken("not-a-jwt", DateTimeOffset.UtcNow.AddHours(1)));
        }
    }
}
