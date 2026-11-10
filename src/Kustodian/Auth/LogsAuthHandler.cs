using Kustodian.Graph.Run;
using Kustodian.Sources;
using Kustodian.Telemetry;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

namespace Kustodian.Auth;

/// <summary>The <see cref="AudienceAuthHandler"/> for the Azure Monitor Logs API: a Log Analytics token, only for
/// <c>api.loganalytics.azure.com</c>.</summary>
public sealed class LogsAuthHandler(ITokenSource tokens, ILogger<LogsAuthHandler>? logger = null, ErrorTrail? trail = null)
    : AudienceAuthHandler(tokens, Audience.LogAnalytics, LogAnalytics.Host, "logs", logger ?? NullLogger<LogsAuthHandler>.Instance, trail);
