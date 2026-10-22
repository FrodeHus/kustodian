using System.Globalization;
using System.Net;
using System.Text.Json;
using System.Text.Json.Nodes;
using Kustodian.Graph.Run;
using Kustodian.Graph.Query;

namespace Kustodian.Graph.Fetch;

/// <summary>What one collection read returned. <c>Requests</c> are the relative URLs as sent (the per-object reads once, as
/// <see cref="GraphBatchReader.Template"/>); <c>Unfiltered</c> says Graph refused the <c>$filter</c> and the whole collection
/// was read; <c>Unreadable</c> are the properties Graph won't serve in a list and that are missing from the objects, and the
/// relationship columns left unread because they were capped (<see cref="GraphRelationshipOutcome.Capped"/>).
/// <see cref="PerObject"/> are such properties read one object at a time instead, <see cref="PerObjectFailed"/> the objects
/// whose read failed (their values are empty), and <see cref="PerObjectCapped"/> says the collection had more objects than
/// <see cref="GraphLimits.PerObjectReadsPerTable"/> to read, so its named properties stayed unread. <see cref="PerObjectCached"/> are
/// the objects whose such properties came from the cache (<see cref="IGraphObjectCache"/>) instead, and
/// <see cref="PerObjectCachedAt"/> when the oldest of them was read from Graph.</summary>
public sealed record GraphCollection(IReadOnlyList<JsonObject> Objects, IReadOnlyList<string> Requests, bool Unfiltered,
    IReadOnlyList<string> Unreadable)
{
    public IReadOnlyList<string> PerObject { get; init; } = [];
    public int PerObjectFailed { get; init; }
    public bool PerObjectCapped { get; init; }
    public int PerObjectCached { get; init; }
    public DateTimeOffset? PerObjectCachedAt { get; init; }
    /// <summary>Selected properties Graph refused for permission (401/403) while the rest of the table read: their values are
    /// empty, and they aren't read one object at a time either.</summary>
    public IReadOnlyList<string> Denied { get; init; } = [];
    /// <summary>Selected properties the query doesn't name, left out after Graph refused the list for a license or feature the
    /// tenant lacks (<see cref="UnlicensedReason"/>, Graph's message): their values are empty.</summary>
    public IReadOnlyList<string> Unlicensed { get; init; } = [];
    public string? UnlicensedReason { get; init; }
    /// <summary>Graph's count of the collection's objects that pass the filter, when the fetch asked for a count
    /// (<see cref="GraphFetch.Count"/>) and Graph gave one: then no object was read.</summary>
    public long? Count { get; init; }
    /// <summary>The relationship columns the query names, each read on its own (<see cref="GraphRelationshipReader"/>) and
    /// never counted in <see cref="PerObject"/>, <see cref="PerObjectFailed"/> or <see cref="PerObjectCapped"/>.</summary>
    public IReadOnlyList<GraphRelationshipOutcome> Relationships { get; init; } = [];
}

/// <summary>How one relationship column was read: <c>Objects</c> are the listed objects it was meant for, <c>Truncated</c> those
/// cut off at <see cref="GraphLimits.RelationshipEntriesPerObject"/> (cached values included), <c>Refused</c> those Graph refused
/// for permission and <c>Failed</c> those that couldn't be read (both left empty). <c>Capped</c>: more than
/// <see cref="GraphLimits.RelationshipObjectsPerTable"/> objects were left to read, so nothing was read or merged.
/// <c>Cached</c> are the objects whose value came from the cache. <c>Limited</c> are the entries, over all objects (cached
/// values included), with no <c>displayName</c>: Graph answers a directory object of a type the account can't read with only
/// its <c>@odata.type</c> and <c>id</c>, not a refusal.</summary>
public sealed record GraphRelationshipOutcome(string Column, int Objects, int Truncated, int Refused, int Failed, bool Capped, int Cached,
    int Limited);

/// <summary>
/// Reads one Graph collection for the signed-in account, page by page, within the object cap
/// (<see cref="GraphLimits.ObjectsPerTable"/>) and the byte budget. The HttpClient's
/// handler adds the account's token. The
/// properties the query names that Graph won't serve in a list are then read one object at a time
/// (<see cref="GraphBatchReader"/>), for at most <see cref="GraphLimits.PerObjectReadsPerTable"/> objects: those whose values are in
/// <paramref name="cache"/> take them from there, and only the others are read and then kept. With <paramref name="probes"/>,
/// the first read of a table for an account learns the columns Graph lists by default (one object, without <c>$select</c>),
/// and the list then selects only those and the columns the query names; the columns probing finds a table can't serve in a
/// list are kept there too, so the next run leaves them out at once. Without it neither is learnt nor kept.
/// A request Graph throttles (429) is sent once more after its <c>Retry-After</c> (at most <see cref="MaxRetryWait"/>, on
/// <paramref name="time"/>). With a row limit (<see cref="GraphFetch.Top"/>) the list asks for no more than that as <c>$top</c>
/// and stops once it has that many objects; a table that refuses <c>$top</c> is read again without it (still stopping early),
/// and with <paramref name="probes"/> later runs leave it out at once. A fetch that is a count (<see cref="GraphFetch.Count"/>) asks
/// Graph for the count first (<c>/$count</c> on directory objects, else <c>$count=true</c>), and reads the objects only when
/// Graph won't count. A sort (<see cref="GraphFetch.OrderBy"/>) is sent as <c>$orderby</c>, and what Graph returns is checked:
/// out of order, or with a null in the sort column, the read starts again without the sort or the row limit. On directory
/// objects a sort or a clause that needs it (<see cref="FilterClause.Advanced"/>) sends Graph's advanced query parameters, the
/// <c>ConsistencyLevel: eventual</c> header and <c>$count=true</c>. When Graph refuses the first page with a 400, the sort is left
/// out first, then the filter clauses with a feature (<see cref="FilterClause.Feature"/>), then the whole filter, each read
/// again once; with <paramref name="probes"/> a refused sort, count or feature is remembered for the account and table and left
/// out at once next time.
/// </summary>
public sealed class GraphCollectionReader(HttpClient http, GraphFetchBudget budget, IGraphObjectCache cache, GraphLimits limits,
    IGraphProbeCache? probes = null, TimeProvider? time = null)
{
    public const int MaxSelectRetries = 5;
    /// <summary>Probes spent finding the columns a backend can't serve in a list (one for <c>id</c> alone, then halves).</summary>
    public const int MaxProbes = 16;
    private const string GraphHost = "graph.microsoft.com";
    /// <summary>The names <see cref="IGraphProbeCache.RefusedAsync"/> keeps a refused count and sort under; a filter clause's is its
    /// feature.</summary>
    public const string CountClause = "$count";
    public const string OrderByClause = "$orderby";
    private const int PageSize = 999;
    private const int DefaultRetryAfterSeconds = 60;
    /// <summary>The longest a throttled request waits before it is sent once more.</summary>
    public static readonly TimeSpan MaxRetryWait = TimeSpan.FromSeconds(30);
    /// <summary>The wait before a throttled request is sent once more when Graph sends no <c>Retry-After</c>.</summary>
    private static readonly TimeSpan NoRetryAfterWait = TimeSpan.FromSeconds(10);

    private readonly IGraphProbeCache _probes = probes ?? NoGraphProbeCache.Instance;
    private readonly bool _learnsDefaults = probes is not null;
    private readonly TimeProvider _time = time ?? TimeProvider.System;

    private readonly GraphBatchReader _perObject = new(http, limits);
    private readonly GraphRelationshipColumns _relationships = new(http, cache, limits);

    /// <summary>The limits this reader reads within.</summary>
    public GraphLimits Limits => limits;

    /// <summary>A lease on this reader's process budget, for the reads of one run.</summary>
    public GraphFetchLease Lease() => budget.Lease();

    /// <summary>Reads the collection, for no run's diagnostics.</summary>
    public Task<GraphCollection> ReadAsync(string accountKey, GraphFetch fetch, GraphFetchLease lease, bool refresh, CancellationToken ct)
        => ReadAsync(accountKey, fetch, lease, refresh, null, ct);

    /// <summary>Reads the collection. <paramref name="accountKey"/> keys the caches and goes on every request
    /// (<see cref="GraphRequestAccount"/>), so each is sent with that account's token. <paramref name="refresh"/>: per-object reads
    /// skip the cache (and refill it), the columns Graph lists by default are read again, and the columns probing found earlier
    /// are selected again (and probed again if refused).
    /// <paramref name="diagnostics"/>, when given, goes on every request too (<see cref="RunDiagnosticsRequest.ForRun"/>), and
    /// gets the read's steps: columns dropped and why, throttling, per-object reads and cache hits. Throws
    /// <see cref="GraphReadException"/> for every failure that isn't the caller cancelling; a <see cref="SignInRequiredException"/>
    /// from the HTTP pipeline (also wrapped in an <see cref="HttpRequestException"/>) passes through.</summary>
    public async Task<GraphCollection> ReadAsync(string accountKey, GraphFetch fetch, GraphFetchLease lease, bool refresh,
        RunDiagnostics? diagnostics, CancellationToken ct)
    {
        var select = fetch.Select.ToList();
        // The plan's unreadable columns (never selected in a list) first, then those Graph refuses.
        var unreadable = new List<string>(fetch.Unreadable);
        var refusedSelects = 0;
        var probed = false;
        var denied = new List<string>();
        var unlicensed = new List<string>();
        string? unlicensedReason = null;
        var requests = new List<string>();
        var objects = new List<JsonObject>();
        var unfiltered = false;
        var path = fetch.Table.Path;
        var table = fetch.Table.Name;
        var limit = fetch.Top;
        var sendTop = true;
        var refusedTopEarlier = false;

        try
        {
            // A refresh sends what Graph refused earlier again, and forgets the refusals of what Graph then takes.
            var refusedEarlier = await _probes.RefusedAsync(accountKey, path, ct);
            var refused = refresh ? new HashSet<string>(StringComparer.Ordinal) : refusedEarlier.ToHashSet(StringComparer.Ordinal);
            var clauses = fetch.FilterClauses.Where(c => c.Feature is null || !refused.Contains(c.Feature)).ToList();
            var whole = clauses.Count == fetch.FilterClauses.Count;
            if (!whole)
                Log(diagnostics, DiagnosticKinds.Probe, $"{table}: left out (Graph refused it earlier) "
                    + string.Join(", ", fetch.FilterClauses.Where(c => !clauses.Contains(c)).Select(c => c.OData)));
            var orderBy = whole && !refused.Contains(OrderByClause) ? fetch.OrderBy : null;
            if (fetch.OrderBy is not null && whole && orderBy is null)
                Log(diagnostics, DiagnosticKinds.Probe, $"{table}: left out $orderby (Graph refused it earlier)");
            // Without the whole filter or the sort, the first rows Graph sends aren't the query's.
            if (!whole || (fetch.OrderBy is not null && orderBy is null))
                limit = null;

            var countRefused = false;
            if (fetch.Count is not null && whole && !refused.Contains(CountClause))
            {
                var (count, refusedCount) = await CountAsync(accountKey, fetch, Filter(clauses), lease, requests, diagnostics, ct);
                if (count is { } n)
                {
                    if (refusedEarlier.Contains(CountClause))
                        await _probes.SetRefusedAsync(accountKey, path, CountClause, false, ct);
                    return new GraphCollection([], requests, false, unreadable) { Count = n };
                }
                countRefused = refusedCount;
            }

            if (_learnsDefaults && await DefaultColumnsAsync(accountKey, fetch, refresh, lease, requests, diagnostics, ct) is { } defaults)
            {
                // A column outside the default set is selected only when the query names it.
                var keep = defaults.Concat(fetch.Named).Append("id").ToHashSet(StringComparer.Ordinal);
                var others = select.Where(c => !keep.Contains(c)).ToList();
                if (others.Count > 0)
                {
                    select.RemoveAll(others.Contains);
                    Log(diagnostics, DiagnosticKinds.Probe, $"{table}: selected the columns Graph lists by default; left out "
                        + string.Join(", ", others) + " (the query doesn't name them)");
                }
            }
            var earlier = await _probes.GetAsync(accountKey, path, ct);
            // Kept as found: what a refresh doesn't select again stays as it was.
            var notListed = earlier?.NotListed.Where(c => !refresh || !select.Contains(c)).ToList() ?? [];
            var deniedFound = earlier?.Denied.Where(c => !refresh || !select.Contains(c)).ToList() ?? [];
            if (!refresh && earlier is not null && LeaveOut(select, earlier, unreadable, denied) is { Length: > 0 } leftOut)
                Log(diagnostics, DiagnosticKinds.Probe, $"{table}: left out (found earlier) {leftOut}");
            if (await _probes.RefusesTopAsync(accountKey, path, ct))
            {
                // A refresh sends it again, and forgets the refusal if Graph takes it.
                refusedTopEarlier = refresh;
                sendTop = refresh;
                if (!refresh)
                    Log(diagnostics, DiagnosticKinds.Probe, $"{table}: left out $top (Graph refused it earlier)");
            }

            while (true)
            {
                objects.Clear();
                // Once only: after one license refusal nothing more is left out for it.
                var optional = unlicensedReason is null ? Optional(fetch, select) : [];
                var filter = unfiltered ? null : Filter(clauses);
                var advanced = Advanced(fetch.Table, unfiltered ? [] : clauses, orderBy);
                var retry = await ReadPagesAsync(accountKey, fetch, new ListRequest(select, filter, limit, sendTop, orderBy, advanced), lease,
                    requests, objects, diagnostics, optional.Count > 0, unlicensedReason is not null, ct);
                if (retry is null && orderBy is not null && OutOfOrder(objects, orderBy) is { } why)
                {
                    // Graph may ignore an $orderby it doesn't support: the rows it sent aren't the first in the query's order.
                    Log(diagnostics, DiagnosticKinds.Probe, $"{table}: Graph's rows {why}; reading without $orderby");
                    if (why == NotInOrder)
                        await _probes.SetRefusedAsync(accountKey, path, OrderByClause, true, ct);
                    orderBy = null;
                    limit = null;
                    continue;
                }
                if (retry is null)
                {
                    if (refusedTopEarlier && sendTop)
                        await _probes.SetRefusesTopAsync(accountKey, path, false, ct);
                    // A refresh that read without probing found nothing in what it selected.
                    if (refresh && !probed && earlier is not null)
                        await _probes.SetAsync(accountKey, path, notListed, deniedFound, ct);
                    await KeepRefusalsAsync(accountKey, path, refusedEarlier, unfiltered ? [] : clauses, orderBy,
                        countRefused && !unfiltered && clauses.Count == fetch.FilterClauses.Count, ct);
                    return await ReadPerObjectAsync(accountKey, fetch, lease, requests,
                        new GraphCollection(objects, requests, unfiltered, unreadable)
                        {
                            Denied = denied, Unlicensed = unlicensed, UnlicensedReason = unlicensedReason,
                        }, refresh, diagnostics, ct);
                }

                if (retry.License)
                {
                    unlicensedReason = retry.Message;
                    foreach (var column in optional)
                    {
                        select.Remove(column);
                        unlicensed.Add(column);
                    }
                    Log(diagnostics, DiagnosticKinds.Probe, $"{table}: dropped {string.Join(", ", optional)} ({retry.Message})");
                }
                else if (retry.Top)
                {
                    sendTop = false;
                    Log(diagnostics, DiagnosticKinds.Probe, $"{table}: Graph refused $top; reading without it");
                    await _probes.SetRefusesTopAsync(accountKey, path, true, ct);
                }
                else if (retry.OrderBy)
                {
                    Log(diagnostics, DiagnosticKinds.Probe, $"{table}: Graph refused $orderby={orderBy!.OData}; reading without it");
                    await _probes.SetRefusedAsync(accountKey, path, OrderByClause, true, ct);
                    orderBy = null;
                    limit = null;
                }
                else if (retry.Features)
                {
                    var featured = clauses.Where(c => c.Feature is not null).ToList();
                    Log(diagnostics, DiagnosticKinds.Probe, $"{table}: Graph refused the filter; reading without "
                        + string.Join(", ", featured.Select(c => c.OData)));
                    foreach (var feature in featured.Select(c => c.Feature!).Distinct(StringComparer.Ordinal))
                        await _probes.SetRefusedAsync(accountKey, path, feature, true, ct);
                    clauses.RemoveAll(featured.Contains);
                    // Without the whole filter, the first rows (and their order) aren't the query's.
                    orderBy = null;
                    limit = null;
                }
                else if (retry.Original is { } original)
                {
                    // Once only: the same failure after leaving the found columns out is the collection's own.
                    if (probed)
                        throw original;
                    probed = true;
                    if (await FindUnreadableAsync(accountKey, fetch, [.. select.Where(c => c != "id")], requests, diagnostics, ct) is not { Count: > 0 } found)
                        throw original;
                    Log(diagnostics, DiagnosticKinds.Probe, $"{table}: dropped " + Dropped(found.NotListed, found.Denied));
                    foreach (var column in found.NotListed)
                    {
                        select.Remove(column);
                        unreadable.Add(column);
                    }
                    foreach (var column in found.Denied)
                    {
                        select.Remove(column);
                        denied.Add(column);
                    }
                    // Kept at once: the read that follows may still fail (throttled), and the next run needn't probe again.
                    notListed.AddRange(found.NotListed.Except(notListed));
                    deniedFound.AddRange(found.Denied.Except(deniedFound));
                    await _probes.SetAsync(accountKey, path, notListed, deniedFound, ct);
                }
                else if (retry.Select is { } refusedSelect)
                {
                    if (refusedSelects++ >= MaxSelectRetries)
                        throw new GraphReadException(GraphReadFailure.Failed, retry.Message);
                    select.Remove(refusedSelect);
                    unreadable.Add(refusedSelect);
                    Log(diagnostics, DiagnosticKinds.Probe, $"{table}: dropped {refusedSelect} (Graph refused it in $select)");
                }
                else
                {
                    unfiltered = true;
                    // Unfiltered, the first objects aren't the query's: its where runs locally over every one.
                    orderBy = null;
                    limit = null;
                }
            }
        }
        catch (GraphReadException ex)
        {
            throw ex.WithRequests([.. requests]);
        }
        catch (Exception ex) when (ex is HttpRequestException or IOException or TaskCanceledException or JsonException && !ct.IsCancellationRequested
            && !SignInRequiredException.IsIn(ex))
        {
            throw new GraphReadException(GraphReadFailure.Failed, "Graph didn't answer: " + ex.Message, inner: ex) { Requests = [.. requests] };
        }
    }

    /// <summary>After a read Graph took: the clauses it took that it had refused earlier (a refresh sends them again) are
    /// forgotten, and a count it refused while taking the same filter is remembered.</summary>
    private async Task KeepRefusalsAsync(string accountKey, string path, IReadOnlySet<string> refusedEarlier, List<FilterClause> sent,
        GraphOrderBy? orderBy, bool countRefused, CancellationToken ct)
    {
        foreach (var feature in sent.Select(c => c.Feature).OfType<string>().Where(refusedEarlier.Contains).Distinct(StringComparer.Ordinal))
            await _probes.SetRefusedAsync(accountKey, path, feature, false, ct);
        if (orderBy is not null && refusedEarlier.Contains(OrderByClause))
            await _probes.SetRefusedAsync(accountKey, path, OrderByClause, false, ct);
        if (countRefused)
            await _probes.SetRefusedAsync(accountKey, path, CountClause, true, ct);
    }

    private static string? Filter(IReadOnlyList<FilterClause> clauses) => clauses.Count == 0 ? null : string.Join(" and ", clauses.Select(c => c.OData));

    /// <summary>Whether a read of <paramref name="table"/> with these clauses and sort needs Graph's advanced query parameters:
    /// on directory objects, a clause that says so, or any sort (Microsoft documents most sorts there as advanced, and a sort
    /// with a filter always is).</summary>
    public static bool Advanced(Schema.GraphTable table, IReadOnlyList<FilterClause> clauses, GraphOrderBy? orderBy)
        => table.DirectoryObject && (orderBy is not null || clauses.Any(c => c.Advanced));

    private const string NotInOrder = "aren't in order";

    /// <summary>Why the objects Graph returned for a sort aren't the first in its order, or null when they are: a null (or
    /// missing) value, which KQL sorts last and Graph may not, or two objects out of order.</summary>
    private static string? OutOfOrder(List<JsonObject> objects, GraphOrderBy orderBy)
    {
        IComparable? previous = null;
        foreach (var o in objects)
        {
            if (SortValue(o[orderBy.Column]) is not { } value)
                return $"have an empty {orderBy.Column}";
            if (previous is not null && (orderBy.Descending ? value.CompareTo(previous) > 0 : value.CompareTo(previous) < 0))
                return NotInOrder;
            previous = value;
        }
        return null;
    }

    private static IComparable? SortValue(JsonNode? node)
    {
        if (node is not JsonValue value)
            return null;
        if (value.TryGetValue<string>(out var text))
            return DateTimeOffset.TryParse(text, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var instant) ? instant : null;
        return value.TryGetValue<double>(out var number) ? number : null;
    }

    /// <summary>Graph's count of the collection's objects that pass <paramref name="filter"/>: <c>/$count</c> (text) with the
    /// advanced query header on directory objects, where Microsoft documents it, else <c>$count=true</c> on a one-object page
    /// (<c>@odata.count</c>). <c>Refused</c>: Graph answered with a client error, or without a count (it ignores a <c>$count</c> it
    /// doesn't support). A permission or server error isn't a refusal: the list read that follows reports it.</summary>
    private async Task<(long? Count, bool Refused)> CountAsync(string accountKey, GraphFetch fetch, string? filter, GraphFetchLease lease,
        List<string> requests, RunDiagnostics? diagnostics, CancellationToken ct)
    {
        var table = fetch.Table.Name;
        var url = CountUrl(fetch.Table, filter);
        requests.Add(url);
        using var sent = await SendAsync(accountKey, new Uri(url, UriKind.Relative), DiagnosticKinds.Request, table, diagnostics, ct,
            advanced: fetch.Table.DirectoryObject);
        var (response, body) = (sent.Response, sent.Body);
        if (!response.IsSuccessStatusCode)
        {
            if (GraphErrorText.IsTokenRejected(response, body))
                throw SignInNeeded();
            if (response.StatusCode == HttpStatusCode.TooManyRequests)
                throw Failure(response, null);
            var refused = IsClientError(response.StatusCode) && response.StatusCode is not (HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden);
            Log(diagnostics, DiagnosticKinds.Probe, $"{table}: Graph didn't count; reading the objects", (int)response.StatusCode);
            return (null, refused);
        }
        await lease.AddAsync(body.Length, ct);
        long? count = null;
        if (fetch.Table.DirectoryObject)
        {
            if (long.TryParse(System.Text.Encoding.UTF8.GetString(body).Trim().Trim('\uFEFF'), NumberStyles.None, CultureInfo.InvariantCulture, out var n))
                count = n;
        }
        else
        {
            try
            {
                if (JsonNode.Parse(body)?["@odata.count"] is JsonValue value && value.TryGetValue<long>(out var n))
                    count = n;
            }
            catch (JsonException)
            {
                // Not a count: read the objects.
            }
        }
        if (count is null)
        {
            Log(diagnostics, DiagnosticKinds.Probe, $"{table}: Graph answered without a count; reading the objects");
            return (null, true);
        }
        Log(diagnostics, DiagnosticKinds.Request, string.Create(CultureInfo.InvariantCulture, $"{table}: Graph counted {count:N0} objects"));
        return (count, false);
    }

    /// <summary>The URL a count sends, relative to the Graph version: <c>/$count</c> on directory objects (with the advanced
    /// query header), else a one-object page with <c>$count=true</c>.</summary>
    public static string CountUrl(Schema.GraphTable table, string? filter) => table.DirectoryObject
        ? table.Path + "/$count" + (string.IsNullOrEmpty(filter) ? "" : "?$filter=" + Uri.EscapeDataString(filter))
        : table.Path + "?$select=id" + (string.IsNullOrEmpty(filter) ? "" : "&$filter=" + Uri.EscapeDataString(filter)) + "&$count=true&$top=1";

    /// <summary>The collection with the columns the query names that the list left out read one object at a time: the
    /// relationship columns by <see cref="GraphRelationshipColumns"/>, each on its own, and the properties as below.</summary>
    private async Task<GraphCollection> ReadPerObjectAsync(string accountKey, GraphFetch fetch, GraphFetchLease lease, List<string> requests,
        GraphCollection read, bool refresh, RunDiagnostics? diagnostics, CancellationToken ct)
    {
        var named = read.Unreadable.Where(fetch.Named.Contains).Distinct(StringComparer.Ordinal).ToList();
        var relationships = fetch.Table.Columns.Where(c => c.Relationship).Select(c => c.Name).ToHashSet(StringComparer.Ordinal);
        read = await ReadPropertiesAsync(accountKey, fetch, lease, requests, read, [.. named.Where(c => !relationships.Contains(c))],
            refresh, diagnostics, ct);
        var related = named.Where(relationships.Contains).ToList();
        return related.Count == 0 ? read
            : await _relationships.ReadAsync(accountKey, fetch, lease, requests, read, related, refresh, diagnostics, ct);
    }

    /// <summary>The collection with <paramref name="columns"/>, properties the list left out, read one object at a time: from the
    /// cache where it has them (unless <paramref name="refresh"/>), else from Graph, unless more objects than
    /// <see cref="GraphLimits.PerObjectReadsPerTable"/> are left to read. What Graph returned is kept in the cache; a failed read isn't.</summary>
    private async Task<GraphCollection> ReadPropertiesAsync(string accountKey, GraphFetch fetch, GraphFetchLease lease, List<string> requests,
        GraphCollection read, List<string> columns, bool refresh, RunDiagnostics? diagnostics, CancellationToken ct)
    {
        if (columns.Count == 0)
            return read;
        var path = fetch.Table.Path;
        var hits = new List<(JsonObject Target, GraphCachedValues Values)>();
        var misses = new List<JsonObject>();
        foreach (var o in read.Objects)
        {
            if (!refresh && Id(o) is { } id && await cache.GetAsync(accountKey, path, columns, id, ct) is { } cached)
                hits.Add((o, cached));
            else
                misses.Add(o);
        }
        // Over the cap nothing is merged: a column with some objects' values and not others' would read as if it were whole.
        var named = string.Join(", ", columns);
        var table = fetch.Table.Name;
        if (misses.Count > _perObject.MaxObjects)
        {
            Log(diagnostics, DiagnosticKinds.PerObject, string.Create(CultureInfo.InvariantCulture,
                $"{table}: {misses.Count:N0} objects are more than {_perObject.MaxObjects:N0} to read one at a time; {named} left empty"));
            return read with { PerObjectCapped = true };
        }
        if (hits.Count > 0)
            Log(diagnostics, DiagnosticKinds.Cache, string.Create(CultureInfo.InvariantCulture,
                $"{table}: {named} for {Objects(hits.Count)} from the cache"));

        foreach (var (target, values) in hits)
        {
            // Cached values take memory in the run as Graph's answers do.
            await lease.AddAsync(values.Json.Length, ct);
            var parsed = JsonNode.Parse(values.Json) as JsonObject;
            foreach (var column in columns)
                target[column] = parsed?[column]?.DeepClone();
        }
        var failed = 0;
        if (misses.Count > 0)
        {
            requests.Add(GraphBatchReader.Template(path, columns));
            var answered = await _perObject.ReadAsync(accountKey, path, misses, columns, lease, diagnostics, ct);
            failed = answered.Failed;
            Log(diagnostics, DiagnosticKinds.PerObject, string.Create(CultureInfo.InvariantCulture,
                $"{table}: read {named} one object at a time for {Objects(misses.Count)}, {failed:N0} failed"));
            foreach (var o in answered.Read)
            {
                var values = new JsonObject(columns.Select(c => KeyValuePair.Create(c, o[c]?.DeepClone())));
                await cache.SetAsync(accountKey, path, columns, Id(o)!, values.ToJsonString(), ct);
            }
        }
        return read with
        {
            Unreadable = [.. read.Unreadable.Where(c => !columns.Contains(c))],
            PerObject = columns,
            PerObjectFailed = failed,
            PerObjectCached = hits.Count,
            PerObjectCachedAt = hits.Count == 0 ? null : hits.Min(h => h.Values.ReadAt),
        };
    }

    /// <summary>The columns Graph lists by default for the table in this account: kept from an earlier run (unless
    /// <paramref name="refresh"/>), else read now, as the properties of the one object a list read without <c>$select</c>
    /// returns, and kept. Null when they can't be known: Graph refused the read (but for throttling or the token, which fail the
    /// read as the list would), or returned no object.</summary>
    private async Task<IReadOnlyList<string>?> DefaultColumnsAsync(string accountKey, GraphFetch fetch, bool refresh, GraphFetchLease lease,
        List<string> requests, RunDiagnostics? diagnostics, CancellationToken ct)
    {
        var path = fetch.Table.Path;
        var table = fetch.Table.Name;
        if (!refresh && await _probes.GetDefaultsAsync(accountKey, path, ct) is { } kept)
            return kept.Columns;
        var url = path + "?$top=1";
        requests.Add(url);
        using var sent = await SendAsync(accountKey, new Uri(url, UriKind.Relative), DiagnosticKinds.Probe, table, diagnostics, ct);
        var (response, body) = (sent.Response, sent.Body);
        if (!response.IsSuccessStatusCode)
        {
            if (GraphErrorText.IsTokenRejected(response, body))
                throw SignInNeeded();
            if (response.StatusCode == HttpStatusCode.TooManyRequests)
                throw Failure(response, null);
            Log(diagnostics, DiagnosticKinds.Probe, $"{table}: the columns Graph lists by default couldn't be read; selecting as before",
                (int)response.StatusCode);
            return null;
        }
        await lease.AddAsync(body.Length, ct);
        JsonNode? root;
        try
        {
            root = JsonNode.Parse(body);
        }
        catch (JsonException)
        {
            root = null;
        }
        // Annotations (@odata.type, tags@odata.type) aren't columns.
        var columns = root?["value"] is JsonArray { Count: > 0 } value && value[0] is JsonObject first
            ? first.Select(p => p.Key).Where(k => !k.Contains('@', StringComparison.Ordinal)).ToList()
            : [];
        if (columns.Count == 0)
        {
            Log(diagnostics, DiagnosticKinds.Probe, $"{table}: no object to learn the columns Graph lists by default from; selecting as before");
            return null;
        }
        await _probes.SetDefaultsAsync(accountKey, path, columns, ct);
        Log(diagnostics, DiagnosticKinds.Probe, string.Create(CultureInfo.InvariantCulture,
            $"{table}: Graph lists {columns.Count} columns by default: {string.Join(", ", columns)}"));
        return columns;
    }

    /// <summary>Leaves the selected columns probing found <paramref name="earlier"/> out of <paramref name="select"/>, as probing
    /// would have, and returns them with why, for the log ("" when none was selected).</summary>
    private static string LeaveOut(List<string> select, GraphProbeFindings earlier, List<string> unreadable, List<string> denied)
    {
        var notListed = earlier.NotListed.Where(select.Contains).ToList();
        var refused = earlier.Denied.Where(select.Contains).ToList();
        foreach (var column in notListed)
        {
            select.Remove(column);
            unreadable.Add(column);
        }
        foreach (var column in refused)
        {
            select.Remove(column);
            denied.Add(column);
        }
        return Dropped(notListed, refused);
    }

    private static string Dropped(IEnumerable<string> notListed, IEnumerable<string> denied) => string.Join(", ",
        notListed.Select(c => c + " (Graph won't serve it in a list)").Concat(denied.Select(c => c + " (Graph refused it for permission)")));

    /// <summary>The selected columns a license or feature refusal may leave out: those Graph returns only on <c>$select</c>
    /// (every license-gated property is one) that the query doesn't name.</summary>
    private static List<string> Optional(GraphFetch fetch, List<string> select)
    {
        var selectOnly = fetch.Table.Columns.Where(c => c.SelectOnly).Select(c => c.Name).ToHashSet(StringComparer.Ordinal);
        return [.. select.Where(c => c != "id" && selectOnly.Contains(c) && !fetch.Named.Contains(c))];
    }

    private static string Objects(int count)
        => count.ToString("N0", CultureInfo.InvariantCulture) + (count == 1 ? " object" : " objects");

    /// <summary>Adds a step of the read, with no request of its own, to the run's log.</summary>
    private static void Log(RunDiagnostics? diagnostics, string kind, string detail, int? status = null)
        => diagnostics?.Add(new DiagnosticEntry(diagnostics.NowMs, kind, detail, status, null, null));

    private static string? Id(JsonObject o) => o["id"] is JsonValue v && v.TryGetValue<string>(out var id) ? id : null;

    /// <summary>The first page's URL relative to the Graph version, as a list read sends it: the <c>$select</c>, the
    /// <c>$filter</c> when there is one, and the page size, or the row limit <paramref name="top"/> when that is smaller.</summary>
    public static string FirstPageUrl(string path, IReadOnlyList<string> select, string? filter, int? top = null) =>
        ListUrl(path, select, filter, Math.Min(top ?? PageSize, PageSize), null, false);

    /// <summary>The first URL a read of <paramref name="fetch"/> sends, relative to the Graph version: its count
    /// (<see cref="CountUrl"/>) when it is one, else its first page, with the sort and the advanced query parameters when they
    /// are sent. Explain shows the same URL (<see cref="GraphExplain"/>).</summary>
    public static string FirstPageUrl(GraphFetch fetch)
    {
        var clauses = fetch.FilterClauses;
        var filter = Filter(clauses);
        if (fetch.Count is not null)
            return CountUrl(fetch.Table, filter);
        return ListUrl(fetch.Table.Path, fetch.Select, filter, Math.Min(fetch.Top ?? PageSize, PageSize), fetch.OrderBy,
            Advanced(fetch.Table, clauses, fetch.OrderBy));
    }

    /// <summary>A list read's first URL, with <c>$top</c> only when <paramref name="top"/> is given, and <c>$count=true</c> for
    /// advanced query mode.</summary>
    private static string ListUrl(string path, IReadOnlyList<string> select, string? filter, int? top, GraphOrderBy? orderBy, bool advanced) =>
        path + "?$select=" + Uri.EscapeDataString(string.Join(",", select))
            + (string.IsNullOrEmpty(filter) ? "" : "&$filter=" + Uri.EscapeDataString(filter))
            + (orderBy is null ? "" : "&$orderby=" + Uri.EscapeDataString(orderBy.OData))
            + (advanced ? "&$count=true" : "")
            + (top is { } t ? "&$top=" + t.ToString(CultureInfo.InvariantCulture) : "");

    /// <summary>What one run through the pages asks for: the row limit (<paramref name="Limit"/>), whether to send it as
    /// <c>$top</c>, the sort, and whether in advanced query mode.</summary>
    private sealed record ListRequest(List<string> Select, string? Filter, int? Limit, bool SendTop, GraphOrderBy? OrderBy, bool Advanced);

    /// <summary>One run through the pages. Returns null when done, or what to change when Graph refused the first page. A refusal
    /// for a license or feature the tenant lacks asks to leave the optional columns out when <paramref name="canLeaveOut"/>, and
    /// fails the read when they already were (<paramref name="leftOut"/>); otherwise it is handled as any other. With a row
    /// limit, stops once that many objects have arrived (keeping no more) and asks for no more as <c>$top</c>; without
    /// <see cref="ListRequest.SendTop"/> no <c>$top</c> is sent at all, and a refusal naming <c>$top</c> asks to read without it.
    /// A 400 with a sort asks to read without the sort, then one with filter clauses that have a feature without those.</summary>
    private async Task<Retry?> ReadPagesAsync(string accountKey, GraphFetch fetch, ListRequest list, GraphFetchLease lease,
        List<string> requests, List<JsonObject> objects, RunDiagnostics? diagnostics, bool canLeaveOut, bool leftOut, CancellationToken ct)
    {
        var (select, filter, limit, sendTop) = (list.Select, list.Filter, list.Limit, list.SendTop);
        int? top = sendTop ? Math.Min(limit ?? PageSize, PageSize) : null;
        Uri? next = new(ListUrl(fetch.Table.Path, select, filter, top, list.OrderBy, list.Advanced), UriKind.Relative);
        for (var page = 0; next is not null; page++)
        {
            requests.Add(Relative(next));
            using var sent = await SendAsync(accountKey, next, DiagnosticKinds.Request, fetch.Table.Name, diagnostics, ct, list.Advanced);
            var (response, body) = (sent.Response, sent.Body);

            if (!response.IsSuccessStatusCode)
            {
                // A 401 that rejects the token itself (not a permission) means sign in again.
                if (GraphErrorText.IsTokenRejected(response, body))
                    throw SignInNeeded();
                var raw = GraphErrorText.Extract(body);
                var message = raw is null ? null : GraphErrorText.Describe((int)response.StatusCode, raw);
                if (page == 0 && GraphErrorText.IsLicenseRefusal(body))
                {
                    if (canLeaveOut)
                        return new Retry(null, message ?? "", License: true);
                    if (leftOut)
                        throw Failure(response, message);
                }
                // A web page for a 404 means a backend behind Graph couldn't serve some selected property, and a 401 or 403 may
                // be one property's permission rather than the table's: probe to find which, if any.
                if (page == 0 && select.Any(c => c != "id")
                    && (response.StatusCode == HttpStatusCode.NotFound && GraphErrorText.IsHtml(raw)
                        || response.StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden))
                    return new Retry(null, message ?? "", Failure(response, message));
                // Checked before the filter: a refused $top would otherwise cost the filter.
                if (page == 0 && sendTop && response.StatusCode == HttpStatusCode.BadRequest && NamesTop(message))
                    return new Retry(null, message ?? "", Top: true);
                // A sort or a clause with a feature (or the advanced query mode they need) is what this change sends that a
                // table may refuse: left out first, before the whole filter.
                if (page == 0 && response.StatusCode == HttpStatusCode.BadRequest && list.OrderBy is not null)
                    return new Retry(null, message ?? "", OrderBy: true);
                if (page == 0 && response.StatusCode == HttpStatusCode.BadRequest && filter is not null
                    && Featured(filter, fetch))
                    return new Retry(null, message ?? "", Features: true);
                if (page == 0 && response.StatusCode == HttpStatusCode.BadRequest)
                {
                    // A refused filter names its property too (often a selected one), so while there is a filter a 400 is
                    // the filter's: it is dropped first. Only a 400 without one can be a refused $select.
                    if (filter is not null)
                        return new Retry(null, message ?? "");
                    if (RefusedSelect(message, select) is { } property)
                        return new Retry(property, message ?? "");
                }
                // Any other client error on the first page may be one selected property's: probe to find it, if any.
                if (page == 0 && select.Any(c => c != "id") && IsClientError(response.StatusCode))
                    return new Retry(null, message ?? "", Failure(response, message));
                throw Failure(response, message);
            }

            await lease.AddAsync(body.Length, ct);
            var root = JsonNode.Parse(body) as JsonObject;
            if (root?["value"] is JsonArray value)
                objects.AddRange(value.OfType<JsonObject>());
            if (limit is { } most && objects.Count >= most)
            {
                // Graph may send more than $top asked for: the query takes no more.
                objects.RemoveRange(most, objects.Count - most);
                if (root?["@odata.nextLink"] is not null)
                    Log(diagnostics, DiagnosticKinds.Request, string.Create(CultureInfo.InvariantCulture,
                        $"{fetch.Table.Name}: stopped after {most:N0} objects (the query takes {most:N0})"));
                return null;
            }
            if (objects.Count > limits.ObjectsPerTable)
                throw new GraphReadException(GraphReadFailure.TooManyObjects, string.Create(CultureInfo.InvariantCulture,
                    $"{fetch.Table.Name} has more than {limits.ObjectsPerTable:N0} objects. Add a `where` Graph can filter on (see the schema list)."));

            // The account's token goes with every request: a next link is only followed back to Graph itself.
            var linkNode = root?["@odata.nextLink"];
            string? link = null;
            if (linkNode is not null && !(linkNode is JsonValue linkValue && linkValue.TryGetValue(out link)))
                throw new GraphReadException(GraphReadFailure.Failed, "Graph sent a next link that isn't text");
            if (link is null)
                return null;
            // A link anywhere else is never followed (the token would go with it), and stopping there would pass the pages
            // read so far off as the whole collection: the read fails instead.
            if (!Uri.TryCreate(link, UriKind.Absolute, out var uri) || uri.Scheme != Uri.UriSchemeHttps
                || !string.Equals(uri.Host, GraphHost, StringComparison.OrdinalIgnoreCase))
                throw new GraphReadException(GraphReadFailure.Failed,
                    "Graph returned a next page link to another host; the results would be incomplete.");
            next = uri;
        }
        return null;
    }

    private string Relative(Uri uri)
    {
        if (!uri.IsAbsoluteUri)
            return uri.OriginalString;
        var text = uri.AbsoluteUri;
        var baseText = http.BaseAddress!.AbsoluteUri;
        return text.StartsWith(baseText, StringComparison.Ordinal) ? text[baseText.Length..] : text;
    }

    /// <summary>The property a 400 refuses: the first quoted name in Graph's message that is one of the selected properties.</summary>
    private static string? RefusedSelect(string? message, List<string> select)
    {
        if (message is null)
            return null;
        for (var open = message.IndexOf('\''); open >= 0; )
        {
            var close = message.IndexOf('\'', open + 1);
            if (close < 0)
                return null;
            var quoted = message[(open + 1)..close];
            if (select.FirstOrDefault(s => s != "id" && string.Equals(s, quoted, StringComparison.OrdinalIgnoreCase)) is { } name)
                return name;
            open = message.IndexOf('\'', close + 1);
        }
        return null;
    }

    /// <summary>A GET of <paramref name="url"/>, with Graph's answer read. A 429 is logged as throttled, waited for (its
    /// <c>Retry-After</c>, at most <see cref="MaxRetryWait"/>) and sent once more, logged as a retry; the answer to that is
    /// returned whatever it is (a second 429 logged as throttled too).</summary>
    private async Task<Sent> SendAsync(string accountKey, Uri url, string kind, string table, RunDiagnostics? diagnostics, CancellationToken ct,
        bool advanced = false)
    {
        for (var retried = false; ; retried = true)
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, url).ForAccount(accountKey).ForRun(diagnostics, kind);
            // Graph's advanced query mode on directory objects (with $count=true in the URL).
            if (advanced)
                request.Headers.Add(ConsistencyLevel, "eventual");
            var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);
            try
            {
                var body = await response.Content.ReadAsByteArrayAsync(ct);
                request.RecordBytes(body.Length);
                if (response.StatusCode != HttpStatusCode.TooManyRequests)
                    return new Sent(response, body);
                var asked = response.Headers.RetryAfter?.Delta;
                Log(diagnostics, DiagnosticKinds.Throttled, table + ": Graph is throttling; " + (asked is { } after
                    ? string.Create(CultureInfo.InvariantCulture, $"Retry-After {(long)after.TotalSeconds} s")
                    : "no Retry-After"), (int)response.StatusCode);
                if (retried)
                    return new Sent(response, body);
                var wait = asked ?? NoRetryAfterWait;
                wait = wait < TimeSpan.Zero ? TimeSpan.Zero : wait > MaxRetryWait ? MaxRetryWait : wait;
                response.Dispose();
                await Task.Delay(wait, _time, ct);
                Log(diagnostics, DiagnosticKinds.Retry, string.Create(CultureInfo.InvariantCulture,
                    $"{table}: sent the request again after {(long)wait.TotalSeconds} s"));
            }
            catch
            {
                response.Dispose();
                throw;
            }
        }
    }

    /// <summary>Graph's answer to a request, its body read.</summary>
    private sealed record Sent(HttpResponseMessage Response, byte[] Body) : IDisposable
    {
        public void Dispose() => Response.Dispose();
    }

    private static GraphReadException SignInNeeded() => new(GraphReadFailure.SignInNeeded, GraphErrorText.SignInMessage);

    private static GraphReadException Failure(HttpResponseMessage response, string? message)
    {
        var status = (int)response.StatusCode;
        return response.StatusCode switch
        {
            HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden
                => new(GraphReadFailure.NoPermission, message ?? "Graph refused the request (" + status + ")"),
            HttpStatusCode.TooManyRequests
                => new(GraphReadFailure.Throttled, "Graph is throttling requests, try again later",
                    (int?)response.Headers.RetryAfter?.Delta?.TotalSeconds ?? DefaultRetryAfterSeconds),
            HttpStatusCode.NotFound => new(GraphReadFailure.NotFound, message ?? "Graph didn't find this collection"),
            _ when status >= 500 => new(GraphReadFailure.Failed, "Graph didn't answer (" + status + ")"),
            _ => new(GraphReadFailure.Failed, message ?? "Graph didn't answer (" + status + ")"),
        };
    }

    /// <summary>What to change after Graph refused the first page. <see cref="Original"/> set: probe the selected columns, and
    /// throw it if probing finds none.
    /// <see cref="License"/> set: leave the optional columns out.
    /// <see cref="Top"/> set: read without <c>$top</c>.
    /// <see cref="OrderBy"/> set: read without the sort. <see cref="Features"/> set: read without the filter clauses that have a
    /// feature.</summary>
    private sealed record Retry(string? Select, string Message, GraphReadException? Original = null, bool License = false, bool Top = false,
        bool OrderBy = false, bool Features = false);

    /// <summary>The header that, with <c>$count=true</c>, asks for Graph's advanced query mode on directory objects.</summary>
    public const string ConsistencyLevel = "ConsistencyLevel";

    /// <summary>Whether <paramref name="filter"/> has a clause of the fetch's with a feature.</summary>
    private static bool Featured(string filter, GraphFetch fetch)
        => fetch.FilterClauses.Any(c => c.Feature is not null && filter.Contains(c.OData, StringComparison.Ordinal));

    /// <summary>Whether Graph's message for a 400 is about <c>$top</c>: it names <c>$top</c>, or OData's query option <c>'Top'</c>.</summary>
    private static bool NamesTop(string? message) => message is not null
        && (message.Contains("$top", StringComparison.OrdinalIgnoreCase) || message.Contains("'Top'", StringComparison.OrdinalIgnoreCase));

    /// <summary>A 4xx that isn't throttling: Graph refusing what was asked, not being unable to answer.</summary>
    private static bool IsClientError(HttpStatusCode status) => (int)status is >= 400 and < 500 && status != HttpStatusCode.TooManyRequests;

    /// <summary>
    /// The selected columns a backend can't serve in a list in this account: halves of the $select are probed (<c>$top=1</c>,
    /// no filter) until each failing half is down to one column. Null when <c>id</c> alone fails (the collection itself does)
    /// or the probes run out (<see cref="MaxProbes"/>). Every probe is recorded with the requests.
    /// </summary>
    private async Task<Probed?> FindUnreadableAsync(string accountKey, GraphFetch fetch, List<string> columns, List<string> requests,
        RunDiagnostics? diagnostics, CancellationToken ct)
    {
        var probes = 0;
        async Task<ProbeAnswer> ReadsAsync(IReadOnlyList<string> group)
        {
            if (probes++ >= MaxProbes)
                return ProbeAnswer.OutOfProbes;
            var url = fetch.Table.Path + "?$select=" + Uri.EscapeDataString(string.Join(",", group.Prepend("id"))) + "&$top=1";
            requests.Add(url);
            using var sent = await SendAsync(accountKey, new Uri(url, UriKind.Relative), DiagnosticKinds.Probe, fetch.Table.Name, diagnostics, ct);
            var (response, body) = (sent.Response, sent.Body);
            if (response.IsSuccessStatusCode)
                return ProbeAnswer.Reads;
            // The token is refused, not a column: sign in again.
            if (GraphErrorText.IsTokenRejected(response, body))
                throw SignInNeeded();
            var raw = GraphErrorText.Extract(body);
            // With id alone refused, the table itself is: that is the answer, not a column's.
            // Graph answers a property it won't serve in many ways (a 404 web page, a 400 "Invalid object identifier", a 401):
            // any client error marks the group, and a single column's own answer says whether it is permission.
            if (group.Count > 0 && response.StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden)
                return ProbeAnswer.Denied;
            if (group.Count > 0 && IsClientError(response.StatusCode))
                return ProbeAnswer.NotListed;
            throw Failure(response, raw is null ? null : GraphErrorText.Describe((int)response.StatusCode, raw));
        }

        if (await ReadsAsync([]) is not ProbeAnswer.Reads)
            return null;
        var probed = new Probed([], []);
        var groups = new Stack<List<string>>();
        void Split(List<string> group)
        {
            groups.Push(group[(group.Count / 2)..]);
            groups.Push(group[..(group.Count / 2)]);
        }
        Split(columns);
        while (groups.TryPop(out var group))
        {
            switch (await ReadsAsync(group))
            {
                case ProbeAnswer.OutOfProbes:
                    return null;
                case ProbeAnswer.Reads:
                    continue;
                case ProbeAnswer.NotListed when group.Count == 1:
                    probed.NotListed.Add(group[0]);
                    break;
                case ProbeAnswer.Denied when group.Count == 1:
                    probed.Denied.Add(group[0]);
                    break;
                default:
                    Split(group);
                    break;
            }
        }
        return probed;
    }

    private enum ProbeAnswer { Reads, NotListed, Denied, OutOfProbes }

    /// <summary>What probing found: columns a backend won't serve in a list, and columns Graph refuses for permission.</summary>
    private sealed record Probed(List<string> NotListed, List<string> Denied)
    {
        public int Count => NotListed.Count + Denied.Count;
    }
}
