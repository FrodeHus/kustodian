using System.Text.Json;
using Kustodian.Graph.Run;
using Kustodian.Graph.Schema;
using Kustodian.Storage;
using Microsoft.Identity.Client;

namespace Kustodian.Auth;

public interface ITokenSource
{
    /// <summary>A token for the account <paramref name="accountKey"/>, whether or not it is the active one.</summary>
    /// <exception cref="SignInRequiredException">That account is not signed in (or was signed out), or has to sign in again.</exception>
    /// <exception cref="ConsentRequiredException">An ARM token needs the user (consent or a policy); the sign-in itself is
    /// still good.</exception>
    Task<string> GetTokenAsync(string accountKey, Audience audience, CancellationToken ct);
}

/// <summary>What the UI shows about a signed-in account. Holds no tokens. <see cref="Scopes"/> is the <c>scp</c> claim of the last
/// Graph token.</summary>
public sealed record AccountInfo(
    string Key, string Username, string TenantName, string TenantId, string ClientId, bool Active, bool Expired,
    IReadOnlyList<string> Scopes)
{
    /// <summary>Which sign-in client this account uses, derived from <see cref="ClientId"/>.</summary>
    public ClientKind ClientKind => ClientConfig.KindOf(ClientId);
}

/// <summary>The accounts known to this install, backed by one MSAL public client per <see cref="ClientConfig"/>. Account metadata
/// goes to <c>accounts.json</c>; tokens stay in MSAL's cache, which lives in the OS keychain or in memory.</summary>
public sealed class AccountService(Func<ClientConfig, IMsalClient> clientFactory, JsonFileStore store, TimeProvider? time = null)
    : ITokenSource
{
    /// <summary>The waits between refreshes after a Graph grant, until a token carries it: Entra ID can take a few seconds to
    /// issue tokens with a permission just granted.</summary>
    private static readonly TimeSpan[] GrantRetryDelays = [TimeSpan.FromSeconds(1), TimeSpan.FromSeconds(2), TimeSpan.FromSeconds(4)];

    /// <summary>How often a Graph token is refreshed, at most, while a granted permission is still missing from it.</summary>
    private static readonly TimeSpan AwaitedGrantRefresh = TimeSpan.FromSeconds(15);

    private const string FileName = "accounts.json";

    /// <summary>Put before a Graph permission name to ask for that one permission.</summary>
    private const string GraphScopeBase = "https://graph.microsoft.com/";

    private readonly SemaphoreSlim _gate = new(1, 1);
    private readonly Dictionary<ClientConfig, IMsalClient> _clients = [];
    private readonly HashSet<string> _expired = [];

    /// <summary>Per account key: a Graph permission granted that its tokens don't carry yet, and when one was last refreshed for
    /// it. Not persisted: after a restart the cached token has usually expired anyway.</summary>
    private readonly Dictionary<string, (string Scope, DateTimeOffset Refreshed)> _awaitedGrants = [];

    private readonly TimeProvider _time = time ?? TimeProvider.System;
    private volatile string? _activeKey;
    private State? _state;

    public string? ActiveAccountKey => _activeKey;

    public async Task<AccountInfo> SignInInteractiveAsync(ClientConfig config, CancellationToken ct) =>
        await SignInAsync(config, ct, (client, scope) => client.AcquireInteractiveAsync(scope, null, ct));

    public async Task<AccountInfo> SignInDeviceCodeAsync(ClientConfig config, Action<string> showCode, CancellationToken ct) =>
        await SignInAsync(config, ct, (client, scope) => client.AcquireDeviceCodeAsync(scope, showCode, ct));

    public async Task<IReadOnlyList<AccountInfo>> ListAccountsAsync()
    {
        await _gate.WaitAsync();
        try
        {
            var state = await LoadAsync(CancellationToken.None);
            var cached = new Dictionary<ClientConfig, HashSet<string>>();
            var result = new List<AccountInfo>();
            foreach (var stored in state.Accounts)
            {
                var config = new ClientConfig(stored.Info.ClientId, stored.Tenant);
                if (!cached.TryGetValue(config, out var homeIds))
                {
                    homeIds = (await ClientFor(config).GetAccountsAsync()).Select(a => a.HomeAccountId).ToHashSet();
                    cached[config] = homeIds;
                }

                var expired = !homeIds.Contains(stored.HomeAccountId) || _expired.Contains(stored.Info.Key);
                result.Add(stored.Info with { Active = stored.Info.Key == state.ActiveKey, Expired = expired });
            }

            return result;
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task UseAsync(string accountKey)
    {
        await _gate.WaitAsync();
        try
        {
            var state = await LoadAsync(CancellationToken.None);
            if (state.Accounts.All(a => a.Info.Key != accountKey))
            {
                throw new ArgumentException("Unknown account.", nameof(accountKey));
            }

            state.ActiveKey = accountKey;
            _activeKey = accountKey;
            await SaveAsync(state, CancellationToken.None);
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task SignOutAsync(string accountKey)
    {
        await _gate.WaitAsync();
        try
        {
            var state = await LoadAsync(CancellationToken.None);
            var stored = state.Accounts.FirstOrDefault(a => a.Info.Key == accountKey);
            if (stored is null)
            {
                return;
            }

            state.Accounts.Remove(stored);

            // All clients share one MSAL token cache, and removing an account from it drops every token for that home account,
            // whatever the client (FOCI) or tenant. So the user stays in the cache while another listed account is theirs.
            if (state.Accounts.All(a => a.HomeAccountId != stored.HomeAccountId))
            {
                var configs = new HashSet<ClientConfig> { ConfigFor(stored, Audience.Graph), ConfigFor(stored, Audience.Arm) };
                foreach (var config in configs)
                {
                    await ClientFor(config).RemoveAsync(stored.HomeAccountId);
                }
            }

            _expired.Remove(accountKey);
            _awaitedGrants.Remove(accountKey);
            if (state.ActiveKey == accountKey)
            {
                state.ActiveKey = state.Accounts.FirstOrDefault()?.Info.Key;
            }

            _activeKey = state.ActiveKey;
            await SaveAsync(state, CancellationToken.None);
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task<string> GetTokenAsync(string accountKey, Audience audience, CancellationToken ct)
    {
        await _gate.WaitAsync(ct);
        try
        {
            var state = await LoadAsync(ct);
            var stored = state.Accounts.FirstOrDefault(a => a.Info.Key == accountKey)
                ?? throw new SignInRequiredException("That account is not signed in.");

            // While a granted permission is missing from the account's Graph token, the cached one is skipped now and then, so
            // the permission arrives without a new sign-in.
            var now = _time.GetUtcNow();
            var refresh = audience == Audience.Graph && _awaitedGrants.TryGetValue(stored.Info.Key, out var awaited)
                && now - awaited.Refreshed >= AwaitedGrantRefresh;
            MsalToken token;
            try
            {
                token = await ClientFor(ConfigFor(stored, audience)).AcquireSilentAsync(stored.HomeAccountId, audience.ScopeFor(), ct,
                    forceRefresh: refresh);
                if (refresh)
                {
                    NoteAwaitedGrant(stored.Info.Key, token, now);
                }
            }
            catch (MsalUiRequiredException ex)
                when (audience == Audience.Arm && (IsConsent(ex) || stored.Info.ClientKind == ClientKind.GraphCli))
            {
                // The Graph sign-in is untouched: ARM needs consent or a Conditional Access step-up, granted with ConsentAsync.
                // Behind a Graph CLT account, any ARM ui-required (no Azure CLI sign-in yet included) is cleared the same way.
                throw new ConsentRequiredException("arm", ex);
            }
            catch (MsalUiRequiredException ex) when (audience == Audience.Arm)
            {
                // Ruling 7: the account is gone from MSAL's cache (ListAccountsAsync already shows it expired), or its refresh
                // token expired or was revoked: a sign-in to renew. The Graph sign-in's state is left as it is; only a Graph
                // token says anything about Graph.
                throw new SignInRequiredException("The sign-in has expired. Sign in again.", ex);
            }
            catch (MsalUiRequiredException ex)
            {
                _expired.Add(stored.Info.Key);
                throw new SignInRequiredException("The sign-in has expired. Sign in again.", ex);
            }

            if (audience == Audience.Graph)
            {
                // Only a Graph token says the sign-in works again; an ARM token says nothing about Graph.
                _expired.Remove(stored.Info.Key);
                await StoreScopesAsync(state, stored, token, ct);
            }

            return token.AccessToken;
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>Asks the user, in the system browser, for a token for <paramref name="audience"/> on the account
    /// <paramref name="accountKey"/>: the browser starts at that account (its username is the login hint), so the user consents
    /// or completes what the policy asks. When no browser can be opened and <paramref name="showCode"/> is given, a device-code
    /// flow is used instead and its message goes to <paramref name="showCode"/>. The account list, the active account and the
    /// Graph sign-in are left as they are; the token lands in MSAL's cache, where <see cref="GetTokenAsync"/> finds it.
    /// For <see cref="Audience.Graph"/>, <paramref name="scope"/> names the one permission to grant (such as
    /// <c>Reports.Read.All</c>): the account's own client asks for it with <c>prompt=consent</c>, then refreshes the account's
    /// Graph token so it, and the stored <see cref="AccountInfo.Scopes"/>, carry the new permission at once. Once the permission
    /// is granted, <paramref name="onGranted"/> runs after that refresh, whether or not the refresh succeeded.</summary>
    /// <exception cref="SignInRequiredException">That account is not signed in.</exception>
    /// <exception cref="ArgumentException">Graph consent without a <paramref name="scope"/>, or for one that is not
    /// read-only.</exception>
    /// <exception cref="InvalidOperationException">Graph consent for an Azure CLI account (its permissions are fixed), or the
    /// user granted access as another account (removed again from MSAL's cache unless it was already there or is a listed
    /// account's; the message names both).</exception>
    public async Task ConsentAsync(string accountKey, Audience audience, CancellationToken ct, Action<string>? showCode = null,
        string? scope = null, Func<Task>? onGranted = null)
    {
        if (audience == Audience.Graph && (string.IsNullOrWhiteSpace(scope) || !GraphPermissions.IsReadOnly(scope)))
        {
            throw new ArgumentException("Graph consent needs one read-only permission to ask for.", nameof(scope));
        }

        IMsalClient client;
        StoredAccount stored;
        HashSet<string> listed;
        await _gate.WaitAsync(ct);
        try
        {
            var state = await LoadAsync(ct);
            stored = state.Accounts.FirstOrDefault(a => a.Info.Key == accountKey)
                ?? throw new SignInRequiredException("That account is not signed in.");
            if (audience == Audience.Graph && stored.Info.ClientKind == ClientKind.AzureCli)
            {
                throw new InvalidOperationException("The Azure CLI client's Graph permissions are fixed; there is nothing to grant.");
            }

            client = ClientFor(ConfigFor(stored, audience));
            listed = state.Accounts.Select(a => a.HomeAccountId).ToHashSet(StringComparer.Ordinal);
        }
        finally
        {
            _gate.Release();
        }

        // The token cache is shared by every client, so a home account listed under any client counts as known here too.
        var known = (await client.GetAccountsAsync()).Select(a => a.HomeAccountId).ToHashSet(StringComparer.Ordinal);
        known.UnionWith(listed);

        // As with sign-in, the browser or device-code wait happens outside the gate.
        var graph = audience == Audience.Graph;
        var requested = graph ? GraphScopeBase + scope!.Trim() : audience.ScopeFor();
        MsalSignIn granted;
        try
        {
            granted = await client.AcquireInteractiveAsync(requested, stored.Info.Username, ct, forceConsent: graph);
        }
        catch (Exception ex) when (showCode is not null && NoBrowser(ex))
        {
            granted = await client.AcquireDeviceCodeAsync(requested, showCode, ct);
        }

        if (!string.Equals(granted.Account.HomeAccountId, stored.HomeAccountId, StringComparison.Ordinal))
        {
            // The user picked another account in the browser. Its token is of no use to this account: drop it from MSAL's
            // cache unless that account was there before or is listed (then it is someone's sign-in and stays).
            if (!known.Contains(granted.Account.HomeAccountId))
            {
                await client.RemoveAsync(granted.Account.HomeAccountId);
            }

            throw new InvalidOperationException(
                $"You granted access as {granted.Account.Username}; sign in as {stored.Info.Username}.");
        }

        if (graph)
        {
            try
            {
                await RefreshGraphAsync(accountKey, client, scope!.Trim(), ct);
            }
            finally
            {
                if (onGranted is not null)
                {
                    await onGranted();
                }
            }
        }
    }

    /// <summary>After Graph consent: the cached <c>.default</c> token keeps its old <c>scp</c> until it expires, so a new one is
    /// fetched now and its scopes stored for the account (unless it was signed out meanwhile). Entra ID may issue a token
    /// without <paramref name="granted"/> for a few seconds after the grant, so it is fetched again, a few times, until the
    /// permission is in it; if it still isn't, <see cref="GetTokenAsync"/> keeps refreshing now and then until it is.</summary>
    private async Task RefreshGraphAsync(string accountKey, IMsalClient client, string granted, CancellationToken ct)
    {
        for (var attempt = 0; ; attempt++)
        {
            // The waits are outside the gate: other runs' tokens don't wait for this one.
            if (attempt > 0)
            {
                await Task.Delay(GrantRetryDelays[attempt - 1], _time, ct);
            }

            await _gate.WaitAsync(ct);
            try
            {
                var state = await LoadAsync(ct);
                var stored = state.Accounts.FirstOrDefault(a => a.Info.Key == accountKey);
                if (stored is null)
                {
                    return;
                }

                if (attempt == 0)
                {
                    _awaitedGrants[accountKey] = (granted, _time.GetUtcNow());
                }

                var token = await client.AcquireSilentAsync(stored.HomeAccountId, Audience.Graph.ScopeFor(), ct, forceRefresh: true);
                _expired.Remove(accountKey);
                await StoreScopesAsync(state, stored, token, ct);
                if (!NoteAwaitedGrant(accountKey, token, _time.GetUtcNow()) || attempt == GrantRetryDelays.Length)
                {
                    return;
                }
            }
            finally
            {
                _gate.Release();
            }
        }
    }

    /// <summary>After a refreshed Graph <paramref name="token"/> for <paramref name="accountKey"/>: forgets the awaited grant
    /// once the token carries it (or its scopes can't be read), else notes the refresh. Whether it is still awaited. Call under
    /// the gate.</summary>
    private bool NoteAwaitedGrant(string accountKey, MsalToken token, DateTimeOffset refreshed)
    {
        if (!_awaitedGrants.TryGetValue(accountKey, out var awaited))
        {
            return false;
        }

        var scopes = ScopesOf(token.AccessToken);
        if (scopes.Count == 0 || scopes.Contains(awaited.Scope, StringComparer.OrdinalIgnoreCase))
        {
            _awaitedGrants.Remove(accountKey);
            return false;
        }

        _awaitedGrants[accountKey] = awaited with { Refreshed = refreshed };
        return true;
    }

    /// <summary>Keeps the <c>scp</c> of a Graph <paramref name="token"/> as the account's <see cref="AccountInfo.Scopes"/> when
    /// it is readable and differs. Call under the gate.</summary>
    private async Task StoreScopesAsync(State state, StoredAccount stored, MsalToken token, CancellationToken ct)
    {
        var scopes = ScopesOf(token.AccessToken);
        if (scopes.Count > 0 && !scopes.SequenceEqual(stored.Info.Scopes))
        {
            state.Accounts[state.Accounts.IndexOf(stored)] = stored with { Info = stored.Info with { Scopes = scopes } };
            await SaveAsync(state, ct);
        }
    }

    /// <summary>The client that gets <paramref name="audience"/> tokens for <paramref name="stored"/>: the account's own, except ARM
    /// behind a Graph CLT account, which comes from the Azure CLI client in the account's tenant (the same home account).</summary>
    private static ClientConfig ConfigFor(StoredAccount stored, Audience audience) =>
        audience == Audience.Arm && stored.Info.ClientKind == ClientKind.GraphCli
            ? new ClientConfig(ClientConfig.AzureCliClientId, stored.Tenant)
            : new ClientConfig(stored.Info.ClientId, stored.Tenant);

    /// <summary>Whether an ARM ui-required failure is cleared by an interactive acquire for the ARM scope ("Grant Azure access",
    /// <see cref="ConsentAsync"/>), ruling 7 as amended: MSAL classifies it as consent or as a Conditional Access step-up
    /// (<c>BasicAction</c>, <c>AdditionalAction</c>; a Graph sign-in wouldn't reach the ARM scope's policy), or the error says
    /// consent (<c>consent_required</c>, or <c>AADSTS65001</c>: the user or administrator has not consented).</summary>
    private static bool IsConsent(MsalUiRequiredException ex) =>
        ex.Classification is UiRequiredExceptionClassification.ConsentRequired or UiRequiredExceptionClassification.BasicAction
            or UiRequiredExceptionClassification.AdditionalAction
        || string.Equals(ex.ErrorCode, "consent_required", StringComparison.OrdinalIgnoreCase)
        || ex.Message.Contains("AADSTS65001", StringComparison.Ordinal);

    /// <summary>Whether an interactive acquire failed because no browser could be opened here (as opposed to the user cancelling
    /// or the service refusing).</summary>
    private static bool NoBrowser(Exception ex) => ex switch
    {
        MsalClientException client => client.ErrorCode is MsalError.LinuxXdgOpen or MsalError.WebviewUnavailable,
        PlatformNotSupportedException => true,
        _ => false,
    };

    /// <summary>The <c>scp</c> claim of a JWT access token, or empty when the token is not a readable JWT.</summary>
    public static IReadOnlyList<string> ScopesOf(string accessToken)
    {
        var parts = accessToken.Split('.');
        if (parts.Length != 3)
        {
            return [];
        }

        try
        {
            var payload = parts[1].Replace('-', '+').Replace('_', '/');
            payload = payload.PadRight(payload.Length + ((4 - (payload.Length % 4)) % 4), '=');
            using var doc = JsonDocument.Parse(Convert.FromBase64String(payload));
            return doc.RootElement.ValueKind == JsonValueKind.Object
                   && doc.RootElement.TryGetProperty("scp", out var scp) && scp.ValueKind == JsonValueKind.String
                ? scp.GetString()!.Split(' ', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                : [];
        }
        catch (Exception ex) when (ex is FormatException or JsonException or InvalidOperationException)
        {
            return [];
        }
    }

    private async Task<AccountInfo> SignInAsync(
        ClientConfig config, CancellationToken ct, Func<IMsalClient, string, Task<MsalSignIn>> acquire)
    {
        IMsalClient client;
        await _gate.WaitAsync(ct);
        try
        {
            client = ClientFor(config);
        }
        finally
        {
            _gate.Release();
        }

        // The browser or device-code wait can take minutes: do it outside the gate so other calls are not stalled.
        var signIn = await acquire(client, Audience.Graph.ScopeFor());

        await _gate.WaitAsync(ct);
        try
        {
            var state = await LoadAsync(ct);
            var account = signIn.Account;
            var key = $"{config.ClientId}:{account.HomeAccountId}";
            var info = new AccountInfo(key, account.Username, TenantNameOf(account.Username), account.TenantId, config.ClientId,
                Active: true, Expired: false, ScopesOf(signIn.Token.AccessToken));

            state.Accounts.RemoveAll(a => a.Info.Key == key);
            state.Accounts.Add(new StoredAccount(info, account.HomeAccountId, config.Tenant));
            state.ActiveKey = key;
            _activeKey = key;
            _expired.Remove(key);
            await SaveAsync(state, ct);
            return info;
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>MSAL does not return the tenant's display name; the UPN domain is the closest name we have.</summary>
    private static string TenantNameOf(string username)
    {
        var at = username.LastIndexOf('@');
        return at >= 0 && at < username.Length - 1 ? username[(at + 1)..] : username;
    }

    private IMsalClient ClientFor(ClientConfig config)
    {
        if (!_clients.TryGetValue(config, out var client))
        {
            client = clientFactory(config);
            _clients[config] = client;
        }

        return client;
    }

    private async Task<State> LoadAsync(CancellationToken ct)
    {
        if (_state is null)
        {
            var read = await store.ReadAsync(FileName, new FileModel(null, []), ct);
            var model = read.Value;
            if (model.Accounts is null || model.Accounts.Any(a => a is null || a.Info is null))
            {
                store.MoveAside(FileName);
                model = new FileModel(null, []);
            }

            _state = new State { ActiveKey = model.ActiveKey, Accounts = [.. model.Accounts] };
            _activeKey = _state.ActiveKey;
        }

        return _state;
    }

    private Task SaveAsync(State state, CancellationToken ct) =>
        store.WriteAsync(FileName, new FileModel(state.ActiveKey, [.. state.Accounts]), ct);

    private sealed class State
    {
        public string? ActiveKey { get; set; }

        public required List<StoredAccount> Accounts { get; init; }
    }

    /// <summary>What <c>accounts.json</c> holds per account: display metadata plus what is needed to find the MSAL account again.
    /// Never a token.</summary>
    public sealed record StoredAccount(AccountInfo Info, string HomeAccountId, string Tenant);

    private sealed record FileModel(string? ActiveKey, List<StoredAccount> Accounts);
}
