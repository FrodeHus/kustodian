using System.Net;
using System.Text.Json;
using System.Text.Json.Nodes;
using Kustodian.Graph.Run;
using Kustodian.Graph.Schema;

namespace Kustodian.Graph.Fetch;

/// <summary>What reading one relationship for a set of objects gave: the value of each object that was read (an array of
/// <c>kustodian.directoryObjectRef</c> entries for a collection; one entry, or null when there is none, for a single
/// relationship), the objects whose collection was cut off at the entry cap, and how many objects Graph refused (401/403)
/// or couldn't be read.</summary>
public sealed record GraphRelationshipRead(
    IReadOnlyDictionary<string, JsonNode?> Values,
    IReadOnlyList<string> Truncated,
    int Refused,
    int Failed);

/// <summary>
/// Reads one relationship (<c>memberOf</c>, <c>manager</c>, ...) of each object: <c>GET /{path}/{id}/{relationship}</c> sent
/// through <c>POST /$batch</c> like <see cref="GraphBatchReader"/> (same batch size and batches in flight; <see cref="GraphBatchSender"/>
/// retries a throttled item once). A collection is read with <c>$top=999</c>; an object whose read Graph refuses for the page size
/// (<c>directoryRoles</c> members) is read once more without it. A collection's next pages are plain GETs, followed only to https on graph.microsoft.com, until the object
/// has <see cref="GraphLimits.RelationshipEntriesPerObject"/> entries. Every body counts against the lease.
/// </summary>
public sealed class GraphRelationshipReader(HttpClient http, GraphLimits limits)
{
    private const string GraphHost = "graph.microsoft.com";
    private const string TypePrefix = "#microsoft.graph.";
    private const string Select = "$select=id,displayName,userPrincipalName,mail,appId,deviceId";
    private static readonly string[] ShapeFields = ["displayName", "userPrincipalName", "mail", "appId", "deviceId"];

    /// <summary>The relative URL of one object's read, with <c>{id}</c> for the id: what the fetch info shows.</summary>
    public static string Template(string path, string relationship, bool collection)
        => path + "/{id}/" + relationship + "?" + Select + (collection ? TopPart : "");

    private const string TopPart = "&$top=999";

    private static string Url(string path, GraphColumn relationship, string id)
        => "/" + Template(path, relationship.Name, relationship.Collection).Replace("{id}", Uri.EscapeDataString(id), StringComparison.Ordinal);

    /// <summary>A directory object as a <c>kustodian.directoryObjectRef</c>: <c>id</c>, <c>objectType</c> (the <c>@odata.type</c>
    /// without its prefix), then the shape fields the object has. Anything else is dropped; an explicit null is kept.</summary>
    public static JsonObject Entry(JsonObject graphObject)
    {
        var entry = new JsonObject();
        if (graphObject.TryGetPropertyValue("id", out var id))
            entry["id"] = id?.DeepClone();
        if (graphObject["@odata.type"] is JsonValue type && type.TryGetValue<string>(out var typeName))
            entry["objectType"] = typeName.StartsWith(TypePrefix, StringComparison.Ordinal) ? typeName[TypePrefix.Length..] : typeName;
        foreach (var field in ShapeFields)
            if (graphObject.TryGetPropertyValue(field, out var value))
                entry[field] = value?.DeepClone();
        return entry;
    }

    private enum Outcome { Read, Missing, Refused, Failed }

    private sealed record Item(string Id, Outcome Outcome, JsonNode? Value = null, bool Truncated = false);

    /// <summary>Reads <paramref name="relationship"/> of every object in <paramref name="objects"/> (by its <c>id</c>). The
    /// answers count against <paramref name="lease"/>. A follow-up page is a plain GET, not retried: a throttled (429) or
    /// otherwise failed follow-up page fails that object.</summary>
    public async Task<GraphRelationshipRead> ReadAsync(string accountKey, string path, GraphColumn relationship,
        IReadOnlyList<JsonObject> objects, GraphFetchLease lease, RunDiagnostics? diagnostics, CancellationToken ct)
    {
        var ids = objects.Select(o => o["id"] is JsonValue v && v.TryGetValue<string>(out var id) ? id : null).ToList();
        var values = new Dictionary<string, JsonNode?>();
        var truncated = new List<string>();
        var refused = 0;
        var failed = ids.Count(id => id is null);
        var gate = new Lock();

        void Record(IEnumerable<Item> items)
        {
            lock (gate)
                foreach (var item in items)
                    switch (item.Outcome)
                    {
                        case Outcome.Read:
                            values[item.Id] = item.Value;
                            if (item.Truncated)
                                truncated.Add(item.Id);
                            break;
                        case Outcome.Missing:
                            values[item.Id] = null;
                            break;
                        case Outcome.Refused:
                            refused++;
                            break;
                        default:
                            failed++;
                            break;
                    }
        }

        var options = new ParallelOptions { MaxDegreeOfParallelism = GraphBatchReader.BatchesInFlight, CancellationToken = ct };
        var chunks = ids.OfType<string>().Distinct(StringComparer.Ordinal).Chunk(GraphBatchReader.BatchSize);
        await Parallel.ForEachAsync(chunks, options, async (chunk, token) =>
        {
            var urls = chunk.Select(id => Url(path, relationship, id)).ToList();
            var answers = await GraphBatchSender.SendAsync(http, accountKey, path, urls, lease, diagnostics, token);
            // A relationship that refuses a page size ($top) is read again without one.
            var refusedTop = relationship.Collection
                ? Enumerable.Range(0, chunk.Length).Where(i => answers[i].Status == (int)HttpStatusCode.BadRequest
                    && GraphErrorText.NamesTop(GraphErrorText.Extract(answers[i].Body?.ToJsonString()))).ToArray()
                : [];
            if (refusedTop.Length > 0)
            {
                var again = await GraphBatchSender.SendAsync(http, accountKey, path,
                    [.. refusedTop.Select(i => Url(path, relationship, chunk[i]).Replace(TopPart, "", StringComparison.Ordinal))],
                    lease, diagnostics, token);
                for (var j = 0; j < refusedTop.Length; j++)
                    answers[refusedTop[j]] = again[j];
            }
            // A chunk's follow-up pages are fetched one object at a time; the object cap
            // (GraphLimits.RelationshipObjectsPerTable) bounds how many there can be.
            for (var i = 0; i < chunk.Length; i++)
            {
                var answer = answers[i];
                if (answer.Succeeded)
                    Record([await ReadValueAsync(accountKey, chunk[i], relationship, answer.Body, lease, diagnostics, token)]);
                else if (answer.Status is 401 or 403)
                    Record([new Item(chunk[i], Outcome.Refused)]);
                else if (answer.Status == (int)HttpStatusCode.NotFound && !relationship.Collection)
                    Record([new Item(chunk[i], Outcome.Missing)]);
                else
                    Record([new Item(chunk[i], Outcome.Failed)]);
            }
        });
        return new GraphRelationshipRead(values, truncated, refused, failed);
    }

    /// <summary>The value of a successful first answer: a single relationship's object, or a collection's pages followed up to
    /// the entry cap.</summary>
    private async Task<Item> ReadValueAsync(string accountKey, string id, GraphColumn relationship, JsonObject? page,
        GraphFetchLease lease, RunDiagnostics? diagnostics, CancellationToken ct)
    {
        if (page is null)
            return new Item(id, Outcome.Failed);
        if (!relationship.Collection)
            return new Item(id, Outcome.Read, Entry(page));

        var cap = limits.RelationshipEntriesPerObject;
        var entries = new List<JsonNode?>();
        while (true)
        {
            if (page["value"] is not JsonArray values)
                return new Item(id, Outcome.Failed);
            entries.AddRange(values.OfType<JsonObject>().Select(o => (JsonNode)Entry(o)));

            var linkNode = page["@odata.nextLink"];
            string? link = null;
            if (linkNode is not null && !(linkNode is JsonValue v && v.TryGetValue(out link)))
                return new Item(id, Outcome.Failed);
            if (entries.Count >= cap)
            {
                var cut = entries.Count > cap || link is not null;
                entries.RemoveRange(cap, entries.Count - cap);
                return new Item(id, Outcome.Read, new JsonArray([.. entries]), cut);
            }
            if (link is null)
                return new Item(id, Outcome.Read, new JsonArray([.. entries]));
            // The account's token goes with every request: a link anywhere else is never followed.
            if (!Uri.TryCreate(link, UriKind.Absolute, out var uri) || uri.Scheme != Uri.UriSchemeHttps
                || !string.Equals(uri.Host, GraphHost, StringComparison.OrdinalIgnoreCase))
                return new Item(id, Outcome.Failed);

            var next = await GetPageAsync(accountKey, uri, lease, diagnostics, ct);
            if (next.Outcome != Outcome.Read)
                return new Item(id, next.Outcome);
            page = next.Body!;
        }
    }

    private sealed record Fetched(Outcome Outcome, JsonObject? Body);

    private async Task<Fetched> GetPageAsync(string accountKey, Uri uri, GraphFetchLease lease, RunDiagnostics? diagnostics, CancellationToken ct)
    {
        byte[] body;
        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, uri).ForAccount(accountKey).ForRun(diagnostics, DiagnosticKinds.Request);
            using var response = await http.SendAsync(request, ct);
            body = await response.Content.ReadAsByteArrayAsync(ct);
            request.RecordBytes(body.Length);
            if (GraphErrorText.IsTokenRejected(response, body))
                throw new GraphReadException(GraphReadFailure.SignInNeeded, GraphErrorText.SignInMessage);
            if (!response.IsSuccessStatusCode)
                return new Fetched(response.StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden ? Outcome.Refused : Outcome.Failed, null);
        }
        catch (Exception ex) when (ex is HttpRequestException or IOException or TaskCanceledException && !ct.IsCancellationRequested
            && !SignInRequiredException.IsIn(ex))
        {
            return new Fetched(Outcome.Failed, null);
        }
        await lease.AddAsync(body.Length, ct);
        try
        {
            return JsonNode.Parse(body) is JsonObject root ? new Fetched(Outcome.Read, root) : new Fetched(Outcome.Failed, null);
        }
        catch (JsonException)
        {
            return new Fetched(Outcome.Failed, null);
        }
    }

}
