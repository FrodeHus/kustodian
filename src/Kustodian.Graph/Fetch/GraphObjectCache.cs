using System.ComponentModel;

namespace Kustodian.Graph.Fetch;

/// <summary>One object's properties as a per-object read returned them (a JSON object of the selected columns, without
/// <c>id</c>), and when Graph sent them.</summary>
[ImmutableObject(true)]
public sealed record GraphCachedValues(string Json, DateTimeOffset ReadAt);

/// <summary>
/// The values of per-object reads (<see cref="GraphBatchReader"/>) kept for a while, so a run soon after another doesn't read the
/// same objects again. An entry is one object of one table of one account, for one set of columns (in any order). Only reads that
/// succeeded are kept.
/// </summary>
public interface IGraphObjectCache
{
    /// <summary>The object's cached values, or null when there are none (or they have expired).</summary>
    ValueTask<GraphCachedValues?> GetAsync(string accountKey, string path, IReadOnlyList<string> columns, string id, CancellationToken ct);

    /// <summary>Keeps the object's values, read from Graph now.</summary>
    ValueTask SetAsync(string accountKey, string path, IReadOnlyList<string> columns, string id, string json, CancellationToken ct);

    /// <summary>Forgets every value of the account.</summary>
    ValueTask RemoveAccountAsync(string accountKey, CancellationToken ct);
}

/// <summary>A cache that keeps nothing: every per-object read goes to Graph.</summary>
public sealed class NoGraphObjectCache : IGraphObjectCache
{
    public static readonly NoGraphObjectCache Instance = new();

    public ValueTask<GraphCachedValues?> GetAsync(string accountKey, string path, IReadOnlyList<string> columns, string id, CancellationToken ct)
        => ValueTask.FromResult<GraphCachedValues?>(null);

    public ValueTask SetAsync(string accountKey, string path, IReadOnlyList<string> columns, string id, string json, CancellationToken ct)
        => ValueTask.CompletedTask;

    public ValueTask RemoveAccountAsync(string accountKey, CancellationToken ct) => ValueTask.CompletedTask;
}
