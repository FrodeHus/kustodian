using System.Collections.Concurrent;
using System.Globalization;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using Kustodian.Graph.Run;

namespace Kustodian.Graph.Fetch;

/// <summary>What a run of per-object reads did: how many objects couldn't be read, and the objects that were.</summary>
public sealed record GraphBatchRead(int Failed, IReadOnlyList<JsonObject> Read);

/// <summary>
/// Reads properties Graph won't serve in a list one object at a time: <c>GET /{path}/{id}?$select=id,{columns}</c> for each
/// object, sent through <c>POST /$batch</c> (<see cref="BatchSize"/> requests per batch, <see cref="BatchesInFlight"/> batches
/// at once), and merges the values into the objects. An item that fails leaves its object's values empty and is counted; an
/// item Graph throttles is sent once more after its <c>Retry-After</c>. The HttpClient's handler adds the account's token.
/// </summary>
public sealed class GraphBatchReader(HttpClient http, GraphLimits limits)
{
    /// <summary>The most objects per table read one at a time (<see cref="GraphLimits.PerObjectReadsPerTable"/>); over it the
    /// columns stay empty.</summary>
    public int MaxObjects => limits.PerObjectReadsPerTable;
    public const int BatchSize = 20;
    public const int BatchesInFlight = 4;
    /// <summary>The longest a throttled item's <c>Retry-After</c> is waited for before it is sent again.</summary>
    private const int MaxRetryAfterSeconds = 5;
    private const int DefaultRetryAfterSeconds = 1;

    /// <summary>The relative URL of one object's read, with <c>{id}</c> for the id: what the fetch info shows.</summary>
    public static string Template(string path, IReadOnlyList<string> columns) => path + "/{id}?$select=" + Select(columns);

    private static string Select(IReadOnlyList<string> columns) => Uri.EscapeDataString(string.Join(",", columns.Prepend("id")));

    /// <summary>Reads <paramref name="columns"/> of every object in <paramref name="objects"/> (by its <c>id</c>) and sets them
    /// on the object. Returns how many objects couldn't be read, and the objects that were. The answers count against
    /// <paramref name="lease"/>. Each <c>$batch</c> carries <paramref name="diagnostics"/> as a
    /// <see cref="DiagnosticKinds.PerObject"/> request, and throttled items are logged, then their second try.</summary>
    public async Task<GraphBatchRead> ReadAsync(string accountKey, string path, IReadOnlyList<JsonObject> objects, IReadOnlyList<string> columns,
        GraphFetchLease lease, RunDiagnostics? diagnostics, CancellationToken ct)
    {
        var targets = objects.Where(o => o["id"] is JsonValue v && v.TryGetValue<string>(out _)).ToList();
        var failed = objects.Count - targets.Count;
        var select = Select(columns);
        var read = new ConcurrentBag<JsonObject>();
        var options = new ParallelOptions { MaxDegreeOfParallelism = BatchesInFlight, CancellationToken = ct };
        await Parallel.ForEachAsync(targets.Chunk(BatchSize), options, async (chunk, token) =>
        {
            var left = await SendAsync(accountKey, path, select, chunk, columns, lease, read, diagnostics, token);
            if (left.Throttled.Count > 0)
            {
                var wait = Math.Clamp(left.RetryAfterSeconds, 0, MaxRetryAfterSeconds);
                diagnostics?.Add(new DiagnosticEntry(diagnostics.NowMs, DiagnosticKinds.Throttled, string.Create(CultureInfo.InvariantCulture,
                    $"{path}: Graph throttled {Reads(left.Throttled.Count)}; Retry-After {left.RetryAfterSeconds} s"), (int)HttpStatusCode.TooManyRequests, null, null));
                await Task.Delay(TimeSpan.FromSeconds(wait), token);
                diagnostics?.Add(new DiagnosticEntry(diagnostics.NowMs, DiagnosticKinds.Retry, string.Create(CultureInfo.InvariantCulture,
                    $"{path}: sent {Reads(left.Throttled.Count)} again after {wait} s"), null, null, null));
                var again = await SendAsync(accountKey, path, select, [.. left.Throttled], columns, lease, read, diagnostics, token);
                Interlocked.Add(ref failed, again.Failed + again.Throttled.Count);
            }
            Interlocked.Add(ref failed, left.Failed);
        });
        return new GraphBatchRead(failed, [.. read]);
    }

    private static string Reads(int count) => count.ToString("N0", CultureInfo.InvariantCulture) + (count == 1 ? " read" : " reads");

    private sealed record Sent(int Failed, List<JsonObject> Throttled, int RetryAfterSeconds);

    /// <summary>One <c>$batch</c> of reads; the objects read are added to <paramref name="read"/>. A batch Graph doesn't answer
    /// counts every item as failed.</summary>
    private async Task<Sent> SendAsync(string accountKey, string path, string select, JsonObject[] chunk, IReadOnlyList<string> columns,
        GraphFetchLease lease, ConcurrentBag<JsonObject> read, RunDiagnostics? diagnostics, CancellationToken ct)
    {
        var batch = new JsonObject
        {
            ["requests"] = new JsonArray([.. chunk.Select((o, i) => (JsonNode)new JsonObject
            {
                ["id"] = i.ToString(CultureInfo.InvariantCulture),
                ["method"] = "GET",
                ["url"] = "/" + path + "/" + Uri.EscapeDataString(o["id"]!.GetValue<string>()) + "?$select=" + select,
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
                return new Sent(chunk.Length, [], 0);
        }
        catch (Exception ex) when (ex is HttpRequestException or IOException or TaskCanceledException && !ct.IsCancellationRequested
            && !SignInRequiredException.IsIn(ex))
        {
            return new Sent(chunk.Length, [], 0);
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
        var answered = 0;
        var throttled = new List<JsonObject>();
        int? retryAfter = null;
        foreach (var item in responses?.OfType<JsonObject>() ?? [])
        {
            if (!int.TryParse(Text(item["id"]), CultureInfo.InvariantCulture, out var i) || i < 0 || i >= chunk.Length)
                continue;
            var status = int.TryParse(Text(item["status"]), CultureInfo.InvariantCulture, out var code) ? code : 0;
            if (status == (int)HttpStatusCode.TooManyRequests)
            {
                throttled.Add(chunk[i]);
                if (int.TryParse(Text(item["headers"]?["Retry-After"]), CultureInfo.InvariantCulture, out var seconds))
                    retryAfter = Math.Max(retryAfter ?? 0, seconds);
                continue;
            }
            if (status is < 200 or >= 300 || item["body"] is not JsonObject values)
                continue;
            foreach (var column in columns)
                chunk[i][column] = values[column]?.DeepClone();
            read.Add(chunk[i]);
            answered++;
        }
        return new Sent(chunk.Length - answered - throttled.Count, throttled, retryAfter ?? DefaultRetryAfterSeconds);
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
