using Microsoft.Identity.Client;

namespace Kustodian.Auth;

public sealed record MsalAccount(string HomeAccountId, string Username, string TenantId);

public sealed record MsalToken(string AccessToken, DateTimeOffset ExpiresOn);

public sealed record MsalSignIn(MsalAccount Account, MsalToken Token);

/// <summary>The small slice of MSAL that <see cref="AccountService"/> uses, so tests can fake it. One instance per
/// <see cref="ClientConfig"/>. <see cref="AcquireSilentAsync"/> throws <see cref="MsalUiRequiredException"/> when the account
/// needs to sign in again.</summary>
public interface IMsalClient
{
    /// <summary>Signs in through the system browser for <paramref name="scope"/>. With a <paramref name="loginHint"/> (a
    /// username) the browser starts at that account; without one the user picks.</summary>
    Task<MsalSignIn> AcquireInteractiveAsync(string scope, string? loginHint, CancellationToken ct);

    Task<MsalSignIn> AcquireDeviceCodeAsync(string scope, Action<string> showCode, CancellationToken ct);

    Task<MsalToken> AcquireSilentAsync(string homeAccountId, string scope, CancellationToken ct);

    Task<IReadOnlyList<MsalAccount>> GetAccountsAsync();

    Task RemoveAsync(string homeAccountId);
}

/// <summary>The real MSAL public client. Interactive sign-in uses the system browser with redirect <c>http://localhost</c>.
/// Checked by hand against a real tenant, not in unit tests.</summary>
public sealed class MsalClient : IMsalClient
{
    private readonly IPublicClientApplication _app;

    public MsalClient(ClientConfig config, TokenCacheStatus cache)
    {
        _app = PublicClientApplicationBuilder.Create(config.ClientId)
            .WithAuthority(AzureCloudInstance.AzurePublic, config.Tenant)
            .WithRedirectUri("http://localhost")
            .Build();

        if (cache is Persistent persistent)
        {
            persistent.Cache.Register(_app.UserTokenCache);
        }
    }

    public async Task<MsalSignIn> AcquireInteractiveAsync(string scope, string? loginHint, CancellationToken ct)
    {
        var builder = _app.AcquireTokenInteractive([scope]).WithUseEmbeddedWebView(false);
        builder = loginHint is null ? builder.WithPrompt(Prompt.SelectAccount) : builder.WithLoginHint(loginHint);
        var result = await builder.ExecuteAsync(ct);
        return Map(result);
    }

    public async Task<MsalSignIn> AcquireDeviceCodeAsync(string scope, Action<string> showCode, CancellationToken ct)
    {
        var result = await _app.AcquireTokenWithDeviceCode([scope], callback =>
        {
            showCode(callback.Message);
            return Task.CompletedTask;
        }).ExecuteAsync(ct);
        return Map(result);
    }

    public async Task<MsalToken> AcquireSilentAsync(string homeAccountId, string scope, CancellationToken ct)
    {
        var account = (await _app.GetAccountsAsync()).FirstOrDefault(a => a.HomeAccountId.Identifier == homeAccountId)
            ?? throw new MsalUiRequiredException(MsalError.UserNullError, "The account is no longer in the token cache.");
        var result = await _app.AcquireTokenSilent([scope], account).ExecuteAsync(ct);
        return new MsalToken(result.AccessToken, result.ExpiresOn);
    }

    public async Task<IReadOnlyList<MsalAccount>> GetAccountsAsync() =>
        [.. (await _app.GetAccountsAsync()).Select(a => new MsalAccount(a.HomeAccountId.Identifier, a.Username, a.HomeAccountId.TenantId))];

    public async Task RemoveAsync(string homeAccountId)
    {
        var account = (await _app.GetAccountsAsync()).FirstOrDefault(a => a.HomeAccountId.Identifier == homeAccountId);
        if (account is not null)
        {
            await _app.RemoveAsync(account);
        }
    }

    private static MsalSignIn Map(AuthenticationResult result) =>
        new(new MsalAccount(result.Account.HomeAccountId.Identifier, result.Account.Username, result.TenantId),
            new MsalToken(result.AccessToken, result.ExpiresOn));
}
