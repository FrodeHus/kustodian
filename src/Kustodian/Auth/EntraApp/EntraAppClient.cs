using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Kustodian.Graph.Fetch;
using Kustodian.Graph.Run;

namespace Kustodian.Auth.EntraApp;

/// <summary>The tenant the Graph token is for, as <c>/organization</c> reports it.</summary>
public sealed record EntraTenant(string Id, string DisplayName);

/// <summary>What to create: the app's name and the permissions the user left ticked.</summary>
public sealed record CreateRequest(string Name, IReadOnlyList<PlannedPermission> Permissions);

/// <summary>The steps of a create, reported as each starts.</summary>
public enum CreateStep { LookUp, CreateApp, AddOwner, CreateServicePrincipal }

/// <summary>What a create made. <paramref name="ServicePrincipalId"/> is null when step 4 did not finish, with
/// <paramref name="ServicePrincipalMessage"/> saying why; <paramref name="OwnerMessage"/> is set when the owner was not added.</summary>
public sealed record CreateResult(
    string AppId,
    string ObjectId,
    string? ServicePrincipalId,
    string TenantId,
    bool OwnerAdded,
    string? OwnerMessage,
    IReadOnlyList<string> Dropped,
    string? ServicePrincipalMessage);

/// <summary>The scopes granted tenant-wide to an app, and the admin scopes still missing.</summary>
public sealed record ConsentStatus(IReadOnlyList<string> Granted, IReadOnlyList<string> Missing);

/// <summary>A create failed. <see cref="NothingCreated"/> says whether the tenant is untouched.</summary>
public sealed class EntraAppException(string message, bool nothingCreated) : Exception(message)
{
    public bool NothingCreated { get; } = nothingCreated;
}

/// <summary>Creates an Entra application registration through Microsoft Graph and reads its admin-consent state. Every request
/// names the account it is for and goes through the Graph client's token handler; bodies and tokens are never logged.</summary>
public sealed class EntraAppClient(HttpClient graph, TimeProvider time)
{
    private const string V1 = "https://graph.microsoft.com/v1.0/";

    private static readonly string[] RedirectUris =
        ["http://localhost", "https://login.microsoftonline.com/common/oauth2/nativeclient"];

    private static readonly TimeSpan[] ServicePrincipalBackoff =
        [TimeSpan.FromSeconds(1), TimeSpan.FromSeconds(2), TimeSpan.FromSeconds(4), TimeSpan.FromSeconds(8), TimeSpan.FromSeconds(8)];

    private static readonly HashSet<string> GrantingRoles = new(StringComparer.OrdinalIgnoreCase)
    {
        "62e90394-69f5-4237-9190-012177145e10", // Global Administrator
        "e8611ab8-c189-46e8-94e1-60213ab1f814", // Privileged Role Administrator
        "158c047a-c907-4556-b7ef-446551a6b5f7", // Cloud Application Administrator
        "9b895d92-2cd3-44c7-9d02-a6ac2d5ea5c3", // Application Administrator
        "d2562ede-74db-457e-a7b6-544e236ebb61", // AI Administrator
    };

    private const string AppCreateDenied =
        "Your tenant doesn't let you register applications. An admin can turn on 'Users can register applications', "
        + "give you the Application Developer role, or create the app for you.";

    private const string ServicePrincipalDenied =
        "You can't create its enterprise application; an admin's consent (next step) creates it.";

    private sealed record Reply(HttpStatusCode Status, JsonNode? Body)
    {
        public bool Ok => (int)Status is >= 200 and < 300;

        public string? ErrorMessage => (string?)Body?["error"]?["message"];
    }

    /// <summary>The tenant the Graph token is for, which is not always the account's home tenant.</summary>
    public async Task<EntraTenant> TenantAsync(string accountKey, CancellationToken ct)
    {
        var reply = await SendAsync(accountKey, HttpMethod.Get, V1 + "organization?$select=id,displayName", null, ct);
        var org = reply.Ok ? reply.Body?["value"]?.AsArray().FirstOrDefault() : null;
        var id = (string?)org?["id"];
        if (id is null)
        {
            throw new EntraAppException(Join("Kustodian couldn't read your tenant from Microsoft Graph.", reply.ErrorMessage), true);
        }

        return new EntraTenant(id, (string?)org?["displayName"] ?? id);
    }

    /// <summary>Runs the four steps. Throws <see cref="EntraAppException"/> with <c>NothingCreated</c> when it fails before the
    /// app exists; after that, a failure in owner or service principal is carried in the result.</summary>
    public async Task<CreateResult> CreateAsync(
        string accountKey, EntraTenant tenant, CreateRequest request, Action<CreateStep> onStep, CancellationToken ct)
    {
        onStep(CreateStep.LookUp);
        var (access, dropped) = await ResolveAccessAsync(accountKey, request.Permissions, ct);

        onStep(CreateStep.CreateApp);
        var (appId, objectId) = await CreateApplicationAsync(accountKey, request.Name, access, ct);

        onStep(CreateStep.AddOwner);
        var (ownerAdded, ownerMessage) = await AddOwnerAsync(accountKey, objectId, ct);

        onStep(CreateStep.CreateServicePrincipal);
        var (spId, spMessage) = await CreateServicePrincipalAsync(accountKey, appId, ct);

        return new CreateResult(appId, objectId, spId, tenant.Id, ownerAdded, ownerMessage, dropped, spMessage);
    }

    /// <summary>Retries step 4 only, for an app that exists without a service principal.</summary>
    public async Task<CreateResult> RetryServicePrincipalAsync(string accountKey, CreateResult partial, CancellationToken ct)
    {
        var (spId, message) = await CreateServicePrincipalAsync(accountKey, partial.AppId, ct);
        return partial with { ServicePrincipalId = spId, ServicePrincipalMessage = message };
    }

    /// <summary>The scopes granted to the whole tenant for <paramref name="appId"/> (both resources), and which of
    /// <paramref name="adminScopes"/> are not among them. No service principal means nothing is granted.</summary>
    public async Task<ConsentStatus> ConsentStatusAsync(
        string accountKey, string appId, IReadOnlyList<string> adminScopes, CancellationToken ct)
    {
        var sp = await SendAsync(accountKey, HttpMethod.Get,
            V1 + $"servicePrincipals(appId='{Uri.EscapeDataString(appId)}')?$select=id", null, ct);
        if (sp.Status == HttpStatusCode.NotFound)
        {
            return new ConsentStatus([], adminScopes);
        }

        var spId = sp.Ok ? (string?)sp.Body?["id"] : null;
        if (spId is null)
        {
            throw new EntraAppException(Join("Kustodian couldn't read the application's enterprise application.", sp.ErrorMessage), false);
        }

        var granted = new SortedSet<string>(StringComparer.Ordinal);
        string? next = V1 + $"oauth2PermissionGrants?$filter=clientId eq '{spId}' and consentType eq 'AllPrincipals'";
        while (next is not null)
        {
            var page = await SendAsync(accountKey, HttpMethod.Get, next, null, ct);
            if (!page.Ok)
            {
                throw new EntraAppException(Join("Kustodian couldn't read the granted permissions.", page.ErrorMessage), false);
            }

            foreach (var grant in page.Body?["value"]?.AsArray() ?? [])
            {
                foreach (var scope in ((string?)grant?["scope"])?.Split(' ', StringSplitOptions.RemoveEmptyEntries) ?? [])
                {
                    granted.Add(scope);
                }
            }

            next = (string?)page.Body?["@odata.nextLink"];
        }

        return new ConsentStatus([.. granted], [.. adminScopes.Where(s => !granted.Contains(s))]);
    }

    /// <summary>Whether the user holds an active role that can grant tenant-wide consent; null when that could not be read.</summary>
    public async Task<bool?> CanGrantAsync(string accountKey, CancellationToken ct)
    {
        try
        {
            var reply = await SendAsync(accountKey, HttpMethod.Get,
                V1 + "me/memberOf/microsoft.graph.directoryRole?$select=roleTemplateId", null, ct);
            if (!reply.Ok || reply.Body?["value"] is not JsonArray roles)
            {
                return null;
            }

            return roles.Any(r => (string?)r?["roleTemplateId"] is { } id && GrantingRoles.Contains(id));
        }
        catch (Exception ex) when (ex is not OperationCanceledException && !SignInRequiredException.IsIn(ex))
        {
            return null;
        }
    }

    /// <summary>The admin consent page for an app. <paramref name="state"/> is added only when Kustodian opens the page itself.</summary>
    public static Uri ConsentUrl(string tenantId, string appId, string? state)
    {
        var url = $"https://login.microsoftonline.com/{Uri.EscapeDataString(tenantId)}/v2.0/adminconsent"
            + $"?client_id={Uri.EscapeDataString(appId)}"
            + "&scope=https://graph.microsoft.com/.default"
            + "&redirect_uri=https://login.microsoftonline.com/common/oauth2/nativeclient";
        if (state is not null)
        {
            url += $"&state={Uri.EscapeDataString(state)}";
        }

        return new Uri(url);
    }

    private async Task<(JsonArray Access, List<string> Dropped)> ResolveAccessAsync(
        string accountKey, IReadOnlyList<PlannedPermission> permissions, CancellationToken ct)
    {
        var access = new JsonArray();
        var dropped = new List<string>();
        foreach (var group in permissions.GroupBy(p => p.ResourceAppId))
        {
            var resource = group.First().Resource;
            var reply = await SendAsync(accountKey, HttpMethod.Get,
                V1 + $"servicePrincipals(appId='{group.Key}')?$select=id,oauth2PermissionScopes", null, ct);
            if (!reply.Ok)
            {
                var whose = group.Key == SourcePermissions.GraphAppId ? "Microsoft Graph's" : $"{resource}'s";
                throw new EntraAppException(
                    Join($"Kustodian couldn't read {whose} permission list in your tenant.", reply.ErrorMessage), true);
            }

            var ids = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (var scope in reply.Body?["oauth2PermissionScopes"]?.AsArray() ?? [])
            {
                if ((string?)scope?["value"] is { } name && (string?)scope["id"] is { } id)
                {
                    ids[name] = id;
                }
            }

            var entries = new JsonArray();
            foreach (var permission in group.DistinctBy(p => p.Name, StringComparer.OrdinalIgnoreCase))
            {
                if (ids.TryGetValue(permission.Name, out var id))
                {
                    entries.Add(new JsonObject { ["id"] = id, ["type"] = "Scope" });
                }
                else
                {
                    dropped.Add(permission.Name);
                }
            }

            if (entries.Count > 0)
            {
                access.Add(new JsonObject { ["resourceAppId"] = group.Key, ["resourceAccess"] = entries });
            }
        }

        return (access, dropped);
    }

    private async Task<(string AppId, string ObjectId)> CreateApplicationAsync(
        string accountKey, string name, JsonArray access, CancellationToken ct)
    {
        var body = new JsonObject
        {
            ["displayName"] = name,
            ["signInAudience"] = "AzureADMyOrg",
            ["isFallbackPublicClient"] = true,
            ["publicClient"] = new JsonObject { ["redirectUris"] = new JsonArray(RedirectUris.Select(u => (JsonNode)JsonValue.Create(u)!).ToArray()) },
            ["requiredResourceAccess"] = access,
        };
        var reply = await SendAsync(accountKey, HttpMethod.Post, V1 + "applications", body, ct);
        if (reply.Status == HttpStatusCode.Forbidden)
        {
            throw new EntraAppException(AppCreateDenied, true);
        }

        var appId = reply.Ok ? (string?)reply.Body?["appId"] : null;
        var objectId = reply.Ok ? (string?)reply.Body?["id"] : null;
        if (appId is null || objectId is null)
        {
            throw new EntraAppException(Join("Kustodian couldn't create the application.", reply.ErrorMessage), true);
        }

        return (appId, objectId);
    }

    private async Task<(bool Added, string? Message)> AddOwnerAsync(string accountKey, string objectId, CancellationToken ct)
    {
        try
        {
            var me = await SendAsync(accountKey, HttpMethod.Get, V1 + "me?$select=id", null, ct);
            var meId = me.Ok ? (string?)me.Body?["id"] : null;
            if (meId is null)
            {
                return (false, Join("You were not added as owner.", me.ErrorMessage));
            }

            var owner = new JsonObject { ["@odata.id"] = V1 + "directoryObjects/" + meId };
            var reply = await SendAsync(accountKey, HttpMethod.Post, V1 + $"applications/{objectId}/owners/$ref", owner, ct);
            if (reply.Ok
                || (reply.Status == HttpStatusCode.BadRequest
                    && reply.ErrorMessage?.Contains("already exist", StringComparison.OrdinalIgnoreCase) == true))
            {
                return (true, null);
            }

            return (false, Join("You were not added as owner.", reply.ErrorMessage));
        }
        catch (Exception ex) when (ex is HttpRequestException)
        {
            return (false, "You were not added as owner.");
        }
    }

    private async Task<(string? Id, string? Message)> CreateServicePrincipalAsync(string accountKey, string appId, CancellationToken ct)
    {
        var body = new JsonObject { ["appId"] = appId };
        Reply reply;
        for (var attempt = 0; ; attempt++)
        {
            reply = await SendAsync(accountKey, HttpMethod.Post, V1 + "servicePrincipals", body, ct);
            if (reply.Ok && (string?)reply.Body?["id"] is { } id)
            {
                return (id, null);
            }

            if (reply.Status == HttpStatusCode.Forbidden)
            {
                return (null, ServicePrincipalDenied);
            }

            var replicating = reply.Status is HttpStatusCode.NotFound or HttpStatusCode.BadRequest;
            if (!replicating || attempt >= ServicePrincipalBackoff.Length)
            {
                break;
            }

            await Task.Delay(ServicePrincipalBackoff[attempt], time, ct);
        }

        return (null, Join("The application was created, but its enterprise application was not.", reply.ErrorMessage));
    }

    private async Task<Reply> SendAsync(string accountKey, HttpMethod method, string url, JsonNode? body, CancellationToken ct)
    {
        using var request = new HttpRequestMessage(method, new Uri(url.Replace(" ", "%20", StringComparison.Ordinal)))
            .ForAccount(accountKey);
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        if (body is not null)
        {
            request.Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json");
        }

        using var response = await graph.SendAsync(request, ct);
        var text = await response.Content.ReadAsStringAsync(ct);
        JsonNode? parsed = null;
        if (!string.IsNullOrWhiteSpace(text))
        {
            try
            {
                parsed = JsonNode.Parse(text);
            }
            catch (JsonException)
            {
                parsed = null;
            }
        }

        return new Reply(response.StatusCode, parsed);
    }

    private static string Join(string text, string? graphMessage)
        => string.IsNullOrWhiteSpace(graphMessage) ? text : $"{text} {graphMessage}";
}
