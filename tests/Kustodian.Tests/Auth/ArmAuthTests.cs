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
using Microsoft.Extensions.Time.Testing;
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
        Assert.Equal(("https://management.azure.com/.default", "ada@contoso.com", false), consent);
        Assert.Equal(("https://graph.microsoft.com/.default", (string?)null, false), msal.Interactive[0]);
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
        var graphWithoutScope = await Send(bridge, "account.consent", new { key = account.Key, audience = "graph" });
        var badAudience = await Send(bridge, "account.consent", new { key = account.Key, audience = "kusto" });
        var noKey = await Send(bridge, "account.consent", new { audience = "arm" });

        Assert.Equal(JsonValueKind.Object, ok.GetProperty("result").ValueKind);
        Assert.Empty(ok.GetProperty("result").EnumerateObject());
        Assert.Equal(("https://management.azure.com/.default", "ada@contoso.com", false), msal.Interactive[^1]);
        Assert.Equal("bad_request", graphWithoutScope.GetProperty("error").GetProperty("code").GetString());
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

    [Fact]
    public async Task Graph_cli_account_gets_its_arm_token_from_the_azure_cli_client_for_the_same_home_account()
    {
        var clients = new MsalPerClient();
        var service = new AccountService(clients.Create, new JsonFileStore(_dir));
        var account = await service.SignInInteractiveAsync(ClientConfig.GraphCli, Ct);
        clients.For(ClientConfig.AzureCli).Cache(ArmMsal.Ada);

        Assert.Equal("azure-cli:arm-token", await service.GetTokenAsync(account.Key, Audience.Arm, Ct));

        Assert.DoesNotContain(clients.For(ClientConfig.GraphCli).Silent, s => s.Scope == Audience.Arm.ScopeFor());
    }

    [Fact]
    public async Task Graph_cli_account_without_an_azure_cli_sign_in_needs_azure_consent_and_stays_valid()
    {
        var clients = new MsalPerClient();
        var service = new AccountService(clients.Create, new JsonFileStore(_dir));
        var account = await service.SignInInteractiveAsync(ClientConfig.GraphCli, Ct);

        var consent = await Assert.ThrowsAsync<ConsentRequiredException>(() => service.GetTokenAsync(account.Key, Audience.Arm, Ct));

        Assert.Equal("arm", consent.Audience);
        Assert.False(Assert.Single(await service.ListAccountsAsync()).Expired);
    }

    [Fact]
    public async Task Azure_consent_for_a_graph_cli_account_signs_in_the_azure_cli_client_with_a_login_hint()
    {
        var clients = new MsalPerClient();
        var service = new AccountService(clients.Create, new JsonFileStore(_dir));
        var account = await service.SignInInteractiveAsync(ClientConfig.GraphCli, Ct);

        await service.ConsentAsync(account.Key, Audience.Arm, Ct);

        Assert.Equal([("https://management.azure.com/.default", "ada@contoso.com", false)],
            clients.For(ClientConfig.AzureCli).Interactive);
        Assert.Equal([("https://graph.microsoft.com/.default", (string?)null, false)], clients.For(ClientConfig.GraphCli).Interactive);
        Assert.Equal("azure-cli:arm-token", await service.GetTokenAsync(account.Key, Audience.Arm, Ct));
        var listed = Assert.Single(await service.ListAccountsAsync());
        Assert.Equal(ClientKind.GraphCli, listed.ClientKind);
    }

    [Fact]
    public async Task Azure_consent_for_a_graph_cli_account_as_another_account_is_refused_on_the_azure_cli_client()
    {
        var clients = new MsalPerClient();
        var service = new AccountService(clients.Create, new JsonFileStore(_dir));
        var account = await service.SignInInteractiveAsync(ClientConfig.GraphCli, Ct);
        var azureCli = clients.For(ClientConfig.AzureCli);
        azureCli.GrantAs = new MsalAccount("home-9", "mallory@fabrikam.com", "tenant-9");

        await Assert.ThrowsAsync<InvalidOperationException>(() => service.ConsentAsync(account.Key, Audience.Arm, Ct));

        Assert.Equal(["home-9"], azureCli.Removed);
        Assert.Empty(azureCli.Cached);
        Assert.Empty(clients.For(ClientConfig.GraphCli).Removed);
    }

    /// <summary>The token cache is shared: removing the stray pick on the Azure CLI client would sign out a listed account of that
    /// user on another client.</summary>
    [Fact]
    public async Task Azure_consent_as_another_listed_graph_cli_account_keeps_that_account_signed_in()
    {
        var clients = new MsalPerClient();
        var service = new AccountService(clients.Create, new JsonFileStore(_dir));
        var ada = await service.SignInInteractiveAsync(ClientConfig.GraphCli, Ct);
        var graphCli = clients.For(ClientConfig.GraphCli);
        var bob = new MsalAccount("home-2", "bob@contoso.com", "tenant-1");
        graphCli.SignsInAs = bob;
        var bobAccount = await service.SignInInteractiveAsync(ClientConfig.GraphCli, Ct);
        graphCli.SignsInAs = ArmMsal.Ada;
        var azureCli = clients.For(ClientConfig.AzureCli);
        azureCli.GrantAs = bob;

        await Assert.ThrowsAsync<InvalidOperationException>(() => service.ConsentAsync(ada.Key, Audience.Arm, Ct));

        Assert.Empty(azureCli.Removed);
        Assert.Contains("home-2", graphCli.Cached);
        var listed = (await service.ListAccountsAsync()).Single(a => a.Key == bobAccount.Key);
        Assert.False(listed.Expired);
        Assert.Equal("graph-cli:graph-token", await service.GetTokenAsync(bobAccount.Key, Audience.Graph, Ct));
    }

    [Fact]
    public async Task Graph_cli_account_in_a_guest_tenant_asks_azure_cli_for_that_tenant()
    {
        var clients = new MsalPerClient();
        var service = new AccountService(clients.Create, new JsonFileStore(_dir));
        var account = await service.SignInInteractiveAsync(new ClientConfig(ClientConfig.GraphCliClientId, "guest-tenant-id"), Ct);
        var guestAzureCli = new ClientConfig(ClientConfig.AzureCliClientId, "guest-tenant-id");
        clients.For(guestAzureCli).Cache(ArmMsal.Ada);

        Assert.Equal("azure-cli:arm-token", await service.GetTokenAsync(account.Key, Audience.Arm, Ct));
        await service.ConsentAsync(account.Key, Audience.Arm, Ct);

        Assert.Contains(guestAzureCli, clients.AskedFor);
        Assert.DoesNotContain(ClientConfig.AzureCli, clients.AskedFor);
    }

    [Fact]
    public async Task Graph_cli_account_still_uses_its_own_client_for_graph()
    {
        var clients = new MsalPerClient();
        var service = new AccountService(clients.Create, new JsonFileStore(_dir));
        var account = await service.SignInInteractiveAsync(ClientConfig.GraphCli, Ct);
        clients.For(ClientConfig.AzureCli).Cache(ArmMsal.Ada);

        Assert.Equal("graph-cli:graph-token", await service.GetTokenAsync(account.Key, Audience.Graph, Ct));

        Assert.Empty(clients.For(ClientConfig.AzureCli).Silent);
    }

    [Fact]
    public async Task Own_app_account_uses_its_own_client_for_arm()
    {
        var own = new ClientConfig("11111111-2222-3333-4444-555555555555", "contoso.onmicrosoft.com");
        var clients = new MsalPerClient();
        var service = new AccountService(clients.Create, new JsonFileStore(_dir));
        var account = await service.SignInInteractiveAsync(own, Ct);

        Assert.Equal("own:arm-token", await service.GetTokenAsync(account.Key, Audience.Arm, Ct));
        await service.ConsentAsync(account.Key, Audience.Arm, Ct);

        Assert.Equal([own], clients.AskedFor);
    }

    [Fact]
    public async Task Signing_out_graph_cli_leaves_a_listed_azure_cli_account_for_that_user_signed_in()
    {
        var clients = new MsalPerClient();
        var service = new AccountService(clients.Create, new JsonFileStore(_dir));
        var azureCli = await service.SignInInteractiveAsync(ClientConfig.AzureCli, Ct);
        var graphCli = await service.SignInInteractiveAsync(ClientConfig.GraphCli, Ct);

        await service.SignOutAsync(graphCli.Key);

        var listed = Assert.Single(await service.ListAccountsAsync());
        Assert.Equal(azureCli.Key, listed.Key);
        Assert.False(listed.Expired);
        Assert.Equal("azure-cli:graph-token", await service.GetTokenAsync(azureCli.Key, Audience.Graph, Ct));
        Assert.Equal("azure-cli:arm-token", await service.GetTokenAsync(azureCli.Key, Audience.Arm, Ct));
    }

    [Fact]
    public async Task Signing_out_azure_cli_leaves_a_listed_graph_cli_account_for_that_user_signed_in()
    {
        var clients = new MsalPerClient();
        var service = new AccountService(clients.Create, new JsonFileStore(_dir));
        var azureCli = await service.SignInInteractiveAsync(ClientConfig.AzureCli, Ct);
        var graphCli = await service.SignInInteractiveAsync(ClientConfig.GraphCli, Ct);

        await service.SignOutAsync(azureCli.Key);

        var listed = Assert.Single(await service.ListAccountsAsync());
        Assert.Equal(graphCli.Key, listed.Key);
        Assert.False(listed.Expired);
        Assert.Equal("graph-cli:graph-token", await service.GetTokenAsync(graphCli.Key, Audience.Graph, Ct));
        Assert.Equal("azure-cli:arm-token", await service.GetTokenAsync(graphCli.Key, Audience.Arm, Ct));
    }

    [Fact]
    public async Task Signing_out_an_own_app_account_leaves_a_listed_azure_cli_account_for_that_user_signed_in()
    {
        var own = new ClientConfig("11111111-2222-3333-4444-555555555555", "contoso.onmicrosoft.com");
        var clients = new MsalPerClient();
        var service = new AccountService(clients.Create, new JsonFileStore(_dir));
        var azureCli = await service.SignInInteractiveAsync(ClientConfig.AzureCli, Ct);
        var ownApp = await service.SignInInteractiveAsync(own, Ct);

        await service.SignOutAsync(ownApp.Key);

        var listed = Assert.Single(await service.ListAccountsAsync());
        Assert.Equal(azureCli.Key, listed.Key);
        Assert.False(listed.Expired);
        Assert.Equal("azure-cli:graph-token", await service.GetTokenAsync(azureCli.Key, Audience.Graph, Ct));
        Assert.Equal("azure-cli:arm-token", await service.GetTokenAsync(azureCli.Key, Audience.Arm, Ct));
    }

    [Fact]
    public async Task Signing_out_the_last_account_for_a_user_removes_it_from_the_cache()
    {
        var clients = new MsalPerClient();
        var service = new AccountService(clients.Create, new JsonFileStore(_dir));
        var azureCli = await service.SignInInteractiveAsync(ClientConfig.AzureCli, Ct);
        var graphCli = await service.SignInInteractiveAsync(ClientConfig.GraphCli, Ct);
        await service.ConsentAsync(graphCli.Key, Audience.Arm, Ct);
        await service.SignOutAsync(azureCli.Key);

        await service.SignOutAsync(graphCli.Key);

        Assert.Empty(await service.ListAccountsAsync());
        Assert.Contains("home-1", clients.For(ClientConfig.GraphCli).Removed);
        Assert.Contains("home-1", clients.For(ClientConfig.AzureCli).Removed);
        Assert.Empty(clients.For(ClientConfig.GraphCli).Cached);
        Assert.Empty(clients.For(ClientConfig.AzureCli).Cached);
        await Assert.ThrowsAsync<SignInRequiredException>(() => service.GetTokenAsync(graphCli.Key, Audience.Graph, Ct));
    }

    [Fact]
    public async Task Graph_consent_asks_for_the_one_permission_with_prompt_consent_and_a_login_hint()
    {
        var clients = new MsalPerClient();
        var service = new AccountService(clients.Create, new JsonFileStore(_dir));
        var account = await service.SignInInteractiveAsync(ClientConfig.GraphCli, Ct);

        await service.ConsentAsync(account.Key, Audience.Graph, Ct, scope: "Reports.Read.All");

        var graphCli = clients.For(ClientConfig.GraphCli);
        Assert.Equal(("https://graph.microsoft.com/Reports.Read.All", "ada@contoso.com", true), graphCli.Interactive[^1]);
        Assert.Empty(clients.For(ClientConfig.AzureCli).Interactive);
        Assert.Empty(graphCli.DeviceCodes);
    }

    [Fact]
    public async Task Graph_consent_falls_back_to_device_code_when_no_browser_can_open()
    {
        var clients = new MsalPerClient();
        var service = new AccountService(clients.Create, new JsonFileStore(_dir));
        var account = await service.SignInInteractiveAsync(ClientConfig.GraphCli, Ct);
        var graphCli = clients.For(ClientConfig.GraphCli);
        graphCli.InteractiveFails = new MsalClientException(MsalError.LinuxXdgOpen, "no browser");
        string? shown = null;

        await service.ConsentAsync(account.Key, Audience.Graph, Ct, m => shown = m, "Reports.Read.All");

        Assert.Equal(["https://graph.microsoft.com/Reports.Read.All"], graphCli.DeviceCodes);
        Assert.Equal(ArmMsal.DeviceCodeMessage, shown);
        Assert.Contains("Reports.Read.All", Assert.Single(await service.ListAccountsAsync()).Scopes);
    }

    [Fact]
    public async Task Graph_consent_refreshes_the_default_token_and_stores_the_new_scopes()
    {
        var clients = new MsalPerClient();
        var service = new AccountService(clients.Create, new JsonFileStore(_dir));
        var account = await service.SignInInteractiveAsync(ClientConfig.GraphCli, Ct);

        await service.ConsentAsync(account.Key, Audience.Graph, Ct, scope: "Reports.Read.All");

        Assert.Equal(("https://graph.microsoft.com/.default", true), clients.For(ClientConfig.GraphCli).Silent[^1]);
        Assert.Contains("Reports.Read.All", (await service.ListAccountsAsync())[0].Scopes);
        var reloaded = new AccountService(clients.Create, new JsonFileStore(_dir));
        Assert.Contains("Reports.Read.All", (await reloaded.ListAccountsAsync())[0].Scopes);
    }

    [Fact]
    public async Task Graph_consent_refreshes_again_until_the_token_carries_the_grant()
    {
        var clients = new MsalPerClient();
        var time = new FakeTimeProvider();
        var service = new AccountService(clients.Create, new JsonFileStore(_dir), time);
        var account = await service.SignInInteractiveAsync(ClientConfig.GraphCli, Ct);
        var graphCli = clients.For(ClientConfig.GraphCli);
        graphCli.GrantHiddenForRefreshes = 2;

        await Advancing(time, service.ConsentAsync(account.Key, Audience.Graph, Ct, scope: "Reports.Read.All"));

        Assert.Equal(3, graphCli.Silent.Count(s => s.ForceRefresh));
        Assert.Contains("Reports.Read.All", (await service.ListAccountsAsync())[0].Scopes);
        // The grant arrived: later tokens come from the cache again.
        await service.GetTokenAsync(account.Key, Audience.Graph, Ct);
        Assert.False(graphCli.Silent[^1].ForceRefresh);
    }

    [Fact]
    public async Task A_grant_still_missing_after_consent_is_refreshed_for_now_and_then_until_it_arrives()
    {
        var clients = new MsalPerClient();
        var time = new FakeTimeProvider();
        var service = new AccountService(clients.Create, new JsonFileStore(_dir), time);
        var account = await service.SignInInteractiveAsync(ClientConfig.GraphCli, Ct);
        var graphCli = clients.For(ClientConfig.GraphCli);
        graphCli.GrantHiddenForRefreshes = 5;

        await Advancing(time, service.ConsentAsync(account.Key, Audience.Graph, Ct, scope: "Reports.Read.All"));

        Assert.Equal(4, graphCli.Silent.Count(s => s.ForceRefresh));
        Assert.DoesNotContain("Reports.Read.All", (await service.ListAccountsAsync())[0].Scopes);

        // Right after the last refresh, a run's token comes from the cache; 15 seconds on, it is refreshed again.
        time.Advance(TimeSpan.FromSeconds(1));
        await service.GetTokenAsync(account.Key, Audience.Graph, Ct);
        Assert.False(graphCli.Silent[^1].ForceRefresh);
        time.Advance(TimeSpan.FromSeconds(15));
        await service.GetTokenAsync(account.Key, Audience.Graph, Ct);
        Assert.True(graphCli.Silent[^1].ForceRefresh);
        Assert.DoesNotContain("Reports.Read.All", (await service.ListAccountsAsync())[0].Scopes);

        time.Advance(TimeSpan.FromSeconds(15));
        await service.GetTokenAsync(account.Key, Audience.Graph, Ct);
        Assert.True(graphCli.Silent[^1].ForceRefresh);
        Assert.Contains("Reports.Read.All", (await service.ListAccountsAsync())[0].Scopes);

        time.Advance(TimeSpan.FromSeconds(15));
        await service.GetTokenAsync(account.Key, Audience.Graph, Ct);
        Assert.False(graphCli.Silent[^1].ForceRefresh);
    }

    /// <summary>Awaits <paramref name="task"/>, moving <paramref name="time"/> on a second at a time so its waits end.</summary>
    private static async Task Advancing(FakeTimeProvider time, Task task)
    {
        while (!task.IsCompleted)
        {
            time.Advance(TimeSpan.FromSeconds(1));
            await Task.Delay(5, Ct);
        }

        await task;
    }

    [Fact]
    public async Task Graph_consent_for_an_own_app_account_uses_its_own_client()
    {
        var own = new ClientConfig("11111111-2222-3333-4444-555555555555", "contoso.onmicrosoft.com");
        var clients = new MsalPerClient();
        var service = new AccountService(clients.Create, new JsonFileStore(_dir));
        var account = await service.SignInInteractiveAsync(own, Ct);

        await service.ConsentAsync(account.Key, Audience.Graph, Ct, scope: "Reports.Read.All");

        Assert.Equal([own], clients.AskedFor);
        Assert.Equal(("https://graph.microsoft.com/Reports.Read.All", "ada@contoso.com", true), clients.For(own).Interactive[^1]);
    }

    [Fact]
    public async Task Graph_consent_as_another_account_is_refused_and_the_stray_account_removed()
    {
        var clients = new MsalPerClient();
        var service = new AccountService(clients.Create, new JsonFileStore(_dir));
        var account = await service.SignInInteractiveAsync(ClientConfig.GraphCli, Ct);
        var graphCli = clients.For(ClientConfig.GraphCli);
        graphCli.GrantAs = new MsalAccount("home-9", "mallory@fabrikam.com", "tenant-9");

        var refused = await Assert.ThrowsAsync<InvalidOperationException>(
            () => service.ConsentAsync(account.Key, Audience.Graph, Ct, scope: "Reports.Read.All"));

        Assert.Equal("You granted access as mallory@fabrikam.com; sign in as ada@contoso.com.", refused.Message);
        Assert.Equal(["home-9"], graphCli.Removed);
        Assert.Equal(["home-1"], graphCli.Cached);
        Assert.DoesNotContain(graphCli.Silent, s => s.ForceRefresh);
        Assert.DoesNotContain("Reports.Read.All", Assert.Single(await service.ListAccountsAsync()).Scopes);
    }

    [Fact]
    public async Task Graph_consent_is_refused_for_the_azure_cli_client()
    {
        var clients = new MsalPerClient();
        var service = new AccountService(clients.Create, new JsonFileStore(_dir));
        var account = await service.SignInInteractiveAsync(ClientConfig.AzureCli, Ct);

        await Assert.ThrowsAsync<InvalidOperationException>(
            () => service.ConsentAsync(account.Key, Audience.Graph, Ct, scope: "Reports.Read.All"));

        Assert.Equal([("https://graph.microsoft.com/.default", (string?)null, false)], clients.For(ClientConfig.AzureCli).Interactive);
    }

    [Fact]
    public async Task Graph_consent_needs_a_permission()
    {
        var clients = new MsalPerClient();
        var service = new AccountService(clients.Create, new JsonFileStore(_dir));
        var account = await service.SignInInteractiveAsync(ClientConfig.GraphCli, Ct);

        await Assert.ThrowsAsync<ArgumentException>(() => service.ConsentAsync(account.Key, Audience.Graph, Ct));

        Assert.Single(clients.For(ClientConfig.GraphCli).Interactive);
    }

    [Theory]
    [InlineData("User.ReadWrite.All")]
    [InlineData("User.Readwrite.All")]
    public async Task Graph_consent_refuses_a_permission_that_is_not_read_only(string permission)
    {
        var clients = new MsalPerClient();
        var service = new AccountService(clients.Create, new JsonFileStore(_dir));
        var account = await service.SignInInteractiveAsync(ClientConfig.GraphCli, Ct);

        await Assert.ThrowsAsync<ArgumentException>(() => service.ConsentAsync(account.Key, Audience.Graph, Ct, scope: permission));

        Assert.Single(clients.For(ClientConfig.GraphCli).Interactive);
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

    /// <summary>A client factory that hands out one <see cref="ArmMsal"/> per <see cref="ClientConfig"/>, named after its client,
    /// and records which configs the service asked for. Like Kustodian's one shared MSAL token cache (FOCI included), removing a
    /// home account on any client removes it from every client.</summary>
    private sealed class MsalPerClient
    {
        private readonly Dictionary<ClientConfig, ArmMsal> _clients = [];

        public List<ClientConfig> AskedFor { get; } = [];

        public IMsalClient Create(ClientConfig config)
        {
            AskedFor.Add(config);
            return For(config);
        }

        /// <summary>The fake for <paramref name="config"/>, made on first use; not recorded in <see cref="AskedFor"/>.</summary>
        public ArmMsal For(ClientConfig config)
        {
            if (!_clients.TryGetValue(config, out var msal))
            {
                var name = config.Kind switch
                {
                    ClientKind.AzureCli => "azure-cli:",
                    ClientKind.GraphCli => "graph-cli:",
                    _ => "own:",
                };
                msal = new ArmMsal { TokenPrefix = name, RemovedEverywhere = ForgetEverywhere };
                _clients[config] = msal;
            }

            return msal;
        }

        private void ForgetEverywhere(string homeAccountId)
        {
            foreach (var msal in _clients.Values)
            {
                msal.Forget(homeAccountId);
            }
        }
    }

    /// <summary>MSAL with one account whose Graph and ARM tokens can each need the user. An interactive or device-code acquire
    /// for the ARM scope, or for one Graph permission, grants it, as <see cref="GrantAs"/> when set (the user picked another
    /// account in the browser). A granted Graph permission shows in the <c>scp</c> of the next Graph token refreshed with force;
    /// until then the cached token is unchanged.</summary>
    private sealed class ArmMsal : IMsalClient
    {
        public const string DeviceCodeMessage = "Go to https://microsoft.com/devicelogin and enter ARM";

        /// <summary>The one account this fake signs in.</summary>
        public static readonly MsalAccount Ada = new("home-1", "ada@contoso.com", "tenant-1");

        private readonly Dictionary<string, MsalAccount> _cached = [];

        /// <summary>Put before every token this fake hands out, to tell one client's tokens from another's.</summary>
        public string TokenPrefix { get; init; } = "";

        /// <summary>Called with the home account ID after <see cref="RemoveAsync"/>, to model a token cache shared with other
        /// clients.</summary>
        public Action<string>? RemovedEverywhere { get; init; }

        public bool GraphNeedsUi { get; set; }

        public bool ArmNeedsUi { get; set; }

        /// <summary>What a silent ARM acquire throws while <see cref="ArmNeedsUi"/>; a consent-classified failure when null.</summary>
        public MsalUiRequiredException? ArmUiFailure { get; set; }

        public bool ForgetAccount { get; set; }

        public Exception? InteractiveFails { get; set; }

        public MsalAccount? GrantAs { get; set; }

        /// <summary>The account a sign-in (and a consent without <see cref="GrantAs"/>) lands on; <see cref="Ada"/> by
        /// default.</summary>
        public MsalAccount SignsInAs { get; set; } = Ada;

        public List<(string Scope, string? LoginHint, bool ForceConsent)> Interactive { get; } = [];

        public List<(string Scope, bool ForceRefresh)> Silent { get; } = [];

        public List<string> DeviceCodes { get; } = [];

        public List<string> Removed { get; } = [];

        /// <summary>The Graph permissions granted with forced consent.</summary>
        public List<string> GrantedGraph { get; } = [];

        /// <summary>How many forced Graph refreshes leave the granted permissions out, as Entra ID may just after a grant.</summary>
        public int GrantHiddenForRefreshes { get; set; }

        public IReadOnlyCollection<string> Cached => _cached.Keys;

        public void Cache(MsalAccount account) => _cached[account.HomeAccountId] = account;

        public Task<MsalSignIn> AcquireInteractiveAsync(string scope, string? loginHint, CancellationToken ct, bool forceConsent = false)
        {
            Interactive.Add((scope, loginHint, forceConsent));
            if (InteractiveFails is { } failure && scope != Audience.Graph.ScopeFor())
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

        public Task<MsalToken> AcquireSilentAsync(string homeAccountId, string scope, CancellationToken ct, bool forceRefresh = false)
        {
            Silent.Add((scope, forceRefresh));
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

            if (!arm && forceRefresh)
            {
                IEnumerable<string> granted = GrantHiddenForRefreshes-- > 0 ? [] : GrantedGraph;
                return Task.FromResult(new MsalToken(JwtWithScopes(["User.Read", .. granted]), DateTimeOffset.UtcNow.AddHours(1)));
            }

            return Task.FromResult(new MsalToken(TokenPrefix + (arm ? "arm-token" : "graph-token"), DateTimeOffset.UtcNow.AddHours(1)));
        }

        public Task<IReadOnlyList<MsalAccount>> GetAccountsAsync() =>
            Task.FromResult<IReadOnlyList<MsalAccount>>(ForgetAccount ? [] : [.. _cached.Values]);

        public Task RemoveAsync(string homeAccountId)
        {
            Removed.Add(homeAccountId);
            _cached.Remove(homeAccountId);
            RemovedEverywhere?.Invoke(homeAccountId);
            return Task.CompletedTask;
        }

        /// <summary>Drops <paramref name="homeAccountId"/> from this fake's cache without recording a removal.</summary>
        public void Forget(string homeAccountId) => _cached.Remove(homeAccountId);

        private static string JwtWithScopes(IEnumerable<string> scopes)
        {
            var payload = Convert.ToBase64String(JsonSerializer.SerializeToUtf8Bytes(new { scp = string.Join(' ', scopes) }))
                .TrimEnd('=').Replace('+', '-').Replace('/', '_');
            return $"h.{payload}.s";
        }

        private MsalSignIn Grant(string scope)
        {
            var consent = scope != Audience.Graph.ScopeFor();
            var account = consent && GrantAs is { } other ? other : SignsInAs;
            _cached[account.HomeAccountId] = account;
            if (scope == Audience.Arm.ScopeFor() && account == SignsInAs)
            {
                ArmNeedsUi = false;
            }

            if (consent && scope != Audience.Arm.ScopeFor() && account == SignsInAs)
            {
                GrantedGraph.Add(scope["https://graph.microsoft.com/".Length..]);
            }

            return new MsalSignIn(account, new MsalToken("not-a-jwt", DateTimeOffset.UtcNow.AddHours(1)));
        }
    }
}
