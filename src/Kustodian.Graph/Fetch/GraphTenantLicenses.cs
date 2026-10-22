using System.Collections.Concurrent;
using System.Net;
using System.Text;
using System.Text.Json;
using Kustodian.Graph.Run;

namespace Kustodian.Graph.Fetch;

/// <summary>The licenses of an account's tenant (<see cref="TenantLicenses"/>), for the runner and the schema panel.</summary>
public interface ITenantLicenses
{
    /// <summary>The account's licenses, kept from an earlier read unless <paramref name="refresh"/>. Never throws but for the caller
    /// cancelling: a read that fails is <see cref="TenantLicenses.Unknown"/>.</summary>
    ValueTask<TenantLicenses> GetAsync(string accountKey, bool refresh, CancellationToken ct);

    /// <summary>Forgets the account's licenses (it signed in again, or out).</summary>
    void RemoveAccount(string accountKey);
}

/// <summary>
/// Reads <c>GET /subscribedSkus</c> for an account (it needs <c>LicenseAssignment.Read.All</c> or <c>Directory.Read.All</c>) and
/// keeps the answer per account for <see cref="CacheFor"/>. A read Graph refuses (no permission) or that fails is unknown, and is
/// tried again after <see cref="RetryAfter"/>. The caller cancelling is not a failed read: nothing is kept.
/// </summary>
public sealed class GraphTenantLicenses(HttpClient graph, TimeProvider time) : ITenantLicenses
{
    public static readonly TimeSpan CacheFor = TimeSpan.FromHours(24);
    public static readonly TimeSpan RetryAfter = TimeSpan.FromMinutes(10);
    public static readonly TimeSpan CallTimeout = TimeSpan.FromSeconds(30);

    /// <summary>A tenant has some dozens of subscriptions; an answer over this isn't read.</summary>
    public const long MaxResponseBytes = 4L * 1024 * 1024;

    private readonly ConcurrentDictionary<string, (TenantLicenses Licenses, DateTimeOffset Until)> _cache = new(StringComparer.Ordinal);

    public void RemoveAccount(string accountKey) => _cache.TryRemove(accountKey, out _);

    public async ValueTask<TenantLicenses> GetAsync(string accountKey, bool refresh, CancellationToken ct)
    {
        var now = time.GetUtcNow();
        if (!refresh && _cache.TryGetValue(accountKey, out var hit) && now < hit.Until)
            return hit.Licenses;

        ct.ThrowIfCancellationRequested();
        using var timeout = new CancellationTokenSource(CallTimeout, time);
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(ct, timeout.Token);
        TenantLicenses licenses;
        try
        {
            licenses = await ReadAsync(accountKey, linked.Token);
        }
        catch (Exception ex) when (!ct.IsCancellationRequested)
        {
            licenses = TenantLicenses.Unknown(ex switch
            {
                LicenseReadException read => read.Message,
                OperationCanceledException => "Graph didn't send the tenant's licenses in time.",
                _ when SignInRequiredException.IsIn(ex) => "Sign in again to read the tenant's licenses.",
                _ => "The tenant's licenses couldn't be read.",
            });
        }

        _cache[accountKey] = (licenses, now + (licenses.Known ? CacheFor : RetryAfter));
        return licenses;
    }

    private async Task<TenantLicenses> ReadAsync(string accountKey, CancellationToken ct)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, new Uri("subscribedSkus", UriKind.Relative)).ForAccount(accountKey);
        using var response = await graph.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);
        if (response.Content.Headers.ContentLength > MaxResponseBytes)
            throw new LicenseReadException("The tenant's licenses are too large to read.");
        var body = await response.Content.ReadAsByteArrayAsync(ct);
        if (!response.IsSuccessStatusCode)
        {
            throw new LicenseReadException(response.StatusCode is HttpStatusCode.Forbidden or HttpStatusCode.Unauthorized
                ? "The account can't read the tenant's licenses (it needs LicenseAssignment.Read.All or Directory.Read.All)."
                : "The tenant's licenses couldn't be read: " + GraphErrorText.Summarize((int)response.StatusCode, Encoding.UTF8.GetString(body)));
        }

        try
        {
            using var document = JsonDocument.Parse(body);
            return TenantLicenses.FromSubscribedSkus(document.RootElement);
        }
        catch (JsonException)
        {
            throw new LicenseReadException("The tenant's licenses aren't readable.");
        }
    }

    private sealed class LicenseReadException(string message) : Exception(message);
}
