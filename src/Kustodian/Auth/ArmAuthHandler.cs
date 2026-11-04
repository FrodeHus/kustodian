using System.Collections.Concurrent;
using System.Net.Http.Headers;
using Kustodian.Graph.Fetch;
using Kustodian.Graph.Run;
using Kustodian.Sources;
using Kustodian.Telemetry;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

namespace Kustodian.Auth;

/// <summary>Adds <c>Authorization: Bearer</c> with an ARM token, and only to requests for <c>management.azure.com</c> over https.
/// As with <see cref="GraphAuthHandler"/>, the token is for the account the request names (<see cref="GraphRequestAccount"/>),
/// never simply the active one; any other host gets no credentials, and the token is never logged. Throws
/// <see cref="SignInRequiredException"/> when an ARM request names no account, and (from the token source)
/// <see cref="ConsentRequiredException"/> when the account has to grant ARM access first.</summary>
public sealed class ArmAuthHandler(ITokenSource tokens, ILogger<ArmAuthHandler>? logger = null, ErrorTrail? trail = null)
    : DelegatingHandler
{
    // Each account's last token, by hash, so a new one is noticed for the trail; the token itself isn't kept.
    private readonly ConcurrentDictionary<string, int> _seen = new(StringComparer.Ordinal);

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
            // shortcut: a token not seen before stands for one fetched rather than cached (the first after start counts too);
            // ask the token source when the trail needs it exact.
            var hash = token.GetHashCode(StringComparison.Ordinal);
            if (trail is not null && (!_seen.TryGetValue(account, out var last) || last != hash))
            {
                _seen[account] = hash;
                trail.Add("token.acquire(arm)");
            }
            _log.LogDebug("Attached an ARM token to a request for {Host}", uri.Host);
        }
        else
        {
            request.Headers.Authorization = null;
        }

        return await base.SendAsync(request, cancellationToken);
    }
}
