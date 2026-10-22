using System.Collections.Concurrent;
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
            var urls = chunk.Select(o => "/" + path + "/" + Uri.EscapeDataString(o["id"]!.GetValue<string>()) + "?$select=" + select).ToList();
            var answers = await GraphBatchSender.SendAsync(http, accountKey, path, urls, lease, diagnostics, token);
            for (var i = 0; i < chunk.Length; i++)
            {
                if (!answers[i].Succeeded || answers[i].Body is not { } values)
                {
                    Interlocked.Increment(ref failed);
                    continue;
                }
                foreach (var column in columns)
                    chunk[i][column] = values[column]?.DeepClone();
                read.Add(chunk[i]);
            }
        });
        return new GraphBatchRead(failed, [.. read]);
    }
}
