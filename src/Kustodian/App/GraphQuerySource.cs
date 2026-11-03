using Kustodian.Graph.Run;
using Kustodian.Sources;
using Kustodian.Telemetry;

namespace Kustodian.App;

/// <summary>The <c>graph</c> source: a run of <see cref="GraphRunner"/>, which substitutes the parameters, fetches from Microsoft
/// Graph and runs the query locally. Graph has no timespan or scope, so the request's options are ignored. What a run finds is
/// shared through <paramref name="findings"/> when the user opted in.</summary>
public sealed class GraphQuerySource(GraphRunner runner, SharedRunFindings? findings = null) : IQuerySource
{
    public string Name => "graph";

    public async Task<RunResult> RunAsync(QueryRunRequest request, IProgress<RunEvent>? progress, CancellationToken ct)
    {
        var result = await runner.RunAsync(request.AccountKey, request.Kql, request.Parameters, request.Refresh, request.RunId, progress, ct);
        if (findings is not null)
            await findings.ShareAsync(request.AccountKey, result, ct);
        return result;
    }
}
