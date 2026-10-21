using System.Net;
using System.Text;
using System.Text.Json;
using Kustodian.Auth;
using Kustodian.Graph.Run;
using Kustodian.Storage;
using Microsoft.Extensions.Logging;

namespace Kustodian.Tests.Auth;

public class AuthTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "kustodian-tests-" + Guid.NewGuid().ToString("N"));

    public void Dispose()
    {
        if (Directory.Exists(_dir))
        {
            Directory.Delete(_dir, recursive: true);
        }

        GC.SuppressFinalize(this);
    }

    [Fact]
    public void AzureCli_config_has_spec_client_id_and_organizations()
    {
        var config = ClientConfig.AzureCli;

        Assert.Equal("04b07795-8ddb-461a-bbee-02f9e1bf7b46", config.ClientId);
        Assert.Equal("organizations", config.Tenant);
        Assert.True(config.IsAzureCli);
        Assert.False(new ClientConfig("other", "organizations").IsAzureCli);
    }

    [Fact]
    public void Audience_scopes_are_dot_default()
    {
        Assert.Equal("https://graph.microsoft.com/.default", Audience.Graph.ScopeFor());
        Assert.Equal("https://management.azure.com/.default", Audience.Arm.ScopeFor());
    }

    [Fact]
    public async Task Handler_adds_bearer_only_for_graph_host()
    {
        var inner = new RecordingHandler();
        using var client = new HttpClient(new GraphAuthHandler(new FixedTokens("tok-123")) { InnerHandler = inner });

        await client.GetAsync("https://graph.microsoft.com/beta/security/runHuntingQuery", TestContext.Current.CancellationToken);
        await client.GetAsync("https://example.com/x", TestContext.Current.CancellationToken);
        await client.GetAsync("https://graph.microsoft.com.evil.example/x", TestContext.Current.CancellationToken);
        await client.GetAsync("http://graph.microsoft.com/beta/x", TestContext.Current.CancellationToken);

        Assert.Equal("Bearer tok-123", inner.Seen[0].Authorization);
        Assert.Null(inner.Seen[1].Authorization);
        Assert.Null(inner.Seen[2].Authorization);
        Assert.Null(inner.Seen[3].Authorization);
    }

    [Fact]
    public async Task Handler_never_sends_a_caller_supplied_authorization_to_other_hosts()
    {
        var inner = new RecordingHandler();
        using var client = new HttpClient(new GraphAuthHandler(new FixedTokens("tok-123")) { InnerHandler = inner });
        using var request = new HttpRequestMessage(HttpMethod.Get, "https://example.com/x");
        request.Headers.Authorization = new("Bearer", "leak");

        await client.SendAsync(request, TestContext.Current.CancellationToken);

        Assert.Null(inner.Seen[0].Authorization);
    }

    [Fact]
    public async Task Handler_never_logs_token()
    {
        const string token = "SECRET-TOKEN-VALUE";
        var logger = new CapturingLogger<GraphAuthHandler>();
        using var client = new HttpClient(new GraphAuthHandler(new FixedTokens(token), logger) { InnerHandler = new RecordingHandler() });

        await client.GetAsync("https://graph.microsoft.com/beta/x", TestContext.Current.CancellationToken);

        Assert.NotEmpty(logger.Lines);
        Assert.DoesNotContain(logger.Lines, l => l.Contains(token, StringComparison.Ordinal));
    }

    [Fact]
    public async Task Cache_falls_back_to_memory_when_persistence_check_fails()
    {
        var status = await TokenCacheFactory.TryCreateAsync(_dir, _ => Task.FromResult<ICachePersistence>(new FailingPersistence()));

        var memory = Assert.IsType<MemoryOnly>(status);
        Assert.False(string.IsNullOrWhiteSpace(memory.Reason));
        Assert.False(Directory.Exists(_dir) && Directory.EnumerateFileSystemEntries(_dir).Any());
    }

    [Fact]
    public async Task Cache_is_persistent_when_check_passes()
    {
        var status = await TokenCacheFactory.TryCreateAsync(_dir, _ => Task.FromResult<ICachePersistence>(new OkPersistence()));

        Assert.IsType<Persistent>(status);
    }

    [Fact]
    public async Task GetToken_without_account_throws_SignInRequired()
    {
        var service = NewService(new FakeMsal());

        await Assert.ThrowsAsync<SignInRequiredException>(() => service.GetTokenAsync(Audience.Graph, TestContext.Current.CancellationToken));
    }

    [Fact]
    public async Task GetToken_throws_SignInRequired_when_silent_needs_ui_and_marks_account_expired()
    {
        var msal = new FakeMsal();
        var service = NewService(msal);
        await service.SignInInteractiveAsync(ClientConfig.AzureCli, TestContext.Current.CancellationToken);
        msal.SilentNeedsUi = true;

        await Assert.ThrowsAsync<SignInRequiredException>(() => service.GetTokenAsync(Audience.Graph, TestContext.Current.CancellationToken));

        Assert.True((await service.ListAccountsAsync()).Single().Expired);
    }

    [Fact]
    public async Task Sign_in_stores_metadata_scopes_and_active_key_but_never_tokens()
    {
        var msal = new FakeMsal();
        var service = NewService(msal);

        await service.SignInInteractiveAsync(ClientConfig.AzureCli, TestContext.Current.CancellationToken);

        var account = Assert.Single(await service.ListAccountsAsync());
        Assert.Equal("ada@contoso.com", account.Username);
        Assert.True(account.Active);
        Assert.False(account.Expired);
        Assert.Equal(["ThreatHunting.Read.All", "User.Read"], account.Scopes);
        Assert.Equal(account.Key, service.ActiveAccountKey);
        Assert.Equal("tok-1", await service.GetTokenAsync(Audience.Graph, TestContext.Current.CancellationToken));

        var json = await File.ReadAllTextAsync(Path.Combine(_dir, "accounts.json"), TestContext.Current.CancellationToken);
        Assert.DoesNotContain(msal.LastJwt, json, StringComparison.Ordinal);
        Assert.DoesNotContain("eyJ", json, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Accounts_survive_a_restart_and_are_expired_when_the_cache_lost_them()
    {
        var first = NewService(new FakeMsal());
        await first.SignInInteractiveAsync(ClientConfig.AzureCli, TestContext.Current.CancellationToken);

        var restarted = NewService(new FakeMsal { ForgetAccounts = true });

        var account = Assert.Single(await restarted.ListAccountsAsync());
        Assert.True(account.Expired);
        Assert.Equal(first.ActiveAccountKey, account.Key);
        await Assert.ThrowsAsync<SignInRequiredException>(() => restarted.GetTokenAsync(Audience.Graph, TestContext.Current.CancellationToken));
    }

    [Fact]
    public async Task Use_switches_active_and_sign_out_removes_and_reassigns()
    {
        var msal = new FakeMsal();
        var service = NewService(msal);
        await service.SignInInteractiveAsync(ClientConfig.AzureCli, TestContext.Current.CancellationToken);
        msal.Next = ("home-2", "bob@fabrikam.com", "tenant-2");
        await service.SignInDeviceCodeAsync(ClientConfig.AzureCli, _ => { }, TestContext.Current.CancellationToken);
        var accounts = await service.ListAccountsAsync();
        var first = accounts.Single(a => a.Username == "ada@contoso.com");
        var second = accounts.Single(a => a.Username == "bob@fabrikam.com");

        Assert.Equal(second.Key, service.ActiveAccountKey);
        await service.UseAsync(first.Key);
        Assert.Equal(first.Key, service.ActiveAccountKey);

        await service.SignOutAsync(first.Key);

        Assert.Equal(second.Key, service.ActiveAccountKey);
        Assert.Single(await service.ListAccountsAsync());
        Assert.Contains("home-1", msal.Removed);
        await Assert.ThrowsAsync<ArgumentException>(() => service.UseAsync("nope"));
    }

    [Fact]
    public async Task Device_code_message_is_passed_to_the_caller()
    {
        var service = NewService(new FakeMsal());
        string? shown = null;

        await service.SignInDeviceCodeAsync(ClientConfig.AzureCli, m => shown = m, TestContext.Current.CancellationToken);

        Assert.Equal("go to https://microsoft.com/devicelogin and enter CODE", shown);
    }

    private AccountService NewService(FakeMsal msal) => new(_ => msal, new JsonFileStore(_dir));

    private sealed class FixedTokens(string token) : ITokenSource
    {
        public string? ActiveAccountKey => "k";

        public Task<string> GetTokenAsync(Audience audience, CancellationToken ct) => Task.FromResult(token);
    }

    private sealed class RecordingHandler : HttpMessageHandler
    {
        public List<(string? Authorization, Uri? Uri)> Seen { get; } = [];

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Seen.Add((request.Headers.Authorization?.ToString(), request.RequestUri));
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK));
        }
    }

    private sealed class CapturingLogger<T> : ILogger<T>
    {
        public List<string> Lines { get; } = [];

        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;

        public bool IsEnabled(LogLevel logLevel) => true;

        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception,
            Func<TState, Exception?, string> formatter) => Lines.Add(formatter(state, exception) + exception);
    }

    private sealed class FailingPersistence : ICachePersistence
    {
        public void Verify() => throw new InvalidOperationException("no keyring");

        public void Register(Microsoft.Identity.Client.ITokenCache cache)
        {
        }
    }

    private sealed class OkPersistence : ICachePersistence
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
        private readonly Dictionary<string, MsalAccount> _cached = [];

        public (string Home, string User, string Tenant) Next { get; set; } = ("home-1", "ada@contoso.com", "tenant-1");

        public bool SilentNeedsUi { get; set; }

        public bool ForgetAccounts { get; set; }

        public List<string> Removed { get; } = [];

        public string LastJwt { get; private set; } = "";

        public Task<MsalSignIn> AcquireInteractiveAsync(string scope, CancellationToken ct) => Task.FromResult(SignIn());

        public Task<MsalSignIn> AcquireDeviceCodeAsync(string scope, Action<string> showCode, CancellationToken ct)
        {
            showCode("go to https://microsoft.com/devicelogin and enter CODE");
            return Task.FromResult(SignIn());
        }

        public Task<MsalToken> AcquireSilentAsync(string homeAccountId, string scope, CancellationToken ct)
        {
            if (SilentNeedsUi || !_cached.ContainsKey(homeAccountId))
            {
                throw new Microsoft.Identity.Client.MsalUiRequiredException("ui_required", "sign in again");
            }

            return Task.FromResult(new MsalToken("tok-1", DateTimeOffset.UtcNow.AddHours(1)));
        }

        public Task<IReadOnlyList<MsalAccount>> GetAccountsAsync() =>
            Task.FromResult<IReadOnlyList<MsalAccount>>(ForgetAccounts ? [] : [.. _cached.Values]);

        public Task RemoveAsync(string homeAccountId)
        {
            Removed.Add(homeAccountId);
            _cached.Remove(homeAccountId);
            return Task.CompletedTask;
        }

        private MsalSignIn SignIn()
        {
            var account = new MsalAccount(Next.Home, Next.User, Next.Tenant);
            _cached[account.HomeAccountId] = account;
            var payload = Convert.ToBase64String(Encoding.UTF8.GetBytes(
                JsonSerializer.Serialize(new { scp = "ThreatHunting.Read.All User.Read" })))
                .TrimEnd('=').Replace('+', '-').Replace('/', '_');
            LastJwt = $"eyJhbGciOiJub25lIn0.{payload}.sig";
            return new MsalSignIn(account, new MsalToken(LastJwt, DateTimeOffset.UtcNow.AddHours(1)));
        }
    }
}
