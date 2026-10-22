using System.Globalization;
using System.Net;
using System.Net.Http.Json;
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
/// through <c>POST /$batch</c> like <see cref="GraphBatchReader"/> (same batch size, batches in flight and single retry of a
/// throttled item). A collection's next pages are plain GETs, followed only to https on graph.microsoft.com, until the object
/// has <see cref="GraphLimits.RelationshipEntriesPerObject"/> entries. Every body counts against the lease.
/// </summary>
public sealed class GraphRelationshipReader(HttpClient http, GraphLimits limits)
{
    private const string GraphHost = "graph.microsoft.com";
    private const string TypePrefix = "#microsoft.graph.";
    private const int MaxRetryAfterSeconds = 5;
    private const int DefaultRetryAfterSeconds = 1;
    private const string Select = "$select=id,displayName,userPrincipalName,mail,appId,deviceId";
    private static readonly string[] ShapeFields = ["displayName", "userPrincipalName", "mail", "appId", "deviceId"];

    /// <summary>The relative URL of one object's read, with <c>{id}</c> for the id: what the fetch info shows.</summary>
    public static string Template(string path, string relationship, bool collection)
        => path + "/{id}/" + relationship + "?" + Select + (collection ? "&$top=999" : "");

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

    private enum Outcome { Read, Missing, Refused, Failed, Throttled }

    private sealed record Item(string Id, Outcome Outcome, JsonNode? Value = null, bool Truncated = false, int RetryAfterSeconds = 0);

    /// <summary>Reads <paramref name="relationship"/> of every object in <paramref name="objects"/> (by its <c>id</c>). The
    /// answers count against <paramref name="lease"/>.</summary>
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
            var first = await SendAsync(accountKey, path, relationship, chunk, lease, diagnostics, token);
            Record(first.Where(i => i.Outcome != Outcome.Throttled));
            var throttled = first.Where(i => i.Outcome == Outcome.Throttled).ToArray();
            if (throttled.Length == 0)
                return;
            var retryAfter = throttled.Max(i => i.RetryAfterSeconds);
            var wait = Math.Clamp(retryAfter, 0, MaxRetryAfterSeconds);
            diagnostics?.Add(new DiagnosticEntry(diagnostics.NowMs, DiagnosticKinds.Throttled, string.Create(CultureInfo.InvariantCulture,
                $"{path}: Graph throttled {Reads(throttled.Length)}; Retry-After {retryAfter} s"), (int)HttpStatusCode.TooManyRequests, null, null));
            await Task.Delay(TimeSpan.FromSeconds(wait), token);
            diagnostics?.Add(new DiagnosticEntry(diagnostics.NowMs, DiagnosticKinds.Retry, string.Create(CultureInfo.InvariantCulture,
                $"{path}: sent {Reads(throttled.Length)} again after {wait} s"), null, null, null));
            var again = await SendAsync(accountKey, path, relationship, [.. throttled.Select(i => i.Id)], lease, diagnostics, token);
            Record(again.Select(i => i.Outcome == Outcome.Throttled ? i with { Outcome = Outcome.Failed } : i));
        });
        return new GraphRelationshipRead(values, truncated, refused, failed);
    }

    private static string Reads(int count) => count.ToString("N0", CultureInfo.InvariantCulture) + (count == 1 ? " read" : " reads");

    /// <summary>One <c>$batch</c> of first-page reads; a batch Graph doesn't answer fails every item.</summary>
    private async Task<List<Item>> SendAsync(string accountKey, string path, GraphColumn relationship, string[] chunk,
        GraphFetchLease lease, RunDiagnostics? diagnostics, CancellationToken ct)
    {
        var batch = new JsonObject
        {
            ["requests"] = new JsonArray([.. chunk.Select((id, i) => (JsonNode)new JsonObject
            {
                ["id"] = i.ToString(CultureInfo.InvariantCulture),
                ["method"] = "GET",
                ["url"] = "/" + Template(path, relationship.Name, relationship.Collection).Replace("{id}", Uri.EscapeDataString(id), StringComparison.Ordinal),
            })]),
        };
        byte[] body;
        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, new Uri("$batch", UriKind.Relative)) { Content = JsonContent.Create(batch) }
                .ForAccount(accountKey).ForRun(diagnostics, DiagnosticKinds.PerObject);
            using var response = await http.SendAsync(request, ct);
            body = await response.Content.ReadAsByteArrayAsync(ct);
            request.RecordBytes(body.Length);
            if (GraphErrorText.IsTokenRejected(response, body))
                throw new GraphReadException(GraphReadFailure.SignInNeeded, GraphErrorText.SignInMessage);
            if (!response.IsSuccessStatusCode)
                return Failed(chunk);
        }
        catch (Exception ex) when (ex is HttpRequestException or IOException or TaskCanceledException && !ct.IsCancellationRequested
            && !SignInRequiredException.IsIn(ex))
        {
            return Failed(chunk);
        }
        await lease.AddAsync(body.Length, ct);

        JsonArray? responses;
        try
        {
            responses = JsonNode.Parse(body)?["responses"] as JsonArray;
        }
        catch (JsonException)
        {
            responses = null;
        }
        var items = Failed(chunk);
        foreach (var answer in responses?.OfType<JsonObject>() ?? [])
        {
            if (!int.TryParse(Text(answer["id"]), CultureInfo.InvariantCulture, out var i) || i < 0 || i >= chunk.Length)
                continue;
            var status = int.TryParse(Text(answer["status"]), CultureInfo.InvariantCulture, out var code) ? code : 0;
            var id = chunk[i];
            if (status == (int)HttpStatusCode.TooManyRequests)
            {
                var seconds = int.TryParse(Text(answer["headers"]?["Retry-After"]), CultureInfo.InvariantCulture, out var s) ? s : DefaultRetryAfterSeconds;
                items[i] = new Item(id, Outcome.Throttled, RetryAfterSeconds: seconds);
            }
            else if (status is >= 200 and < 300)
                items[i] = await ReadValueAsync(accountKey, id, relationship, answer["body"] as JsonObject, lease, diagnostics, ct);
            else if (status is 401 or 403)
                items[i] = new Item(id, Outcome.Refused);
            else if (status == (int)HttpStatusCode.NotFound && !relationship.Collection)
                items[i] = new Item(id, Outcome.Missing);
        }
        return items;
    }

    private static List<Item> Failed(string[] chunk) => [.. chunk.Select(id => new Item(id, Outcome.Failed))];

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

    /// <summary>A string or number value as text (Graph sends ids as strings and statuses as numbers), else null.</summary>
    private static string? Text(JsonNode? node) => node is JsonValue value
        ? value.GetValueKind() switch
        {
            JsonValueKind.String => value.GetValue<string>(),
            JsonValueKind.Number => value.ToJsonString(),
            _ => null,
        }
        : null;
}
