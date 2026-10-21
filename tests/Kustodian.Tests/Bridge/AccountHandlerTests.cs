using System.Text.Json;
using Kustodian.Auth;
using Kustodian.Graph.Fetch;
using Kustodian.Messaging.Handlers;
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

    private Messaging.Bridge NewBridge(TokenCacheStatus cache)
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
        new AccountHandler(accounts, cache, new MemoryGraphObjectCache(TimeProvider.System)).Register(bridge);
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

        public Task<MsalSignIn> AcquireInteractiveAsync(string scope, string? loginHint, CancellationToken ct) => Task.FromResult(SignIn());

        public Task<MsalSignIn> AcquireDeviceCodeAsync(string scope, Action<string> showCode, CancellationToken ct)
        {
            showCode(DeviceCodeMessage);
            return Task.FromResult(SignIn());
        }

        public Task<MsalToken> AcquireSilentAsync(string homeAccountId, string scope, CancellationToken ct) =>
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
