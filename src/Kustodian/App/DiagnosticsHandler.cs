using Kustodian.Graph.Run;

namespace Kustodian.App;

/// <summary>Logs each request that carries a run's diagnostics (<see cref="RunDiagnosticsRequest.ForRun"/>) into that run's log:
/// its method and URL relative to the Graph version (or to ARM's root, <see cref="ArmHttp"/>), the status of the response, how long it took and the body size. It sits
/// inside the token handler (<see cref="GraphHttp"/>), so it sees the response the caller gets; it reads only the request's
/// method and URL and the response's status and <c>Content-Length</c>, never any other header, so no token can reach the log.
/// When the response states no length, the reader adds the size of the body it read
/// (<see cref="RunDiagnosticsRequest.RecordBytes"/>). A request without a run's log passes through untouched.</summary>
public sealed class DiagnosticsHandler : DelegatingHandler
{
    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        if (RunDiagnosticsRequest.DiagnosticsOf(request) is not { } diagnostics)
        {
            return await base.SendAsync(request, cancellationToken);
        }

        var kind = RunDiagnosticsRequest.KindOf(request);
        var detail = request.Method.Method + " " + Relative(request.RequestUri);
        var at = diagnostics.NowMs;
        HttpResponseMessage response;
        try
        {
            response = await base.SendAsync(request, cancellationToken);
        }
        catch (Exception) when (!cancellationToken.IsCancellationRequested)
        {
            diagnostics.Add(new DiagnosticEntry(at, kind, detail + " (no answer)", null, diagnostics.NowMs - at, null));
            throw;
        }

        request.LogRequest(diagnostics, new DiagnosticEntry(at, kind, detail, (int)response.StatusCode, diagnostics.NowMs - at,
            response.Content.Headers.ContentLength));
        return response;
    }

    /// <summary>The URL relative to <see cref="GraphHttp.BaseAddress"/> or <see cref="ArmHttp.BaseAddress"/>, as sent (escaped);
    /// any other URL whole.</summary>
    private static string Relative(Uri? uri)
    {
        if (uri is null)
        {
            return "";
        }

        if (!uri.IsAbsoluteUri)
        {
            return uri.OriginalString;
        }

        var text = uri.AbsoluteUri;
        foreach (var baseText in new[] { GraphHttp.BaseAddress.AbsoluteUri, ArmHttp.BaseAddress.AbsoluteUri })
        {
            if (text.StartsWith(baseText, StringComparison.Ordinal))
            {
                return text[baseText.Length..];
            }
        }

        return text;
    }
}
