using Kustodian.Graph.Run;
using Kustodian.Sources;

namespace Kustodian.App;

/// <summary>The <c>graph</c> source: a run of <see cref="GraphRunner"/>, which substitutes the parameters, fetches from Microsoft
/// Graph and runs the query locally. Graph has no timespan or scope, so the request's options are ignored.</summary>
public sealed class GraphQuerySource(GraphRunner runner) : IQuerySource
{
    public string Name => "graph";

    public Task<RunResult> RunAsync(QueryRunRequest request, IProgress<RunEvent>? progress, CancellationToken ct) =>
        runner.RunAsync(request.AccountKey, request.Kql, request.Parameters, request.Refresh, request.RunId, progress, ct);
}
