using Kustodian.Graph.Query;
using Kustodian.Graph.Run;

namespace Kustodian.Sources;

/// <summary>One run as a source takes it: the account, the query and its parameter values, whether to skip caches, the UI's
/// name for the run (used when it is a GUID in <c>D</c> format, <see cref="RunDiagnostics.IsRunId"/>) and the run's options
/// (already checked with <see cref="QueryOptions.Problem"/>; null takes the source's defaults).</summary>
public sealed record QueryRunRequest(string AccountKey, string Kql, IReadOnlyList<ParameterValue> Parameters, bool Refresh,
    string? RunId, QueryOptions? Options);

/// <summary>Somewhere a query runs, named as <c>query.run</c>'s <c>source</c> names it (<c>graph</c>, <c>hunting</c>,
/// <c>arg</c>). A run reports its stages to <c>progress</c> and answers with a <see cref="RunResult"/>; cancelling
/// <c>ct</c> ends it with an <see cref="OperationCanceledException"/>.</summary>
public interface IQuerySource
{
    string Name { get; }

    Task<RunResult> RunAsync(QueryRunRequest request, IProgress<RunEvent>? progress, CancellationToken ct);
}
