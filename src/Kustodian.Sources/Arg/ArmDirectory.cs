using System.Collections.Concurrent;
using System.Net;
using System.Text;
using System.Text.Json;
using Kustodian.Graph.Fetch;
using Kustodian.Graph.Run;
using static Kustodian.Sources.JsonText;

namespace Kustodian.Sources.Arg;

/// <summary>A subscription the account can see: its GUID, display name, tenant and state (<c>Enabled</c>, <c>Disabled</c>, …).</summary>
public sealed record ArmSubscription(string Id, string Name, string TenantId, string State);

/// <summary>A management group: its name (what a Resource Graph scope names) and display name.</summary>
public sealed record ArmManagementGroup(string Name, string DisplayName);

/// <summary>The management groups the account can see. <see cref="Note"/> says why the list is empty when they can't be listed.</summary>
public sealed record ArmManagementGroups(IReadOnlyList<ArmManagementGroup> Groups, string? Note);

/// <summary>Azure Resource Manager refused or failed a directory read; the message is fit to show. <see cref="Status"/> is the
/// refusal's HTTP status, when there was one.</summary>
public sealed class ArmDirectoryException(string message, HttpStatusCode? status = null) : Exception(message)
{
    public HttpStatusCode? Status { get; } = status;
}

/// <summary>
/// What the Resource Graph scope picker and side panel list, read through the ARM HTTP client for an account: its subscriptions
/// (<c>GET /subscriptions</c>, kept 10 minutes per account), its management groups (<c>GET
/// /providers/Microsoft.Management/managementGroups</c>; a 403 is an empty list with a note) and the resource types it has
/// (<c>Resources | distinct type</c> at scope "all", kept 24 hours per account). Lists follow <c>nextLink</c> only to https
/// <c>management.azure.com</c>, so a link elsewhere is never sent the account's token. A failed read is not kept. Failures throw
/// <see cref="ArmDirectoryException"/>; <see cref="SignInRequiredException"/>, <see cref="ConsentRequiredException"/> and the
/// caller cancelling pass through.
/// </summary>
public sealed class ArmDirectory(HttpClient arm, TimeProvider time)
{
    public static readonly Uri SubscriptionsEndpoint = new("https://management.azure.com/subscriptions?api-version=2022-12-01");

    public static readonly Uri ManagementGroupsEndpoint =
        new("https://management.azure.com/providers/Microsoft.Management/managementGroups?api-version=2023-04-01");

    public const string ResourceTypesQuery = "Resources | distinct type | order by type asc";

    public const string NoManagementGroups = "You can't list management groups.";

    public static readonly TimeSpan SubscriptionsCacheFor = TimeSpan.FromMinutes(10);
    public static readonly TimeSpan ResourceTypesCacheFor = TimeSpan.FromHours(24);
    public static readonly TimeSpan CallTimeout = TimeSpan.FromSeconds(30);

    /// <summary>A list page is small; a body over this is not read on.</summary>
    public const long MaxResponseBytes = 16L * 1024 * 1024;

    private const int MaxListPages = 100;
    private const int MaxResourceTypes = 10_000;

    private readonly ArgClient _arg = new(arm, time);
    private readonly ConcurrentDictionary<string, (IReadOnlyList<ArmSubscription> Value, DateTimeOffset Until)> _subscriptions = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, (IReadOnlyList<string> Value, DateTimeOffset Until)> _types = new(StringComparer.Ordinal);

    /// <summary>Forgets what was read for <paramref name="accountKey"/> (it signed out).</summary>
    public void RemoveAccount(string accountKey)
    {
        _subscriptions.TryRemove(accountKey, out _);
        _types.TryRemove(accountKey, out _);
    }

    public async Task<IReadOnlyList<ArmSubscription>> SubscriptionsAsync(string accountKey, CancellationToken ct)
    {
        var now = time.GetUtcNow();
        if (_subscriptions.TryGetValue(accountKey, out var hit) && now < hit.Until)
        {
            return hit.Value;
        }

        var items = await ListAsync(accountKey, SubscriptionsEndpoint, ct);
        IReadOnlyList<ArmSubscription> subscriptions =
        [
            .. items.Select(i => Text(i, "subscriptionId") is { Length: > 0 } id
                ? new ArmSubscription(id, Text(i, "displayName") ?? id, Text(i, "tenantId") ?? "", Text(i, "state") ?? "")
                : null).OfType<ArmSubscription>(),
        ];
        _subscriptions[accountKey] = (subscriptions, now + SubscriptionsCacheFor);
        return subscriptions;
    }

    public async Task<ArmManagementGroups> ManagementGroupsAsync(string accountKey, CancellationToken ct)
    {
        IReadOnlyList<JsonElement> items;
        try
        {
            items = await ListAsync(accountKey, ManagementGroupsEndpoint, ct);
        }
        catch (ArmDirectoryException ex) when (ex.Status == HttpStatusCode.Forbidden)
        {
            return new ArmManagementGroups([], NoManagementGroups);
        }

        return new ArmManagementGroups(
        [
            .. items.Select(i => Text(i, "name") is { Length: > 0 } name
                ? new ArmManagementGroup(name, i.TryGetProperty("properties", out var p) ? Text(p, "displayName") ?? name : name)
                : null).OfType<ArmManagementGroup>(),
        ], null);
    }

    public async Task<IReadOnlyList<string>> ResourceTypesAsync(string accountKey, CancellationToken ct)
    {
        var now = time.GetUtcNow();
        if (_types.TryGetValue(accountKey, out var hit) && now < hit.Until)
        {
            return hit.Value;
        }

        var answer = await _arg.RunAsync(accountKey, ResourceTypesQuery, ArgScope.Default, MaxResourceTypes, new RunDiagnostics(time), ct);
        if (answer.Outcome != RunOutcome.Ok)
        {
            throw new ArmDirectoryException(answer.Message ?? "The resource types couldn't be read.");
        }

        var column = answer.Columns.ToList().FindIndex(c => c.Name == "type");
        IReadOnlyList<string> types = column < 0
            ? []
            : [.. answer.Rows.Select(r => r[column]).Where(v => v.ValueKind == JsonValueKind.String).Select(v => v.GetString()!)];
        _types[accountKey] = (types, now + ResourceTypesCacheFor);
        return types;
    }

    /// <summary>Every <c>value</c> item of a list, following <c>nextLink</c> within https ARM.</summary>
    private async Task<IReadOnlyList<JsonElement>> ListAsync(string accountKey, Uri first, CancellationToken ct)
    {
        var items = new List<JsonElement>();
        Uri? next = first;
        for (var page = 0; next is not null && page < MaxListPages; page++)
        {
            using var document = await ReadAsync(accountKey, next, ct);
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
            {
                throw new ArmDirectoryException("Azure's answer isn't readable.");
            }

            if (root.TryGetProperty("value", out var value) && value.ValueKind == JsonValueKind.Array)
            {
                items.AddRange(value.EnumerateArray().Select(v => v.Clone()));
            }

            next = Text(root, "nextLink") is { Length: > 0 } link && Uri.TryCreate(link, UriKind.Absolute, out var uri) && IsArm(uri) ? uri : null;
        }

        return items;
    }

    private static bool IsArm(Uri uri) =>
        uri.Scheme == Uri.UriSchemeHttps && string.Equals(uri.Host, Arm.Host, StringComparison.OrdinalIgnoreCase) && uri.IsDefaultPort;

    private async Task<JsonDocument> ReadAsync(string accountKey, Uri uri, CancellationToken ct)
    {
        using var timeout = new CancellationTokenSource(CallTimeout, time);
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(ct, timeout.Token);
        using var request = new HttpRequestMessage(HttpMethod.Get, uri).ForAccount(accountKey);
        try
        {
            using var response = await arm.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, linked.Token);
            var body = await BodyReader.ReadAsync(response.Content, MaxResponseBytes, linked.Token)
                ?? throw new ArmDirectoryException("Azure's answer is too large.");
            if (!response.IsSuccessStatusCode)
            {
                if (ArgClient.IsTokenRejected(response, body))
                {
                    throw new SignInRequiredException(GraphErrorText.SignInMessage);
                }

                throw new ArmDirectoryException(
                    GraphErrorText.Summarize((int)response.StatusCode, Encoding.UTF8.GetString(body), GraphErrorText.Azure),
                    response.StatusCode);
            }

            return JsonDocument.Parse(body);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw;
        }
        catch (OperationCanceledException) when (timeout.IsCancellationRequested)
        {
            throw new ArmDirectoryException("Azure didn't answer in time. Try again.");
        }
        catch (JsonException)
        {
            throw new ArmDirectoryException("Azure's answer isn't readable.");
        }
        catch (Exception ex) when (ex is HttpRequestException or IOException)
        {
            throw new ArmDirectoryException("Azure couldn't be reached. Check the connection and try again.");
        }
    }
}
