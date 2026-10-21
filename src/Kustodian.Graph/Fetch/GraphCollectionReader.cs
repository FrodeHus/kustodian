using System.Globalization;
using System.Net;
using System.Text.Json;
using System.Text.Json.Nodes;
using Kustodian.Graph.Query;

namespace Kustodian.Graph.Fetch;

/// <summary>What one collection read returned. <c>Requests</c> are the relative URLs as sent (the per-object reads once, as
/// <see cref="GraphBatchReader.Template"/>); <c>Unfiltered</c> says Graph refused the <c>$filter</c> and the whole collection
/// was read; <c>Unreadable</c> are the properties Graph won't serve in a list and that are missing from the objects.
/// <see cref="PerObject"/> are such properties read one object at a time instead, <see cref="PerObjectFailed"/> the objects
/// whose read failed (their values are empty), and <see cref="PerObjectCapped"/> says the collection had more objects than
/// <see cref="GraphBatchReader.MaxObjects"/> to read, so its named properties stayed unread. <see cref="PerObjectCached"/> are
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
}

/// <summary>
/// Reads one Graph collection for the signed-in account, page by page, within the object and byte budgets. The HttpClient's
/// handler adds the account's token. The
/// properties the query names that Graph won't serve in a list are then read one object at a time
/// (<see cref="GraphBatchReader"/>), for at most <see cref="GraphBatchReader.MaxObjects"/> objects: those whose values are in
/// <paramref name="cache"/> take them from there, and only the others are read and then kept.
/// </summary>
public sealed class GraphCollectionReader(HttpClient http, GraphFetchBudget budget, IGraphObjectCache cache)
{
    public const int MaxObjects = 50_000;
    public const int MaxSelectRetries = 5;
    /// <summary>Probes spent finding the columns a backend can't serve in a list (one for <c>id</c> alone, then halves).</summary>
    public const int MaxProbes = 16;
    private const string GraphHost = "graph.microsoft.com";
    private const int PageSize = 999;
    private const int DefaultRetryAfterSeconds = 60;

    /// <summary>A lease on this reader's process budget, for the reads of one run.</summary>
    public GraphFetchLease Lease() => budget.Lease();

    /// <summary>Reads the collection. <paramref name="accountKey"/> keys the cache. <paramref name="refresh"/>: per-object reads skip the cache (and refill it). Throws
    /// <see cref="GraphReadException"/> for every failure that isn't the caller cancelling.</summary>
    public async Task<GraphCollection> ReadAsync(string accountKey, GraphFetch fetch, GraphFetchLease lease, bool refresh,
        CancellationToken ct)
    {
        var select = fetch.Select.ToList();
        var filter = fetch.Filter;
        // The plan's unreadable columns (never selected in a list) first, then those Graph refuses.
        var unreadable = new List<string>(fetch.Unreadable);
        var refusedSelects = 0;
        var probed = false;
        var denied = new List<string>();
        var requests = new List<string>();
        var objects = new List<JsonObject>();
        var unfiltered = false;

        try
        {
            while (true)
            {
                objects.Clear();
                var retry = await ReadPagesAsync(fetch, select, filter, lease, requests, objects, ct);
                if (retry is null)
                    return await ReadPerObjectAsync(accountKey, fetch, lease, requests,
                        new GraphCollection(objects, requests, unfiltered, unreadable) { Denied = denied }, refresh, ct);

                if (retry.Original is { } original)
                {
                    // Once only: the same failure after leaving the found columns out is the collection's own.
                    if (probed)
                        throw original;
                    probed = true;
                    if (await FindUnreadableAsync(fetch, [.. select.Where(c => c != "id")], requests, ct) is not { Count: > 0 } found)
                        throw original;
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
                }
                else if (retry.Select is { } refused)
                {
                    if (refusedSelects++ >= MaxSelectRetries)
                        throw new GraphReadException(GraphReadFailure.Failed, retry.Message);
                    select.Remove(refused);
                    unreadable.Add(refused);
                }
                else
                {
                    filter = null;
                    unfiltered = true;
                }
            }
        }
        catch (GraphReadException ex)
        {
            throw ex.WithRequests([.. requests]);
        }
        catch (Exception ex) when (ex is HttpRequestException or IOException or TaskCanceledException or JsonException && !ct.IsCancellationRequested)
        {
            throw new GraphReadException(GraphReadFailure.Failed, "Graph didn't answer: " + ex.Message, inner: ex) { Requests = [.. requests] };
        }
    }

    /// <summary>The collection with the properties the query names that the list left out read one object at a time: from the
    /// cache where it has them (unless <paramref name="refresh"/>), else from Graph, unless more objects than
    /// <see cref="GraphBatchReader.MaxObjects"/> are left to read. What Graph returned is kept in the cache; a failed read isn't.</summary>
    private async Task<GraphCollection> ReadPerObjectAsync(string accountKey, GraphFetch fetch, GraphFetchLease lease, List<string> requests,
        GraphCollection read, bool refresh, CancellationToken ct)
    {
        var columns = read.Unreadable.Where(fetch.Named.Contains).Distinct(StringComparer.Ordinal).ToList();
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
        if (misses.Count > GraphBatchReader.MaxObjects)
            return read with { PerObjectCapped = true };

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
            var answered = await new GraphBatchReader(http).ReadAsync(path, misses, columns, lease, ct);
            failed = answered.Failed;
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

    private static string? Id(JsonObject o) => o["id"] is JsonValue v && v.TryGetValue<string>(out var id) ? id : null;

    /// <summary>One run through the pages. Returns null when done, or what to change when Graph refused the first page.</summary>
    private async Task<Retry?> ReadPagesAsync(GraphFetch fetch, List<string> select, string? filter,
        GraphFetchLease lease, List<string> requests, List<JsonObject> objects, CancellationToken ct)
    {
        var url = fetch.Table.Path + "?$select=" + Uri.EscapeDataString(string.Join(",", select))
            + (string.IsNullOrEmpty(filter) ? "" : "&$filter=" + Uri.EscapeDataString(filter))
            + "&$top=" + PageSize.ToString(CultureInfo.InvariantCulture);
        Uri? next = new(url, UriKind.Relative);
        for (var page = 0; next is not null; page++)
        {
            requests.Add(Relative(next));
            using var request = new HttpRequestMessage(HttpMethod.Get, next);
            using var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);
            var body = await response.Content.ReadAsByteArrayAsync(ct);

            if (!response.IsSuccessStatusCode)
            {
                // A 401 that rejects the token itself (not a permission) means sign in again.
                if (GraphErrorText.IsTokenRejected(response, body))
                    throw SignInNeeded();
                var raw = GraphErrorText.Extract(body);
                var message = raw is null ? null : GraphErrorText.Describe((int)response.StatusCode, raw);
                // A web page for a 404 means a backend behind Graph couldn't serve some selected property, and a 401 or 403 may
                // be one property's permission rather than the table's: probe to find which, if any.
                if (page == 0 && select.Any(c => c != "id")
                    && (response.StatusCode == HttpStatusCode.NotFound && GraphErrorText.IsHtml(raw)
                        || response.StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden))
                    return new Retry(null, message ?? "", Failure(response, message));
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
            if (objects.Count > MaxObjects)
                throw new GraphReadException(GraphReadFailure.TooLarge,
                    $"{fetch.Table.Name} has more than 50,000 objects. Add a `where` Graph can filter on (see the schema list).");

            // The account's token goes with every request: a next link is only followed back to Graph itself.
            var linkNode = root?["@odata.nextLink"];
            string? link = null;
            if (linkNode is not null && !(linkNode is JsonValue linkValue && linkValue.TryGetValue(out link)))
                throw new GraphReadException(GraphReadFailure.Failed, "Graph sent a next link that isn't text");
            next = link is not null && Uri.TryCreate(link, UriKind.Absolute, out var uri)
                && uri.Scheme == Uri.UriSchemeHttps && string.Equals(uri.Host, GraphHost, StringComparison.OrdinalIgnoreCase)
                ? uri
                : null;
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
    /// throw it if probing finds none.</summary>
    private sealed record Retry(string? Select, string Message, GraphReadException? Original = null);

    /// <summary>A 4xx that isn't throttling: Graph refusing what was asked, not being unable to answer.</summary>
    private static bool IsClientError(HttpStatusCode status) => (int)status is >= 400 and < 500 && status != HttpStatusCode.TooManyRequests;

    /// <summary>
    /// The selected columns a backend can't serve in a list in this account: halves of the $select are probed (<c>$top=1</c>,
    /// no filter) until each failing half is down to one column. Null when <c>id</c> alone fails (the collection itself does)
    /// or the probes run out (<see cref="MaxProbes"/>). Every probe is recorded with the requests.
    /// </summary>
    private async Task<Probed?> FindUnreadableAsync(GraphFetch fetch, List<string> columns, List<string> requests,
        CancellationToken ct)
    {
        var probes = 0;
        async Task<ProbeAnswer> ReadsAsync(IReadOnlyList<string> group)
        {
            if (probes++ >= MaxProbes)
                return ProbeAnswer.OutOfProbes;
            var url = fetch.Table.Path + "?$select=" + Uri.EscapeDataString(string.Join(",", group.Prepend("id"))) + "&$top=1";
            requests.Add(url);
            using var request = new HttpRequestMessage(HttpMethod.Get, new Uri(url, UriKind.Relative));
            using var response = await http.SendAsync(request, ct);
            if (response.IsSuccessStatusCode)
                return ProbeAnswer.Reads;
            var body = await response.Content.ReadAsByteArrayAsync(ct);
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
