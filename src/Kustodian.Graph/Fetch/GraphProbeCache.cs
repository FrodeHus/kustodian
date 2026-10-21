using System.Collections.Concurrent;
using Kustodian.Graph.Run;

namespace Kustodian.Graph.Fetch;

/// <summary>What probing found for one table of one account (<see cref="GraphCollectionReader"/>): the columns Graph won't serve
/// in a list, the columns it refuses for permission, and when they were found.</summary>
public sealed record GraphProbeFindings(IReadOnlyList<string> NotListed, IReadOnlyList<string> Denied, DateTimeOffset FoundAt);

/// <summary>
/// The columns probing found a table can't serve in a list, kept for a while (<see cref="GraphLimits.ProbeCacheTtl"/>), so a run soon after
/// another selects without them straight away instead of probing again: some collections (sign-in logs) throttle hard. An
/// entry is one table (its path) of one account.
/// </summary>
public interface IGraphProbeCache
{
    /// <summary>The table's findings, or null when there are none (or they have expired).</summary>
    ValueTask<GraphProbeFindings?> GetAsync(string accountKey, string path, CancellationToken ct);

    /// <summary>Keeps <paramref name="notListed"/> and <paramref name="denied"/> as the table's findings, found now, in place of
    /// any earlier ones. With both empty the table has none.</summary>
    ValueTask SetAsync(string accountKey, string path, IReadOnlyList<string> notListed, IReadOnlyList<string> denied, CancellationToken ct);

    /// <summary>Forgets every finding of the account.</summary>
    ValueTask RemoveAccountAsync(string accountKey, CancellationToken ct);

    /// <summary>Forgets every finding, of every account.</summary>
    ValueTask ClearAsync(CancellationToken ct);
}

/// <summary>A cache that keeps nothing: every read that Graph refuses probes again.</summary>
public sealed class NoGraphProbeCache : IGraphProbeCache
{
    public static readonly NoGraphProbeCache Instance = new();

    public ValueTask<GraphProbeFindings?> GetAsync(string accountKey, string path, CancellationToken ct)
        => ValueTask.FromResult<GraphProbeFindings?>(null);

    public ValueTask SetAsync(string accountKey, string path, IReadOnlyList<string> notListed, IReadOnlyList<string> denied, CancellationToken ct)
        => ValueTask.CompletedTask;

    public ValueTask RemoveAccountAsync(string accountKey, CancellationToken ct) => ValueTask.CompletedTask;

    public ValueTask ClearAsync(CancellationToken ct) => ValueTask.CompletedTask;
}

/// <summary><see cref="IGraphProbeCache"/> in the process's memory, for <see cref="GraphLimits.ProbeCacheTtl"/> of
/// <paramref name="limits"/> (7 days by default) after the findings were found.</summary>
public sealed class MemoryGraphProbeCache(TimeProvider time, GraphLimits? limits = null) : IGraphProbeCache
{
    private readonly ConcurrentDictionary<(string Account, string Path), GraphProbeFindings> _entries = new();
    private readonly TimeSpan _ttl = (limits ?? GraphLimits.Default).ProbeCacheTtl;

    public ValueTask<GraphProbeFindings?> GetAsync(string accountKey, string path, CancellationToken ct)
    {
        if (!_entries.TryGetValue((accountKey, path), out var entry))
            return ValueTask.FromResult<GraphProbeFindings?>(null);
        if (time.GetUtcNow() - entry.FoundAt >= _ttl)
        {
            _entries.TryRemove(new KeyValuePair<(string, string), GraphProbeFindings>((accountKey, path), entry));
            return ValueTask.FromResult<GraphProbeFindings?>(null);
        }
        return ValueTask.FromResult<GraphProbeFindings?>(entry);
    }

    public ValueTask SetAsync(string accountKey, string path, IReadOnlyList<string> notListed, IReadOnlyList<string> denied, CancellationToken ct)
    {
        if (notListed.Count == 0 && denied.Count == 0)
            _entries.TryRemove((accountKey, path), out _);
        else
            _entries[(accountKey, path)] = new GraphProbeFindings([.. notListed], [.. denied], time.GetUtcNow());
        return ValueTask.CompletedTask;
    }

    public ValueTask RemoveAccountAsync(string accountKey, CancellationToken ct)
    {
        foreach (var key in _entries.Keys.Where(k => k.Account == accountKey))
            _entries.TryRemove(key, out _);
        return ValueTask.CompletedTask;
    }

    public ValueTask ClearAsync(CancellationToken ct)
    {
        _entries.Clear();
        return ValueTask.CompletedTask;
    }
}
