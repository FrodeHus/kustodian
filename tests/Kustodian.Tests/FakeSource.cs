using Kustodian.Graph.Query;
using Kustodian.Graph.Run;
using Kustodian.Sources;

namespace Kustodian.Tests;

/// <summary>A run as the tests write it: the request's parts one by one.</summary>
public delegate Task<RunResult> FakeRun(string accountKey, string kql, IReadOnlyList<ParameterValue> parameters, bool refresh,
    string? runId, IProgress<RunEvent>? progress, CancellationToken ct);

/// <summary>A query source that hands each run to a <see cref="FakeRun"/> and keeps the requests it was given.</summary>
public sealed class FakeSource(string name, FakeRun run) : IQuerySource
{
    public string Name => name;

    public List<QueryRunRequest> Requests { get; } = [];

    public Task<RunResult> RunAsync(QueryRunRequest request, IProgress<RunEvent>? progress, CancellationToken ct)
    {
        lock (Requests)
        {
            Requests.Add(request);
        }

        return run(request.AccountKey, request.Kql, request.Parameters, request.Refresh, request.RunId, progress, ct);
    }

    /// <summary>The sources map with only Graph, which runs <paramref name="run"/>.</summary>
    public static IReadOnlyDictionary<string, IQuerySource> Graph(FakeRun run) => Map(new FakeSource("graph", run));

    public static IReadOnlyDictionary<string, IQuerySource> Map(params IQuerySource[] sources) =>
        sources.ToDictionary(s => s.Name, StringComparer.Ordinal);
}
