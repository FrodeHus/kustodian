using Kustodian.Graph.Fetch;

namespace Kustodian.Telemetry;

/// <summary>
/// <see cref="IGraphProbeCache"/> that also shares, when the user opted in (<paramref name="sharing"/>), each new thing probing
/// finds about how Graph lists a table: that it refuses <c>$top</c>, a clause it refuses (<c>$count</c>, <c>$orderby</c>,
/// <c>$select</c>, a filter feature such as <c>proxyAddresses/any</c>), or columns it won't serve in a list. Each is one
/// <c>GraphProbeFinding</c> event with the table's schema path, the kind of finding and its detail; never the account, the
/// tenant, a query, a filter value or a row. Columns refused for permission aren't shared: they describe the account, not
/// Graph. A finding the cache already holds isn't shared again, and the send doesn't hold up the read.
/// </summary>
public sealed class SharedProbeCache(IGraphProbeCache inner, Func<CancellationToken, Task<bool>> sharing, AppInsightsTelemetry telemetry)
    : IGraphProbeCache
{
    public const string EventName = "GraphProbeFinding";

    public ValueTask<GraphProbeFindings?> GetAsync(string accountKey, string path, CancellationToken ct) => inner.GetAsync(accountKey, path, ct);

    public async ValueTask SetAsync(string accountKey, string path, IReadOnlyList<string> notListed, IReadOnlyList<string> denied,
        CancellationToken ct)
    {
        var earlier = (await inner.GetAsync(accountKey, path, ct))?.NotListed ?? [];
        await inner.SetAsync(accountKey, path, notListed, denied, ct);
        var found = notListed.Except(earlier, StringComparer.Ordinal).ToList();
        if (found.Count > 0)
            await ShareAsync(path, "notListed", string.Join(", ", found), ct);
    }

    public ValueTask<GraphDefaultColumns?> GetDefaultsAsync(string accountKey, string path, CancellationToken ct) =>
        inner.GetDefaultsAsync(accountKey, path, ct);

    public ValueTask SetDefaultsAsync(string accountKey, string path, IReadOnlyList<string> columns, CancellationToken ct) =>
        inner.SetDefaultsAsync(accountKey, path, columns, ct);

    public ValueTask<IReadOnlyDictionary<string, GraphDefaultColumns>> DefaultsOfAsync(string accountKey, CancellationToken ct) =>
        inner.DefaultsOfAsync(accountKey, ct);

    public ValueTask<bool> RefusesTopAsync(string accountKey, string path, CancellationToken ct) => inner.RefusesTopAsync(accountKey, path, ct);

    public async ValueTask SetRefusesTopAsync(string accountKey, string path, bool refuses, CancellationToken ct)
    {
        var earlier = await inner.RefusesTopAsync(accountKey, path, ct);
        await inner.SetRefusesTopAsync(accountKey, path, refuses, ct);
        if (refuses && !earlier)
            await ShareAsync(path, "refusesTop", "$top", ct);
    }

    public ValueTask<IReadOnlySet<string>> RefusedAsync(string accountKey, string path, CancellationToken ct) => inner.RefusedAsync(accountKey, path, ct);

    public async ValueTask SetRefusedAsync(string accountKey, string path, string clause, bool refused, CancellationToken ct)
    {
        var earlier = await inner.RefusedAsync(accountKey, path, ct);
        await inner.SetRefusedAsync(accountKey, path, clause, refused, ct);
        if (refused && !earlier.Contains(clause))
            await ShareAsync(path, "refused", clause, ct);
    }

    public ValueTask RemoveAccountAsync(string accountKey, CancellationToken ct) => inner.RemoveAccountAsync(accountKey, ct);

    public ValueTask ClearAsync(CancellationToken ct) => inner.ClearAsync(ct);

    private async Task ShareAsync(string path, string finding, string detail, CancellationToken ct)
    {
        if (!telemetry.Configured || !await sharing(ct))
            return;
        // Not awaited: a slow or unreachable ingestion endpoint mustn't hold up the query. The send never throws.
        _ = telemetry.TrackEventAsync(EventName, new Dictionary<string, string>
        {
            ["path"] = path,
            ["finding"] = finding,
            ["detail"] = detail,
        }, CancellationToken.None);
    }
}
