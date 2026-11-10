using System.Collections.Concurrent;
using System.Net.Http.Headers;
using Kustodian.Graph.Fetch;
using Kustodian.Graph.Run;
using Kustodian.Sources;
using Kustodian.Telemetry;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

namespace Kustodian.Auth;

/// <summary>Adds <c>Authorization: Bearer</c> with a Log Analytics token, and only to requests for <c>api.loganalytics.azure.com</c> over https.
/// As with <see cref="GraphAuthHandler"/>, the token is for the account the request names (<see cref="GraphRequestAccount"/>),
/// never simply the active one; any other host gets no credentials, and the token is never logged. Throws
/// <see cref="SignInRequiredException"/> when a Logs request names no account, and (from the token source)
/// <see cref="ConsentRequiredException"/> when the account has to grant Log Analytics access first.</summary>
public sealed class LogsAuthHandler(ITokenSource tokens, ILogger<LogsAuthHandler>? logger = null, ErrorTrail? trail = null)
    : DelegatingHandler
{
    // Each account's last token, by hash, so a new one is noticed for the trail; the token itself isn't kept.
    private readonly ConcurrentDictionary<string, int> _seen = new(StringComparer.Ordinal);

    private readonly ILogger<LogsAuthHandler> _log = logger ?? NullLogger<LogsAuthHandler>.Instance;

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        var uri = request.RequestUri;
        if (uri is { IsAbsoluteUri: true } && uri.Scheme == Uri.UriSchemeHttps
            && string.Equals(uri.Host, LogAnalytics.Host, StringComparison.OrdinalIgnoreCase))
        {
            var account = GraphRequestAccount.AccountOf(request)
                ?? throw new SignInRequiredException("The Log Analytics request names no account.");
            var token = await tokens.GetTokenAsync(account, Audience.LogAnalytics, cancellationToken);
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
            // shortcut: a token not seen before stands for one fetched rather than cached (the first after start counts too);
            // ask the token source when the trail needs it exact.
            var hash = token.GetHashCode(StringComparison.Ordinal);
            if (trail is not null && (!_seen.TryGetValue(account, out var last) || last != hash))
            {
                _seen[account] = hash;
                trail.Add("token.acquire(logs)");
            }
            _log.LogDebug("Attached a Log Analytics token to a request for {Host}", uri.Host);
        }
        else
        {
            request.Headers.Authorization = null;
        }

        return await base.SendAsync(request, cancellationToken);
    }
}
