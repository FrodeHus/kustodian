using System.Collections.Concurrent;
using System.Net;
using System.Text;
using System.Text.Json;
using Kustodian.Graph.Fetch;

namespace Kustodian.Graph.Tests.Run;

/// <summary>Microsoft Graph for runner tests: the primary handler of the <see cref="GraphCollectionReader"/>'s client. Every
/// request is recorded; <see cref="Answer"/> decides the response, and by default every collection is empty and every
/// <c>$batch</c> answers no item.</summary>
public sealed class FakeGraph : HttpMessageHandler
{
    public ConcurrentQueue<string> Requests { get; } = new();

    public Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> Answer { get; set; }
        = (_, _) => Task.FromResult(Collection([]));

    /// <summary>A reader over this fake, with the cache off.</summary>
    public GraphCollectionReader Reader(GraphFetchBudget budget)
        => new(new HttpClient(this) { BaseAddress = new Uri("https://graph.microsoft.com/beta/") }, budget, NoGraphObjectCache.Instance);

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        Requests.Enqueue(Uri.UnescapeDataString(request.RequestUri!.PathAndQuery));
        return await Answer(request, cancellationToken);
    }

    /// <summary>The columns a list request selects.</summary>
    public static string[] Select(HttpRequestMessage request)
        => Uri.UnescapeDataString(request.RequestUri!.OriginalString).Split("$select=")[1].Split('&')[0].Split(',');

    /// <summary>A one-page collection.</summary>
    public static HttpResponseMessage Collection(IEnumerable<object> values) => Json(HttpStatusCode.OK, new { value = values });

    /// <summary>A Graph error answer.</summary>
    public static HttpResponseMessage Error(HttpStatusCode status, string code, string message, int? retryAfterSeconds = null)
    {
        var response = Json(status, new { error = new { code, message } });
        if (retryAfterSeconds is { } seconds)
            response.Headers.RetryAfter = new System.Net.Http.Headers.RetryConditionHeaderValue(TimeSpan.FromSeconds(seconds));
        return response;
    }

    private static HttpResponseMessage Json(HttpStatusCode status, object body)
        => new(status) { Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json") };
}
