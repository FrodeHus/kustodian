using System.Text.Json;
using Kustodian.Graph.Run;
using Kustodian.Storage;
using Microsoft.Identity.Client;

namespace Kustodian.Auth;

public interface ITokenSource
{
    /// <summary>Key of the account tokens are fetched for, or null when nobody is signed in.</summary>
    string? ActiveAccountKey { get; }

    /// <exception cref="SignInRequiredException">There is no active account, or it has to sign in again.</exception>
    Task<string> GetTokenAsync(Audience audience, CancellationToken ct);
}

/// <summary>What the UI shows about a signed-in account. Holds no tokens. <see cref="Scopes"/> is the <c>scp</c> claim of the last
/// Graph token.</summary>
public sealed record AccountInfo(
    string Key, string Username, string TenantName, string TenantId, string ClientId, bool Active, bool Expired,
    IReadOnlyList<string> Scopes);

/// <summary>The accounts known to this install, backed by one MSAL public client per <see cref="ClientConfig"/>. Account metadata
/// goes to <c>accounts.json</c>; tokens stay in MSAL's cache, which lives in the OS keychain or in memory.</summary>
public sealed class AccountService(Func<ClientConfig, IMsalClient> clientFactory, JsonFileStore store) : ITokenSource
{
    private const string FileName = "accounts.json";

    private readonly SemaphoreSlim _gate = new(1, 1);
    private readonly Dictionary<ClientConfig, IMsalClient> _clients = [];
    private readonly HashSet<string> _expired = [];
    private volatile string? _activeKey;
    private State? _state;

    public string? ActiveAccountKey => _activeKey;

    public async Task<AccountInfo> SignInInteractiveAsync(ClientConfig config, CancellationToken ct) =>
        await SignInAsync(config, ct, (client, scope) => client.AcquireInteractiveAsync(scope, ct));

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

            await ClientFor(new ClientConfig(stored.Info.ClientId, stored.Tenant)).RemoveAsync(stored.HomeAccountId);
            state.Accounts.Remove(stored);
            _expired.Remove(accountKey);
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

    public async Task<string> GetTokenAsync(Audience audience, CancellationToken ct)
    {
        await _gate.WaitAsync(ct);
        try
        {
            var state = await LoadAsync(ct);
            var stored = state.Accounts.FirstOrDefault(a => a.Info.Key == state.ActiveKey)
                ?? throw new SignInRequiredException("No account is signed in.");

            MsalToken token;
            try
            {
                token = await ClientFor(new ClientConfig(stored.Info.ClientId, stored.Tenant))
                    .AcquireSilentAsync(stored.HomeAccountId, audience.ScopeFor(), ct);
            }
            catch (MsalUiRequiredException ex)
            {
                _expired.Add(stored.Info.Key);
                throw new SignInRequiredException("The sign-in has expired. Sign in again.", ex);
            }

            _expired.Remove(stored.Info.Key);
            if (audience == Audience.Graph)
            {
                var scopes = ScopesOf(token.AccessToken);
                if (scopes.Count > 0 && !scopes.SequenceEqual(stored.Info.Scopes))
                {
                    state.Accounts[state.Accounts.IndexOf(stored)] = stored with { Info = stored.Info with { Scopes = scopes } };
                    await SaveAsync(state, ct);
                }
            }

            return token.AccessToken;
        }
        finally
        {
            _gate.Release();
        }
    }

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
