using System.Security.Cryptography;
using System.Text.Json;
using Kustodian.Auth;
using Kustodian.Auth.EntraApp;
using Kustodian.Graph.Run;
using Kustodian.Graph.Schema;

namespace Kustodian.Messaging.Handlers;

/// <summary>The <c>entraApp.*</c> commands: plan, create, retry the service principal, read and open admin consent, open the Entra
/// portal. Each reads the active account and the tenant itself; no tenant or URL comes from the UI, and an app ID is checked to be
/// a GUID before it goes into any address. Nobody signed in, or a sign-in that has to be renewed, is <c>signInNeeded</c>; an
/// <see cref="EntraAppException"/> is <c>failed</c> with its message.</summary>
public sealed class EntraAppHandler(
    EntraAppClient client, Func<Task<AccountInfo?>> activeAccount, ISystemBrowser browser, Func<string>? newState = null)
{
    public const string SignInMessage = "Sign in again to create an app registration.";
    public const string CannotCreateReason = "This sign-in can't create app registrations (it needs Application.ReadWrite.All).";

    private static readonly string[] CreateScopes = ["Application.ReadWrite.All", "Directory.AccessAsUser.All"];

    private static readonly Lazy<PermissionPlan> Plan = new(() =>
        PermissionPlanner.Plan(GraphPermissionCatalog.Bundled, GraphSchemaCatalog.Beta.Tables, GraphAreas.Bundled));

    private readonly Func<string> _newState = newState ?? (() => Convert.ToHexString(RandomNumberGenerator.GetBytes(16)));

    public void Register(Bridge bridge)
    {
        bridge.Register("entraApp.plan", async (_, ct) => await GuardAsync(() => PlanAsync(ct)));
        bridge.Register("entraApp.create", async (p, ct) => await GuardAsync(() => CreateAsync(bridge, p, ct)));
        bridge.Register("entraApp.retryServicePrincipal", async (p, ct) => await GuardAsync(() => RetryAsync(p, ct)));
        bridge.Register("entraApp.consentStatus", async (p, ct) => await GuardAsync(() => ConsentStatusAsync(p, ct)));
        bridge.Register("entraApp.canGrant", async (_, ct) => await GuardAsync(async () =>
        {
            var account = await activeAccount() ?? throw SignInNeeded();
            return new CanGrantAnswer(await client.CanGrantAsync(account.Key, ct));
        }));
        bridge.Register("entraApp.openConsent", async (p, ct) => await GuardAsync(async () =>
        {
            var appId = AppIdOf(p);
            var (_, tenant) = await RequireTenantAsync(ct);
            Open(EntraAppClient.ConsentUrl(tenant.Id, appId, _newState()));
            return new { };
        }));
        bridge.Register("entraApp.consentLink", async (p, ct) => await GuardAsync(async () =>
        {
            var appId = AppIdOf(p);
            var (_, tenant) = await RequireTenantAsync(ct);
            return new UrlAnswer(EntraAppClient.ConsentUrl(tenant.Id, appId, null).AbsoluteUri);
        }));
        bridge.Register("entraApp.openPortal", (p, _) => GuardAsync(() =>
        {
            var appId = AppIdOf(p);
            Open(new Uri($"https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationMenuBlade/~/Overview/appId/{appId}"));
            return Task.FromResult<object?>(new { });
        }));
    }

    private async Task<object?> PlanAsync(CancellationToken ct)
    {
        var account = await activeAccount() ?? throw SignInNeeded();
        var defaultName = $"Kustodian ({account.Username})";
        var plan = Plan.Value;
        if (CannotCreate(account))
        {
            return Answer(false, CannotCreateReason, defaultName, "", "", plan);
        }

        var tenant = await client.TenantAsync(account.Key, ct);
        return Answer(true, null, defaultName, tenant.Id, tenant.DisplayName, plan);
    }

    private static PlanAnswer Answer(bool can, string? reason, string name, string tenantId, string tenantName, PermissionPlan plan) =>
        new(can, reason, name, tenantId, tenantName, plan.Groups, plan.TablesWithData, plan.TablesWithoutData, plan.WriteOnlyTables);

    private async Task<object?> CreateAsync(Bridge bridge, JsonElement p, CancellationToken ct)
    {
        var args = BridgeJson.Params<CreateParams>(p);
        var name = args.Name?.Trim() ?? "";
        if (name.Length is < 1 or > 120)
        {
            throw new BridgeException(BridgeErrorCodes.BadRequest, "The app name must be 1 to 120 characters.");
        }

        var offered = Plan.Value.Groups.SelectMany(g => g.Subgroups).SelectMany(s => s.Permissions).ToList();
        var chosen = new List<PlannedPermission>();
        foreach (var wanted in args.Permissions ?? [])
        {
            var match = offered.FirstOrDefault(o =>
                string.Equals(o.Resource, wanted.Resource, StringComparison.OrdinalIgnoreCase)
                && string.Equals(o.Name, wanted.Name, StringComparison.OrdinalIgnoreCase));
            if (match is null)
            {
                throw new BridgeException(BridgeErrorCodes.BadRequest, $"{wanted.Name} is not a permission Kustodian offers.");
            }

            if (!chosen.Contains(match))
            {
                chosen.Add(match);
            }
        }

        var (account, tenant) = await RequireTenantAsync(ct);
        return await client.CreateAsync(account.Key, tenant, new CreateRequest(name, chosen),
            step => bridge.Emit("entraApp.step", new StepData(step)), ct);
    }

    private async Task<object?> RetryAsync(JsonElement p, CancellationToken ct)
    {
        var args = BridgeJson.Params<RetryParams>(p);
        var appId = RequireGuid(args.AppId);
        var objectId = RequireGuid(args.ObjectId);
        var (account, tenant) = await RequireTenantAsync(ct);
        var partial = new CreateResult(appId, objectId, null, tenant.Id, false, null, [], null, []);
        return await client.RetryServicePrincipalAsync(account.Key, partial, ct);
    }

    private async Task<object?> ConsentStatusAsync(JsonElement p, CancellationToken ct)
    {
        var args = BridgeJson.Params<ConsentParams>(p);
        var appId = RequireGuid(args.AppId);
        var known = Plan.Value.Groups.SelectMany(g => g.Subgroups).SelectMany(s => s.Permissions)
            .Select(x => x.Name).Distinct(StringComparer.OrdinalIgnoreCase).ToDictionary(n => n, StringComparer.OrdinalIgnoreCase);
        var scopes = (args.AdminScopes ?? []).Where(known.ContainsKey).Select(n => known[n]).Distinct(StringComparer.Ordinal).ToList();
        var account = await activeAccount() ?? throw SignInNeeded();
        return await client.ConsentStatusAsync(account.Key, appId, scopes, ct);
    }

    private static bool CannotCreate(AccountInfo account) =>
        !string.Equals(account.ClientId, ClientConfig.AzureCliClientId, StringComparison.OrdinalIgnoreCase)
        || account.Expired
        || !account.Scopes.Any(s => CreateScopes.Contains(s, StringComparer.OrdinalIgnoreCase));

    private async Task<(AccountInfo Account, EntraTenant Tenant)> RequireTenantAsync(CancellationToken ct)
    {
        var account = await activeAccount() ?? throw SignInNeeded();
        return (account, await client.TenantAsync(account.Key, ct));
    }

    private void Open(Uri url)
    {
        try
        {
            browser.Open(url);
        }
        catch (Exception ex) when (ex is ArgumentException or System.ComponentModel.Win32Exception or InvalidOperationException)
        {
            // The message never carries the URL: the consent URL has a state.
            throw new BridgeException(BridgeErrorCodes.Failed, "Kustodian couldn't open your browser.");
        }
    }

    private static string AppIdOf(JsonElement p) => RequireGuid(BridgeJson.Params<AppIdParams>(p).AppId);

    private static string RequireGuid(string? value) =>
        Guid.TryParseExact(value, "D", out var guid)
            ? guid.ToString("D")
            : throw new BridgeException(BridgeErrorCodes.BadRequest, "The app ID is not valid.");

    private static BridgeException SignInNeeded() => new(BridgeErrorCodes.SignInNeeded, SignInMessage);

    private static async Task<object?> GuardAsync(Func<Task<object?>> run)
    {
        try
        {
            return await run();
        }
        catch (Exception ex) when (SignInRequiredException.IsIn(ex))
        {
            throw SignInNeeded();
        }
        catch (EntraAppException ex)
        {
            throw new BridgeException(BridgeErrorCodes.Failed, ex.Message);
        }
    }

    private sealed record AppIdParams(string? AppId);

    private sealed record RetryParams(string? AppId, string? ObjectId);

    private sealed record ConsentParams(string? AppId, List<string>? AdminScopes);

    private sealed record PermissionRef(string? Resource, string? Name);

    private sealed record CreateParams(string? Name, List<PermissionRef>? Permissions);

    private sealed record StepData(CreateStep Step);

    private sealed record UrlAnswer(string Url);

    private sealed record CanGrantAnswer(bool? CanGrant);

    private sealed record PlanAnswer(
        bool CanCreate,
        [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
        string? Reason,
        string DefaultName,
        string TenantId,
        string TenantName,
        IReadOnlyList<PlannedGroup> Groups,
        int TablesWithData,
        int TablesWithoutData,
        int WriteOnlyTables);
}
