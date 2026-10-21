using System.Net;
using System.Text.Json;
using Kustodian.App;
using Kustodian.Auth;
using Kustodian.Graph.Fetch;
using Kustodian.Graph.Run;
using Kustodian.Graph.Schema;
using Kustodian.Library;
using Kustodian.Messaging.Handlers;
using Kustodian.Storage;
using Microsoft.Identity.Client;

namespace Kustodian.Tests.Auth;

/// <summary>Spec 6.7: ARM tokens are asked for only when a Resource Graph tab needs one, and an ARM token that needs the user is
/// consent to grant, never an expired sign-in.</summary>
public sealed class ArmAuthTests : IDisposable
{
    private const string RunId = "0b9d6f0e-5c1a-4c8e-9d2f-3a4b5c6d7e8f";
    private const string ConsentMessage = "Kustodian needs your permission to read Azure resources for this account.";
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private readonly string _dir = Path.Combine(Path.GetTempPath(), "kustodian-tests-" + Guid.NewGuid().ToString("N"));

    public void Dispose()
    {
        if (Directory.Exists(_dir))
        {
            Directory.Delete(_dir, recursive: true);
        }
    }

    [Fact]
    public async Task Arm_consent_needed_does_not_expire_the_account()
    {
        var msal = new ArmMsal { ArmNeedsUi = true };
        var service = new AccountService(_ => msal, new JsonFileStore(_dir));
        var account = await service.SignInInteractiveAsync(ClientConfig.AzureCli, Ct);

        var consent = await Assert.ThrowsAsync<ConsentRequiredException>(() => service.GetTokenAsync(account.Key, Audience.Arm, Ct));

        Assert.Equal("arm", consent.Audience);
        Assert.Equal(ConsentMessage, consent.Message);
        Assert.Equal("graph-token", await service.GetTokenAsync(account.Key, Audience.Graph, Ct));
        var listed = Assert.Single(await service.ListAccountsAsync());
        Assert.False(listed.Expired);

        // Asking again after the Graph token still never expires it.
        await Assert.ThrowsAsync<ConsentRequiredException>(() => service.GetTokenAsync(account.Key, Audience.Arm, Ct));
        Assert.False(Assert.Single(await service.ListAccountsAsync()).Expired);
    }

    [Fact]
    public async Task Arm_error_that_names_consent_is_consent_needed()
    {
        var msal = new ArmMsal { ArmNeedsUi = true };
        var service = new AccountService(_ => msal, new JsonFileStore(_dir));
        var account = await service.SignInInteractiveAsync(ClientConfig.AzureCli, Ct);
        msal.ArmUiFailure = new MsalUiRequiredException("invalid_grant",
            "AADSTS65001: The user or administrator has not consented to use the application.");

        var consent = await Assert.ThrowsAsync<ConsentRequiredException>(() => service.GetTokenAsync(account.Key, Audience.Arm, Ct));

        Assert.Equal("arm", consent.Audience);
        Assert.False(Assert.Single(await service.ListAccountsAsync()).Expired);
    }

    /// <summary>Ruling 7 (amended): consent and Conditional Access step-up on the ARM scope are what an interactive acquire for
    /// that scope ("Grant Azure access") clears, so each is consent needed, and the Graph sign-in is left as it is.</summary>
    [Theory]
    [InlineData("invalid_grant", "consent needed", UiRequiredExceptionClassification.ConsentRequired)]
    [InlineData("interaction_required", "AADSTS50076: You must use multi-factor authentication.", UiRequiredExceptionClassification.AdditionalAction)]
    [InlineData("invalid_grant", "AADSTS50078: Presented multi-factor authentication has expired.", UiRequiredExceptionClassification.BasicAction)]
    public async Task Arm_consent_and_conditional_access_need_azure_access_and_leave_graph_alone(string code, string message,
        UiRequiredExceptionClassification classification)
    {
        var msal = new ArmMsal { ArmNeedsUi = true };
        var service = new AccountService(_ => msal, new JsonFileStore(_dir));
        var account = await service.SignInInteractiveAsync(ClientConfig.AzureCli, Ct);
        msal.ArmUiFailure = new MsalUiRequiredException(code, message, null, classification);

        var consent = await Assert.ThrowsAsync<ConsentRequiredException>(() => service.GetTokenAsync(account.Key, Audience.Arm, Ct));

        Assert.Equal("arm", consent.Audience);
        Assert.False(Assert.Single(await service.ListAccountsAsync()).Expired);
        Assert.Equal("graph-token", await service.GetTokenAsync(account.Key, Audience.Graph, Ct));
    }

    /// <summary>Ruling 7: any other ARM ui-required (no classification, an expired or revoked refresh token, an expired
    /// password, a failed silent acquire) is a sign-in to renew, and still leaves the Graph sign-in as it is.</summary>
    [Theory]
    [InlineData("invalid_grant", "AADSTS700082: The refresh token has expired due to inactivity.", UiRequiredExceptionClassification.None)]
    [InlineData("invalid_grant", "AADSTS50173: The provided grant has expired due to it being revoked.", UiRequiredExceptionClassification.None)]
    [InlineData("invalid_grant", "AADSTS50055: The password is expired.", UiRequiredExceptionClassification.UserPasswordExpired)]
    [InlineData("invalid_grant", "The refresh token couldn't be used.", UiRequiredExceptionClassification.AcquireTokenSilentFailed)]
    [InlineData("invalid_grant", "Something is needed.", UiRequiredExceptionClassification.MessageOnly)]
    public async Task Arm_ui_required_other_than_consent_needs_sign_in_and_leaves_graph_alone(string code, string message,
        UiRequiredExceptionClassification classification)
    {
        var msal = new ArmMsal { ArmNeedsUi = true };
        var service = new AccountService(_ => msal, new JsonFileStore(_dir));
        var account = await service.SignInInteractiveAsync(ClientConfig.AzureCli, Ct);
        msal.ArmUiFailure = new MsalUiRequiredException(code, message, null, classification);

        await Assert.ThrowsAsync<SignInRequiredException>(() => service.GetTokenAsync(account.Key, Audience.Arm, Ct));

        Assert.False(Assert.Single(await service.ListAccountsAsync()).Expired);
        Assert.Equal("graph-token", await service.GetTokenAsync(account.Key, Audience.Graph, Ct));
    }

    [Fact]
    public async Task Arm_ui_required_after_an_expired_graph_sign_in_leaves_it_expired()
    {
        var msal = new ArmMsal();
        var service = new AccountService(_ => msal, new JsonFileStore(_dir));
        var account = await service.SignInInteractiveAsync(ClientConfig.AzureCli, Ct);
        msal.GraphNeedsUi = true;
        await Assert.ThrowsAsync<SignInRequiredException>(() => service.GetTokenAsync(account.Key, Audience.Graph, Ct));
        msal.ArmNeedsUi = true;

        msal.ArmUiFailure = new MsalUiRequiredException("invalid_grant", "AADSTS700082: The refresh token has expired.");
        await Assert.ThrowsAsync<SignInRequiredException>(() => service.GetTokenAsync(account.Key, Audience.Arm, Ct));
        msal.ArmUiFailure = null;
        await Assert.ThrowsAsync<ConsentRequiredException>(() => service.GetTokenAsync(account.Key, Audience.Arm, Ct));

        Assert.True(Assert.Single(await service.ListAccountsAsync()).Expired);
    }

    [Fact]
    public async Task Graph_ui_required_still_expires_the_account()
    {
        var msal = new ArmMsal();
        var service = new AccountService(_ => msal, new JsonFileStore(_dir));
        var account = await service.SignInInteractiveAsync(ClientConfig.AzureCli, Ct);
        msal.GraphNeedsUi = true;

        await Assert.ThrowsAsync<SignInRequiredException>(() => service.GetTokenAsync(account.Key, Audience.Graph, Ct));

        Assert.True(Assert.Single(await service.ListAccountsAsync()).Expired);
    }

    [Fact]
    public async Task Arm_handler_attaches_token_only_for_management_azure_com()
    {
        var tokens = new FixedTokens("arm-tok");
        var inner = new RecordingHandler();
        using var client = new HttpClient(new ArmAuthHandler(tokens) { InnerHandler = inner });

        await SendForAccountAsync(client, "https://management.azure.com/providers/Microsoft.ResourceGraph/resources?api-version=2024-04-01");
        await SendForAccountAsync(client, "https://MANAGEMENT.azure.com/subscriptions?api-version=2022-12-01");
        await SendForAccountAsync(client, "https://management.azure.com.evil/x", leak: true);
        await SendForAccountAsync(client, "https://management.azure.com.evil.example/x", leak: true);
        await SendForAccountAsync(client, "http://management.azure.com/x", leak: true);
        await SendForAccountAsync(client, "https://graph.microsoft.com/beta/x", leak: true);

        Assert.Equal("Bearer arm-tok", inner.Seen[0]);
        Assert.Equal("Bearer arm-tok", inner.Seen[1]);
        Assert.All(inner.Seen.Skip(2), a => Assert.Null(a));
        Assert.Equal([(Audience.Arm, "acct-1"), (Audience.Arm, "acct-1")], tokens.AskedFor);
    }

    [Fact]
    public async Task Arm_handler_refuses_a_request_that_names_no_account()
    {
        var tokens = new FixedTokens("arm-tok");
        var inner = new RecordingHandler();
        using var client = new HttpClient(new ArmAuthHandler(tokens) { InnerHandler = inner });

        await Assert.ThrowsAsync<SignInRequiredException>(() =>
            client.GetAsync("https://management.azure.com/subscriptions?api-version=2022-12-01", Ct));

        Assert.Empty(tokens.AskedFor);
        Assert.Empty(inner.Seen);
    }

    [Fact]
    public void Arm_client_does_not_follow_redirects()
    {
        var tokens = new FixedTokens("arm-tok");

        var handler = ArmHttp.CreateHandler(tokens);
        using var client = ArmHttp.CreateClient(tokens);

        var auth = Assert.IsType<ArmAuthHandler>(handler);
        var diagnostics = Assert.IsType<DiagnosticsHandler>(auth.InnerHandler);
        var sockets = Assert.IsType<SocketsHttpHandler>(diagnostics.InnerHandler);
        Assert.False(sockets.AllowAutoRedirect);
        Assert.Equal(new Uri("https://management.azure.com/"), client.BaseAddress);
        handler.Dispose();
    }

    [Fact]
    public async Task Consent_acquires_arm_scope_with_login_hint()
    {
        var msal = new ArmMsal();
        var service = new AccountService(_ => msal, new JsonFileStore(_dir));
        var account = await service.SignInInteractiveAsync(ClientConfig.AzureCli, Ct);
        msal.ArmNeedsUi = true;

        await service.ConsentAsync(account.Key, Audience.Arm, Ct);

        var consent = msal.Interactive[^1];
        Assert.Equal(("https://management.azure.com/.default", "ada@contoso.com"), consent);
        Assert.Equal(("https://graph.microsoft.com/.default", (string?)null), msal.Interactive[0]);
        Assert.Equal("arm-token", await service.GetTokenAsync(account.Key, Audience.Arm, Ct));
        Assert.Equal(account.Key, service.ActiveAccountKey);
        Assert.Empty(msal.DeviceCodes);
    }

    [Fact]
    public async Task Consent_falls_back_to_device_code_when_no_browser_can_open()
    {
        var msal = new ArmMsal();
        var service = new AccountService(_ => msal, new JsonFileStore(_dir));
        var account = await service.SignInInteractiveAsync(ClientConfig.AzureCli, Ct);
        msal.ArmNeedsUi = true;
        msal.InteractiveFails = new MsalClientException(MsalError.LinuxXdgOpen, "no browser");
        string? shown = null;

        await service.ConsentAsync(account.Key, Audience.Arm, Ct, m => shown = m);

        Assert.Equal(["https://management.azure.com/.default"], msal.DeviceCodes);
        Assert.Equal(ArmMsal.DeviceCodeMessage, shown);
        Assert.Equal("arm-token", await service.GetTokenAsync(account.Key, Audience.Arm, Ct));
    }

    [Fact]
    public async Task Consent_cancelled_in_the_browser_does_not_fall_back()
    {
        var msal = new ArmMsal();
        var service = new AccountService(_ => msal, new JsonFileStore(_dir));
        var account = await service.SignInInteractiveAsync(ClientConfig.AzureCli, Ct);
        msal.InteractiveFails = new MsalClientException(MsalError.AuthenticationCanceledError, "cancelled");

        await Assert.ThrowsAsync<MsalClientException>(() => service.ConsentAsync(account.Key, Audience.Arm, Ct, _ => { }));

        Assert.Empty(msal.DeviceCodes);
    }

    [Fact]
    public async Task Consent_for_an_unknown_account_needs_sign_in()
    {
        var service = new AccountService(_ => new ArmMsal(), new JsonFileStore(_dir));

        await Assert.ThrowsAsync<SignInRequiredException>(() => service.ConsentAsync("nobody", Audience.Arm, Ct));
    }

    [Fact]
    public async Task Account_consent_over_the_bridge_answers_empty_object()
    {
        var msal = new ArmMsal();
        var service = new AccountService(_ => msal, new JsonFileStore(_dir));
        var account = await service.SignInInteractiveAsync(ClientConfig.AzureCli, Ct);
        var bridge = new Messaging.Bridge(_ => { });
        new AccountHandler(service, new MemoryOnly("x"), new MemoryGraphObjectCache(TimeProvider.System), NoGraphProbeCache.Instance).Register(bridge);

        var ok = await Send(bridge, "account.consent", new { key = account.Key, audience = "arm" });
        var badAudience = await Send(bridge, "account.consent", new { key = account.Key, audience = "graph" });
        var noKey = await Send(bridge, "account.consent", new { audience = "arm" });

        Assert.Equal(JsonValueKind.Object, ok.GetProperty("result").ValueKind);
        Assert.Empty(ok.GetProperty("result").EnumerateObject());
        Assert.Equal(("https://management.azure.com/.default", "ada@contoso.com"), msal.Interactive[^1]);
        Assert.Equal("bad_request", badAudience.GetProperty("error").GetProperty("code").GetString());
        Assert.Equal("bad_request", noKey.GetProperty("error").GetProperty("code").GetString());
    }

    [Fact]
    public async Task Consent_as_another_account_is_refused_and_the_stray_account_removed()
    {
        var msal = new ArmMsal();
        var service = new AccountService(_ => msal, new JsonFileStore(_dir));
        var account = await service.SignInInteractiveAsync(ClientConfig.AzureCli, Ct);
        msal.ArmNeedsUi = true;
        msal.GrantAs = new MsalAccount("home-9", "mallory@fabrikam.com", "tenant-9");

        var refused = await Assert.ThrowsAsync<InvalidOperationException>(() => service.ConsentAsync(account.Key, Audience.Arm, Ct));

        Assert.Equal("You granted access as mallory@fabrikam.com; sign in as ada@contoso.com.", refused.Message);
        Assert.Equal(["home-9"], msal.Removed);
        Assert.Equal(["home-1"], msal.Cached);
        await Assert.ThrowsAsync<ConsentRequiredException>(() => service.GetTokenAsync(account.Key, Audience.Arm, Ct));
    }

    [Fact]
    public async Task Consent_as_another_account_already_cached_keeps_it()
    {
        var msal = new ArmMsal();
        var service = new AccountService(_ => msal, new JsonFileStore(_dir));
        var account = await service.SignInInteractiveAsync(ClientConfig.AzureCli, Ct);
        var bob = new MsalAccount("home-2", "bob@fabrikam.com", "tenant-2");
        msal.Cache(bob);
        msal.GrantAs = bob;

        var refused = await Assert.ThrowsAsync<InvalidOperationException>(() => service.ConsentAsync(account.Key, Audience.Arm, Ct));

        Assert.Equal("You granted access as bob@fabrikam.com; sign in as ada@contoso.com.", refused.Message);
        Assert.Empty(msal.Removed);
        Assert.Contains("home-2", msal.Cached);
    }

    [Fact]
    public async Task Arm_token_for_an_account_msal_no_longer_has_needs_sign_in_but_is_not_marked_expired()
    {
        var msal = new ArmMsal();
        var service = new AccountService(_ => msal, new JsonFileStore(_dir));
        var account = await service.SignInInteractiveAsync(ClientConfig.AzureCli, Ct);
        msal.ForgetAccount = true;

        await Assert.ThrowsAsync<SignInRequiredException>(() => service.GetTokenAsync(account.Key, Audience.Arm, Ct));

        msal.ForgetAccount = false;
        Assert.False(Assert.Single(await service.ListAccountsAsync()).Expired);
    }

    [Fact]
    public async Task Arm_success_leaves_an_expired_graph_sign_in_expired()
    {
        var msal = new ArmMsal();
        var service = new AccountService(_ => msal, new JsonFileStore(_dir));
        var account = await service.SignInInteractiveAsync(ClientConfig.AzureCli, Ct);
        msal.GraphNeedsUi = true;
        await Assert.ThrowsAsync<SignInRequiredException>(() => service.GetTokenAsync(account.Key, Audience.Graph, Ct));

        Assert.Equal("arm-token", await service.GetTokenAsync(account.Key, Audience.Arm, Ct));

        Assert.True(Assert.Single(await service.ListAccountsAsync()).Expired);
    }

    [Fact]
    public async Task Account_consent_cancelled_by_the_user_answers_cancelled()
    {
        var msal = new ArmMsal();
        var service = new AccountService(_ => msal, new JsonFileStore(_dir));
        var account = await service.SignInInteractiveAsync(ClientConfig.AzureCli, Ct);
        msal.InteractiveFails = new MsalClientException(MsalError.AuthenticationCanceledError, "User canceled authentication.");
        var bridge = new Messaging.Bridge(_ => { });
        new AccountHandler(service, new MemoryOnly("x"), new MemoryGraphObjectCache(TimeProvider.System), NoGraphProbeCache.Instance).Register(bridge);

        var reply = await Send(bridge, "account.consent", new { key = account.Key, audience = "arm" });

        Assert.Equal("cancelled", reply.GetProperty("error").GetProperty("code").GetString());
        Assert.Empty(msal.DeviceCodes);
    }

    [Fact]
    public async Task Consent_needed_maps_to_run_outcome()
    {
        var arg = new FakeSource("arg", (_, _, _, _, _, _, _) =>
            throw new HttpRequestException("wrapped", new ConsentRequiredException("arm")));
        var recent = new RecentService(new JsonFileStore(_dir));
        var bridge = new Messaging.Bridge(_ => { });
        new QueryHandler(GraphSchemaCatalog.Beta, () => Task.FromResult<string?>("acct-1"), FakeSource.Map(arg), recent)
            .Register(bridge);

        var reply = await Send(bridge, "query.run", new { tabId = "t1", source = "arg", kql = "resources", refresh = false, runId = RunId });

        var result = reply.GetProperty("result");
        Assert.Equal("consentNeeded", result.GetProperty("outcome").GetString());
        Assert.Equal(ConsentMessage, result.GetProperty("message").GetString());
        Assert.Equal(RunId, result.GetProperty("runId").GetString());
        Assert.Single(arg.Requests);
        var recorded = Assert.Single(await recent.ListAsync(Ct));
        Assert.Equal(("arg", "resources", "consentNeeded"), (recorded.Source, recorded.Text, recorded.Outcome));
    }

    private static async Task SendForAccountAsync(HttpClient client, string url, bool leak = false)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, url).ForAccount("acct-1");
        if (leak)
        {
            request.Headers.Authorization = new("Bearer", "leak");
        }

        using var response = await client.SendAsync(request, Ct);
    }

    private static async Task<JsonElement> Send(Messaging.Bridge bridge, string method, object parameters)
    {
        var reply = await bridge.HandleAsync(JsonSerializer.Serialize(new { id = "1", method, @params = parameters }));
        Assert.NotNull(reply);
        using var doc = JsonDocument.Parse(reply);
        return doc.RootElement.Clone();
    }

    private sealed class FixedTokens(string token) : ITokenSource
    {
        public List<(Audience, string)> AskedFor { get; } = [];

        public Task<string> GetTokenAsync(string accountKey, Audience audience, CancellationToken ct)
        {
            AskedFor.Add((audience, accountKey));
            return Task.FromResult(token);
        }
    }

    private sealed class RecordingHandler : HttpMessageHandler
    {
        public List<string?> Seen { get; } = [];

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Seen.Add(request.Headers.Authorization?.ToString());
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK));
        }
    }

    /// <summary>MSAL with one account whose Graph and ARM tokens can each need the user. An interactive or device-code acquire
    /// for the ARM scope grants it, as <see cref="GrantAs"/> when set (the user picked another account in the browser).</summary>
    private sealed class ArmMsal : IMsalClient
    {
        public const string DeviceCodeMessage = "Go to https://microsoft.com/devicelogin and enter ARM";

        private readonly MsalAccount _account = new("home-1", "ada@contoso.com", "tenant-1");
        private readonly Dictionary<string, MsalAccount> _cached = [];

        public bool GraphNeedsUi { get; set; }

        public bool ArmNeedsUi { get; set; }

        /// <summary>What a silent ARM acquire throws while <see cref="ArmNeedsUi"/>; a consent-classified failure when null.</summary>
        public MsalUiRequiredException? ArmUiFailure { get; set; }

        public bool ForgetAccount { get; set; }

        public Exception? InteractiveFails { get; set; }

        public MsalAccount? GrantAs { get; set; }

        public List<(string Scope, string? LoginHint)> Interactive { get; } = [];

        public List<string> DeviceCodes { get; } = [];

        public List<string> Removed { get; } = [];

        public IReadOnlyCollection<string> Cached => _cached.Keys;

        public void Cache(MsalAccount account) => _cached[account.HomeAccountId] = account;

        public Task<MsalSignIn> AcquireInteractiveAsync(string scope, string? loginHint, CancellationToken ct)
        {
            Interactive.Add((scope, loginHint));
            if (InteractiveFails is { } failure && scope == Audience.Arm.ScopeFor())
            {
                throw failure;
            }

            return Task.FromResult(Grant(scope));
        }

        public Task<MsalSignIn> AcquireDeviceCodeAsync(string scope, Action<string> showCode, CancellationToken ct)
        {
            DeviceCodes.Add(scope);
            showCode(DeviceCodeMessage);
            return Task.FromResult(Grant(scope));
        }

        public Task<MsalToken> AcquireSilentAsync(string homeAccountId, string scope, CancellationToken ct)
        {
            if (ForgetAccount || !_cached.ContainsKey(homeAccountId))
            {
                throw new MsalUiRequiredException(MsalError.UserNullError, "The account is no longer in the token cache.");
            }

            var arm = scope == Audience.Arm.ScopeFor();
            if (arm && ArmNeedsUi)
            {
                throw ArmUiFailure ?? new MsalUiRequiredException("invalid_grant", "consent needed", null,
                    UiRequiredExceptionClassification.ConsentRequired);
            }

            if (!arm && GraphNeedsUi)
            {
                throw new MsalUiRequiredException("ui_required", "interaction required");
            }

            return Task.FromResult(new MsalToken(arm ? "arm-token" : "graph-token", DateTimeOffset.UtcNow.AddHours(1)));
        }

        public Task<IReadOnlyList<MsalAccount>> GetAccountsAsync() =>
            Task.FromResult<IReadOnlyList<MsalAccount>>(ForgetAccount ? [] : [.. _cached.Values]);

        public Task RemoveAsync(string homeAccountId)
        {
            Removed.Add(homeAccountId);
            _cached.Remove(homeAccountId);
            return Task.CompletedTask;
        }

        private MsalSignIn Grant(string scope)
        {
            var account = scope == Audience.Arm.ScopeFor() && GrantAs is { } other ? other : _account;
            _cached[account.HomeAccountId] = account;
            if (scope == Audience.Arm.ScopeFor() && account == _account)
            {
                ArmNeedsUi = false;
            }

            return new MsalSignIn(account, new MsalToken("not-a-jwt", DateTimeOffset.UtcNow.AddHours(1)));
        }
    }
}
