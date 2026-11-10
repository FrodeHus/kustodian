using Kustodian.Auth;
using Kustodian.Telemetry;
using Microsoft.Extensions.Logging;

namespace Kustodian.App;

/// <summary>The HTTP client for the Azure Monitor Logs query API, built as <see cref="GraphHttp"/>
/// is: the Logs token handler over the run's request log (<see cref="DiagnosticsHandler"/>) over a socket handler that follows no
/// redirects, so a redirect never carries a token to another host. Nothing in the chain logs headers.</summary>
public static class LogsHttp
{
    public static readonly Uri BaseAddress = new("https://api.loganalytics.azure.com/");

    public static HttpMessageHandler CreateHandler(ITokenSource tokens, ILogger<LogsAuthHandler>? logger = null, ErrorTrail? trail = null) =>
        new LogsAuthHandler(tokens, logger, trail)
        {
            InnerHandler = new DiagnosticsHandler { InnerHandler = new SocketsHttpHandler { AllowAutoRedirect = false } },
        };

    public static HttpClient CreateClient(ITokenSource tokens, ILogger<LogsAuthHandler>? logger = null, ErrorTrail? trail = null) =>
        new(CreateHandler(tokens, logger, trail)) { BaseAddress = BaseAddress };
}
