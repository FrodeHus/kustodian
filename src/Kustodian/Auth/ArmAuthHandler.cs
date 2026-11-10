using Kustodian.Graph.Run;
using Kustodian.Sources;
using Kustodian.Telemetry;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

namespace Kustodian.Auth;

/// <summary>The <see cref="AudienceAuthHandler"/> for Azure Resource Manager: an ARM token, only for <c>management.azure.com</c>.</summary>
public sealed class ArmAuthHandler(ITokenSource tokens, ILogger<ArmAuthHandler>? logger = null, ErrorTrail? trail = null)
    : AudienceAuthHandler(tokens, Audience.Arm, Arm.Host, "arm", logger ?? NullLogger<ArmAuthHandler>.Instance, trail);
