using System.Collections.Concurrent;
using System.Net.Http.Headers;
using Kustodian.Graph.Fetch;
using Kustodian.Graph.Run;
using Kustodian.Telemetry;
using Microsoft.Extensions.Logging;

namespace Kustodian.Auth;

/// <summary>Adds <c>Authorization: Bearer</c> with a token for <paramref name="audience"/>, and only to requests for
/// <paramref name="host"/> over https on the default port; any other request gets no credentials (one set beforehand is removed).
/// As with <see cref="GraphAuthHandler"/>, the token is for the account the request names (<see cref="GraphRequestAccount"/>),
/// never simply the active one, and it is never logged. Throws <see cref="SignInRequiredException"/> when a request for the host
/// names no account, and (from the token source) <see cref="ConsentRequiredException"/> when the account has to grant access
/// first. The ARM and Logs handlers are this gate with their host, audience and trail label.</summary>
public abstract class AudienceAuthHandler(
    ITokenSource tokens, Audience audience, string host, string label, ILogger log, ErrorTrail? trail) : DelegatingHandler
{
    // Each account's last token, by hash, so a new one is noticed for the trail; the token itself isn't kept.
    private readonly ConcurrentDictionary<string, int> _seen = new(StringComparer.Ordinal);

    private string Name => audience == Audience.Arm ? "Azure" : "Log Analytics";

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        var uri = request.RequestUri;
        if (uri is { IsAbsoluteUri: true } && uri.Scheme == Uri.UriSchemeHttps && uri.IsDefaultPort
            && string.Equals(uri.Host, host, StringComparison.OrdinalIgnoreCase))
        {
            var account = GraphRequestAccount.AccountOf(request)
                ?? throw new SignInRequiredException($"The {Name} request names no account.");
            var token = await tokens.GetTokenAsync(account, audience, cancellationToken);
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
            // shortcut: a token not seen before stands for one fetched rather than cached (the first after start counts too);
            // ask the token source when the trail needs it exact.
            var hash = token.GetHashCode(StringComparison.Ordinal);
            if (trail is not null && (!_seen.TryGetValue(account, out var last) || last != hash))
            {
                _seen[account] = hash;
                trail.Add($"token.acquire({label})");
            }

            log.LogDebug("Attached a {Name} token to a request for {Host}", Name, uri.Host);
        }
        else
        {
            request.Headers.Authorization = null;
        }

        return await base.SendAsync(request, cancellationToken);
    }
}
