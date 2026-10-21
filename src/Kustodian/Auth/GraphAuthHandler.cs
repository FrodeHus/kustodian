using System.Net.Http.Headers;
using Kustodian.Graph.Fetch;
using Kustodian.Graph.Run;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

namespace Kustodian.Auth;

/// <summary>Adds <c>Authorization: Bearer</c> with a Graph token, and only to requests for <c>graph.microsoft.com</c> over https.
/// The token is for the account the request names (<see cref="GraphRequestAccount"/>), never simply the active one, so a run
/// keeps its account to the end. Any other host gets no credentials. The token is never logged. Throws
/// <see cref="SignInRequiredException"/> when a Graph request names no account, or (from the token source) when that account has
/// no usable sign-in.</summary>
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
            var account = GraphRequestAccount.AccountOf(request)
                ?? throw new SignInRequiredException("The Graph request names no account.");
            var token = await tokens.GetTokenAsync(account, Audience.Graph, cancellationToken);
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
