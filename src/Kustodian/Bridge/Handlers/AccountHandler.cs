using System.Text.Json.Serialization;
using Kustodian.Auth;
using Kustodian.Graph.Fetch;
using Kustodian.Graph.Run;
using Kustodian.Sources.Arg;
using Kustodian.Sources.Hunting;
using Microsoft.Identity.Client;

namespace Kustodian.Messaging.Handlers;

/// <summary><c>account.list</c>, <c>account.signIn</c>, <c>account.use</c>, <c>account.signOut</c> and <c>account.consent</c>.
/// A device-code sign-in sends the code to the UI as an <c>account.deviceCode</c> event. Signing out also drops the account's
/// cached Graph objects, what probing found for it, its advanced hunting schema, its Azure lists (subscriptions, resource
/// types) and its tenant's licenses; signing in drops the licenses too, so they are read again. <c>account.consent {key, audience: "arm"}</c> asks the user to grant
/// Azure access to that account (<see cref="AccountService.ConsentAsync"/>; a device code, when no browser opens, goes out as the
/// same event) and answers <c>{}</c>; the user cancelling answers <c>cancelled</c>.</summary>
public sealed class AccountHandler(AccountService accounts, TokenCacheStatus cache, IGraphObjectCache objects, IGraphProbeCache probes,
    HuntingSchemaSource? huntingSchema = null, ArmDirectory? armDirectory = null, ITenantLicenses? licenses = null)
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
            catch (MsalClientException ex) when (ex.ErrorCode == MsalError.AuthenticationCanceledError)
            {
                // The user closed the browser or said no: the same answer as any other cancelled request.
                throw new OperationCanceledException(ex.Message, ex);
            }

            return null;
        });
        bridge.Register("account.signOut", async (p, ct) =>
        {
            var key = RequireKey(BridgeJson.Params<KeyParams>(p));
            await accounts.SignOutAsync(key);
            await objects.RemoveAccountAsync(key, ct);
            await probes.RemoveAccountAsync(key, ct);
            huntingSchema?.RemoveAccount(key);
            armDirectory?.RemoveAccount(key);
            licenses?.RemoveAccount(key);
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

    private async Task<AccountInfo> SignInAsync(Bridge bridge, SignInParams p, CancellationToken ct)
    {
        var config = new ClientConfig(
            string.IsNullOrWhiteSpace(p.ClientId) ? ClientConfig.AzureCliClientId : p.ClientId.Trim(),
            string.IsNullOrWhiteSpace(p.Tenant) ? ClientConfig.AzureCli.Tenant : p.Tenant.Trim());
        var account = p.DeviceCode
            ? await accounts.SignInDeviceCodeAsync(config, message => bridge.Emit("account.deviceCode", new DeviceCodeData(message)), ct)
            : await accounts.SignInInteractiveAsync(config, ct);
        // A new sign-in may carry new permissions, and the tenant new licenses.
        licenses?.RemoveAccount(account.Key);
        return account;
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
