using System.Net.Http.Headers;
using Kustodian.Graph.Fetch;
using Kustodian.Graph.Run;
using Kustodian.Sources;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

namespace Kustodian.Auth;

/// <summary>Adds <c>Authorization: Bearer</c> with an ARM token, and only to requests for <c>management.azure.com</c> over https.
/// As with <see cref="GraphAuthHandler"/>, the token is for the account the request names (<see cref="GraphRequestAccount"/>),
/// never simply the active one; any other host gets no credentials, and the token is never logged. Throws
/// <see cref="SignInRequiredException"/> when an ARM request names no account, and (from the token source)
/// <see cref="ConsentRequiredException"/> when the account has to grant ARM access first.</summary>
public sealed class ArmAuthHandler(ITokenSource tokens, ILogger<ArmAuthHandler>? logger = null) : DelegatingHandler
{
    private readonly ILogger<ArmAuthHandler> _log = logger ?? NullLogger<ArmAuthHandler>.Instance;

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        var uri = request.RequestUri;
        if (uri is { IsAbsoluteUri: true } && uri.Scheme == Uri.UriSchemeHttps
            && string.Equals(uri.Host, Arm.Host, StringComparison.OrdinalIgnoreCase))
        {
            var account = GraphRequestAccount.AccountOf(request)
                ?? throw new SignInRequiredException("The Azure request names no account.");
            var token = await tokens.GetTokenAsync(account, Audience.Arm, cancellationToken);
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
            _log.LogDebug("Attached an ARM token to a request for {Host}", uri.Host);
        }
        else
        {
            request.Headers.Authorization = null;
        }

        return await base.SendAsync(request, cancellationToken);
    }
}
