using System.Text.Json.Serialization;
using Kustodian.Auth;
using Kustodian.Graph.Fetch;
using Kustodian.Graph.Run;

namespace Kustodian.Messaging.Handlers;

/// <summary><c>account.list</c>, <c>account.signIn</c>, <c>account.use</c>, <c>account.signOut</c> and <c>account.consent</c>.
/// A device-code sign-in sends the code to the UI as an <c>account.deviceCode</c> event. Signing out also drops the account's
/// cached Graph objects. <c>account.consent {key, audience: "arm"}</c> asks the user to grant Azure access to that account
/// (<see cref="AccountService.ConsentAsync"/>; a device code, when no browser opens, goes out as the same event) and answers
/// <c>{}</c>.</summary>
public sealed class AccountHandler(AccountService accounts, TokenCacheStatus cache, IGraphObjectCache objects)
{
    public void Register(Bridge bridge)
    {
        bridge.Register("account.list", async (_, _) => await ListAsync());
        bridge.Register("account.signIn", async (p, ct) => await SignInAsync(bridge, BridgeJson.Params<SignInParams>(p), ct));
        bridge.Register("account.use", async (p, _) =>
        {
            var key = RequireKey(BridgeJson.Params<KeyParams>(p));
            try
            {
                await accounts.UseAsync(key);
            }
            catch (ArgumentException)
            {
                throw new BridgeException(BridgeErrorCodes.BadRequest, "Unknown account.");
            }

            return null;
        });
        bridge.Register("account.consent", async (p, ct) =>
        {
            var request = BridgeJson.Params<ConsentParams>(p);
            var key = RequireKey(new KeyParams(request.Key));
            if (request.Audience != "arm")
            {
                throw new BridgeException(BridgeErrorCodes.BadRequest, "Consent is only asked for Azure (audience arm).");
            }

            try
            {
                await accounts.ConsentAsync(key, Audience.Arm, ct,
                    message => bridge.Emit("account.deviceCode", new DeviceCodeData(message)));
            }
            catch (SignInRequiredException ex)
            {
                throw new BridgeException(BridgeErrorCodes.SignInNeeded, ex.Message);
            }

            return null;
        });
        bridge.Register("account.signOut", async (p, ct) =>
        {
            var key = RequireKey(BridgeJson.Params<KeyParams>(p));
            await accounts.SignOutAsync(key);
            await objects.RemoveAccountAsync(key, ct);
            return null;
        });
    }

    private async Task<AccountList> ListAsync()
    {
        var list = await accounts.ListAccountsAsync();
        return cache is MemoryOnly memory
            ? new AccountList(list, "memoryOnly", memory.Reason)
            : new AccountList(list, "persistent", null);
    }

    private Task<AccountInfo> SignInAsync(Bridge bridge, SignInParams p, CancellationToken ct)
    {
        var config = new ClientConfig(
            string.IsNullOrWhiteSpace(p.ClientId) ? ClientConfig.AzureCliClientId : p.ClientId.Trim(),
            string.IsNullOrWhiteSpace(p.Tenant) ? ClientConfig.AzureCli.Tenant : p.Tenant.Trim());
        return p.DeviceCode
            ? accounts.SignInDeviceCodeAsync(config, message => bridge.Emit("account.deviceCode", new DeviceCodeData(message)), ct)
            : accounts.SignInInteractiveAsync(config, ct);
    }

    private static string RequireKey(KeyParams p) =>
        string.IsNullOrEmpty(p.Key) ? throw new BridgeException(BridgeErrorCodes.BadRequest, "The request needs an account key.") : p.Key;

    private sealed record AccountList(
        IReadOnlyList<AccountInfo> Accounts,
        string Cache,
        [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? CacheReason);

    private sealed record DeviceCodeData(string Message);

    private sealed record SignInParams(string? ClientId, string? Tenant, bool DeviceCode);

    private sealed record KeyParams(string? Key);

    private sealed record ConsentParams(string? Key, string? Audience);
}
