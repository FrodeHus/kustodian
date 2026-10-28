using System.Text.Json.Serialization;
using Kustodian.Auth;
using Kustodian.Graph.Fetch;
using Kustodian.Graph.Run;
using Kustodian.Graph.Schema;
using Kustodian.Sources.Arg;
using Kustodian.Sources.Hunting;
using Microsoft.Identity.Client;

namespace Kustodian.Messaging.Handlers;

/// <summary><c>account.list</c>, <c>account.signIn</c>, <c>account.use</c>, <c>account.signOut</c> and <c>account.consent</c>.
/// A device-code sign-in sends the code to the UI as an <c>account.deviceCode</c> event. Signing out also drops the account's
/// cached Graph objects, what probing found for it, its advanced hunting schema, its Azure lists (subscriptions, resource
/// types) and its tenant's licenses; signing in drops the licenses too, so they are read again. <c>account.consent {key, audience: "arm"}</c> asks the user to grant
/// Azure access to that account (<see cref="AccountService.ConsentAsync"/>; a device code, when no browser opens, goes out as the
/// same event) and answers <c>{}</c>; the user cancelling answers <c>cancelled</c>. <c>account.consent {key, audience: "graph",
/// scope}</c> does the same for one read-only Graph permission (not for an Azure CLI account, whose permissions are fixed) and,
/// once granted, drops the account's cached Graph objects, probe findings, licenses and advanced hunting schema, which the new
/// permission may change.</summary>
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
            var audience = request.Audience switch
            {
                "arm" => Audience.Arm,
                "graph" => Audience.Graph,
                _ => throw new BridgeException(
                    BridgeErrorCodes.BadRequest, "Consent is only asked for Azure or Graph (audience arm or graph)."),
            };
            var scope = audience == Audience.Graph ? await RequireGraphConsentAsync(key, request.Scope) : null;

            try
            {
                // Once a Graph permission is granted, what the account could read before is no longer the whole story, even
                // when the token refresh that follows fails or is cancelled.
                await accounts.ConsentAsync(key, audience, ct,
                    message => bridge.Emit("account.deviceCode", new DeviceCodeData(message)), scope,
                    () => DropGraphFindingsAsync(key));
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

    /// <summary>Drops what the account's Graph permissions decided: its cached Graph objects, probe findings, licenses and
    /// advanced hunting schema. Not cancelled with the request: it runs after a grant that already happened.</summary>
    private async Task DropGraphFindingsAsync(string key)
    {
        await objects.RemoveAccountAsync(key, CancellationToken.None);
        await probes.RemoveAccountAsync(key, CancellationToken.None);
        licenses?.RemoveAccount(key);
        huntingSchema?.RemoveAccount(key);
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

    /// <summary>Graph consent asks for one read-only permission, named plainly (letters, digits, dots and hyphens, starting with
    /// a letter or digit, as in <c>Reports.Read.All</c> or <c>NetworkAccess-Reports.Read.All</c>), on an account whose client
    /// can be granted permissions: never Azure CLI's. Returns the permission, trimmed.</summary>
    private async Task<string> RequireGraphConsentAsync(string key, string? scope)
    {
        var permission = scope?.Trim();
        if (string.IsNullOrEmpty(permission) || !char.IsAsciiLetterOrDigit(permission[0])
            || !permission.All(c => char.IsAsciiLetterOrDigit(c) || c is '.' or '-')
            || !GraphPermissions.IsReadOnly(permission))
        {
            throw new BridgeException(
                BridgeErrorCodes.BadRequest, "Graph consent needs one read-only permission, such as Reports.Read.All.");
        }

        var account = (await accounts.ListAccountsAsync()).FirstOrDefault(a => a.Key == key);
        if (account?.ClientKind == ClientKind.AzureCli)
        {
            throw new BridgeException(
                BridgeErrorCodes.BadRequest, "The Azure CLI client's Graph permissions are fixed; there is nothing to grant.");
        }

        return permission;
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

    private sealed record ConsentParams(string? Key, string? Audience, string? Scope);
}
