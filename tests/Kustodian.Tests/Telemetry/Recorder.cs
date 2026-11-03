using System.Collections.Concurrent;
using System.Net;

namespace Kustodian.Tests.Telemetry;

/// <summary>Records what is posted to Application Insights; answers 200, or throws when <see cref="Fail"/> is set.</summary>
internal sealed class Recorder : HttpMessageHandler
{
    public ConcurrentQueue<string> Bodies { get; } = new();
    public ConcurrentQueue<Uri> Uris { get; } = new();
    public bool Fail { get; set; }

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
    {
        Uris.Enqueue(request.RequestUri!);
        if (Fail)
            throw new HttpRequestException("unreachable");
        Bodies.Enqueue(await request.Content!.ReadAsStringAsync(ct));
        return new HttpResponseMessage(HttpStatusCode.OK);
    }

    /// <summary>The bodies once <paramref name="count"/> have arrived: the sends aren't awaited by the cache.</summary>
    public async Task<List<string>> WaitForAsync(int count)
    {
        for (var i = 0; i < 100 && Bodies.Count < count; i++)
            await Task.Delay(20);
        return [.. Bodies];
    }
}
