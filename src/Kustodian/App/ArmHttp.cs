using Kustodian.Auth;
using Microsoft.Extensions.Logging;

namespace Kustodian.App;

/// <summary>The HTTP client for Azure Resource Manager (Resource Graph and the ARM directory), built as <see cref="GraphHttp"/>
/// is: the ARM token handler over the run's request log (<see cref="DiagnosticsHandler"/>) over a socket handler that follows no
/// redirects, so a redirect never carries a token to another host. Nothing in the chain logs headers.</summary>
public static class ArmHttp
{
    public static readonly Uri BaseAddress = new("https://management.azure.com/");

    public static HttpMessageHandler CreateHandler(ITokenSource tokens, ILogger<ArmAuthHandler>? logger = null) =>
        new ArmAuthHandler(tokens, logger)
        {
            InnerHandler = new DiagnosticsHandler { InnerHandler = new SocketsHttpHandler { AllowAutoRedirect = false } },
        };

    public static HttpClient CreateClient(ITokenSource tokens, ILogger<ArmAuthHandler>? logger = null) =>
        new(CreateHandler(tokens, logger)) { BaseAddress = BaseAddress };
}
