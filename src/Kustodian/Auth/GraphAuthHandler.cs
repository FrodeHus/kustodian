using System.Net.Http.Headers;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

namespace Kustodian.Auth;

/// <summary>Adds <c>Authorization: Bearer</c> with a Graph token, and only to requests for <c>graph.microsoft.com</c> over https.
/// Any other host gets no credentials. The token is never logged. Throws
/// <see cref="Kustodian.Graph.Run.SignInRequiredException"/> (from the token source) when there is no usable sign-in.</summary>
public sealed class GraphAuthHandler(ITokenSource tokens, ILogger<GraphAuthHandler>? logger = null) : DelegatingHandler
{
    private const string GraphHost = "graph.microsoft.com";

    private readonly ILogger<GraphAuthHandler> _log = logger ?? NullLogger<GraphAuthHandler>.Instance;

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        var uri = request.RequestUri;
        if (uri is { IsAbsoluteUri: true } && uri.Scheme == Uri.UriSchemeHttps
            && string.Equals(uri.Host, GraphHost, StringComparison.OrdinalIgnoreCase))
        {
            var token = await tokens.GetTokenAsync(Audience.Graph, cancellationToken);
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
            _log.LogDebug("Attached a Graph token to a request for {Host}", uri.Host);
        }
        else
        {
            request.Headers.Authorization = null;
        }

        return await base.SendAsync(request, cancellationToken);
    }
}
