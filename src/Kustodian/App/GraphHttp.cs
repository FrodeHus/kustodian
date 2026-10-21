using Kustodian.Auth;
using Microsoft.Extensions.Logging;

namespace Kustodian.App;

/// <summary>The HTTP client for Graph: the token handler over a socket handler that follows no redirects, so a redirect never
/// carries a token to another host. Nothing in the chain logs headers.</summary>
public static class GraphHttp
{
    public static readonly Uri BaseAddress = new("https://graph.microsoft.com/beta/");

    public static HttpMessageHandler CreateHandler(ITokenSource tokens, ILogger<GraphAuthHandler>? logger = null) =>
        new GraphAuthHandler(tokens, logger) { InnerHandler = new SocketsHttpHandler { AllowAutoRedirect = false } };

    public static HttpClient CreateClient(ITokenSource tokens, ILogger<GraphAuthHandler>? logger = null) =>
        new(CreateHandler(tokens, logger)) { BaseAddress = BaseAddress };
}
