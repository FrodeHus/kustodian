using Kustodian.Auth;
using Microsoft.Extensions.Logging;

namespace Kustodian.App;

/// <summary>The HTTP client for Graph: the token handler over the run's request log (<see cref="DiagnosticsHandler"/>) over a
/// socket handler that follows no redirects, so a redirect never carries a token to another host. Nothing in the chain logs
/// headers. A client may wait longer than <see cref="HttpClient"/>'s default 100 s (advanced hunting runs up to 3 minutes).</summary>
public static class GraphHttp
{
    public static readonly Uri BaseAddress = new("https://graph.microsoft.com/beta/");

    public static HttpMessageHandler CreateHandler(ITokenSource tokens, ILogger<GraphAuthHandler>? logger = null) =>
        new GraphAuthHandler(tokens, logger)
        {
            InnerHandler = new DiagnosticsHandler { InnerHandler = new SocketsHttpHandler { AllowAutoRedirect = false } },
        };

    public static HttpClient CreateClient(ITokenSource tokens, ILogger<GraphAuthHandler>? logger = null, TimeSpan? timeout = null)
    {
        var client = new HttpClient(CreateHandler(tokens, logger)) { BaseAddress = BaseAddress };
        if (timeout is { } wait)
        {
            client.Timeout = wait;
        }

        return client;
    }
}
