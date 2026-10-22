using Kustodian.Graph.Fetch;

namespace Kustodian.Graph.Run;

/// <summary>
/// The limits of Graph runs (spec 9), read from the settings once when the app starts. The defaults are the spec's:
/// <see cref="Default"/>. The engine's own limits (timeout, heap, workers) are <see cref="Engine.GraphEngineOptions"/>.
/// </summary>
public sealed record GraphLimits
{
    public static GraphLimits Default { get; } = new();

    /// <summary>The most objects one table's list read may return; over it the read fails <c>TooManyObjects</c>.</summary>
    public int ObjectsPerTable { get; init; } = 50_000;

    /// <summary>The process's fetch budget in estimated bytes (<see cref="GraphFetchBudget"/>).</summary>
    public long FetchBudgetBytes { get; init; } = GraphFetchBudget.DefaultMaxBytes;

    /// <summary>The most objects per table whose properties are read one at a time (<see cref="GraphBatchReader"/>); over it
    /// those columns stay empty.</summary>
    public int PerObjectReadsPerTable { get; init; } = 2_000;

    /// <summary>How long per-object values are kept (<see cref="MemoryGraphObjectCache"/>). Zero keeps nothing.</summary>
    public TimeSpan PerObjectCacheTtl { get; init; } = TimeSpan.FromMinutes(30);

    /// <summary>How long the columns probing found a table can't serve in a list are kept (<see cref="IGraphProbeCache"/>).</summary>
    public TimeSpan ProbeCacheTtl { get; init; } = TimeSpan.FromDays(7);

    /// <summary>The most rows the engine sends back for one run; the run's total still counts them all.</summary>
    public int RowsPerRun { get; init; } = 50_000;

    /// <summary>The most objects per table whose relationship columns (<c>memberOf</c>, <c>members</c>, ...) are read, one request
    /// each; over it those columns stay empty.</summary>
    public int RelationshipObjectsPerTable { get; init; } = 100;

    /// <summary>The most entries kept of one object's relationship; over it the list is cut off at this many.</summary>
    public int RelationshipEntriesPerObject { get; init; } = 1_000;
}
