using System.Globalization;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using Kustodian.Graph.Run;

namespace Kustodian.Graph.Fetch;

/// <summary>One item's answer to a <c>$batch</c>: its HTTP status (0 when Graph gave none, or the batch itself failed) and
/// its body when that is a JSON object.</summary>
internal sealed record GraphBatchAnswer(int Status, JsonObject? Body)
{
    public static GraphBatchAnswer None { get; } = new(0, null);

    public bool Succeeded => Status is >= 200 and < 300;
}

/// <summary>
/// The <c>POST /$batch</c> transport <see cref="GraphBatchReader"/> and <see cref="GraphRelationshipReader"/> share: sends
/// GETs for relative urls (at most <see cref="GraphBatchReader.BatchSize"/> per call), charges every answer to the lease, and
/// sends an item Graph throttles (429) once more after its <c>Retry-After</c> (capped), logging both to the run's diagnostics.
/// </summary>
internal static class GraphBatchSender
{
    /// <summary>The longest a throttled item's <c>Retry-After</c> is waited for before it is sent again.</summary>
    private const int MaxRetryAfterSeconds = 5;
    private const int DefaultRetryAfterSeconds = 1;

    /// <summary>Sends <paramref name="urls"/> (each with its leading slash) and returns one answer per url, in order. A batch
    /// Graph doesn't answer, or an item it leaves out, is <see cref="GraphBatchAnswer.None"/>; an item still throttled after its
    /// second try keeps status 429. <paramref name="path"/> names the table in diagnostics.</summary>
    public static async Task<GraphBatchAnswer[]> SendAsync(HttpClient http, string accountKey, string path, IReadOnlyList<string> urls,
        GraphFetchLease lease, RunDiagnostics? diagnostics, CancellationToken ct)
    {
        var (answers, retryAfter) = await SendOnceAsync(http, accountKey, urls, lease, diagnostics, ct);
        var throttled = Enumerable.Range(0, urls.Count).Where(i => answers[i].Status == (int)HttpStatusCode.TooManyRequests).ToArray();
        if (throttled.Length == 0)
            return answers;

        var wait = Math.Clamp(retryAfter, 0, MaxRetryAfterSeconds);
        diagnostics?.Add(new DiagnosticEntry(diagnostics.NowMs, DiagnosticKinds.Throttled, string.Create(CultureInfo.InvariantCulture,
            $"{path}: Graph throttled {Reads(throttled.Length)}; Retry-After {retryAfter} s"), (int)HttpStatusCode.TooManyRequests, null, null));
        await Task.Delay(TimeSpan.FromSeconds(wait), ct);
        diagnostics?.Add(new DiagnosticEntry(diagnostics.NowMs, DiagnosticKinds.Retry, string.Create(CultureInfo.InvariantCulture,
            $"{path}: sent {Reads(throttled.Length)} again after {wait} s"), null, null, null));
        var (again, _) = await SendOnceAsync(http, accountKey, [.. throttled.Select(i => urls[i])], lease, diagnostics, ct);
        for (var n = 0; n < throttled.Length; n++)
            answers[throttled[n]] = again[n];
        return answers;
    }

    private static string Reads(int count) => count.ToString("N0", CultureInfo.InvariantCulture) + (count == 1 ? " read" : " reads");

    /// <summary>One <c>$batch</c>, and the longest <c>Retry-After</c> its throttled items asked for.</summary>
    private static async Task<(GraphBatchAnswer[] Answers, int RetryAfterSeconds)> SendOnceAsync(HttpClient http, string accountKey,
        IReadOnlyList<string> urls, GraphFetchLease lease, RunDiagnostics? diagnostics, CancellationToken ct)
    {
        var answers = Enumerable.Repeat(GraphBatchAnswer.None, urls.Count).ToArray();
        var batch = new JsonObject
        {
            ["requests"] = new JsonArray([.. urls.Select((url, i) => (JsonNode)new JsonObject
            {
                ["id"] = i.ToString(CultureInfo.InvariantCulture),
                ["method"] = "GET",
                ["url"] = url,
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
                return (answers, DefaultRetryAfterSeconds);
        }
        catch (Exception ex) when (ex is HttpRequestException or IOException or TaskCanceledException && !ct.IsCancellationRequested
            && !SignInRequiredException.IsIn(ex))
        {
            return (answers, DefaultRetryAfterSeconds);
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
        int? retryAfter = null;
        foreach (var item in responses?.OfType<JsonObject>() ?? [])
        {
            if (!int.TryParse(Text(item["id"]), CultureInfo.InvariantCulture, out var i) || i < 0 || i >= urls.Count)
                continue;
            var status = int.TryParse(Text(item["status"]), CultureInfo.InvariantCulture, out var code) ? code : 0;
            answers[i] = new GraphBatchAnswer(status, item["body"] as JsonObject);
            if (status == (int)HttpStatusCode.TooManyRequests
                && int.TryParse(Text(item["headers"]?["Retry-After"]), CultureInfo.InvariantCulture, out var seconds))
                retryAfter = Math.Max(retryAfter ?? 0, seconds);
        }
        return (answers, retryAfter ?? DefaultRetryAfterSeconds);
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
