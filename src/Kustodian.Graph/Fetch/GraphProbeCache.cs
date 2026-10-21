using System.Collections.Concurrent;
using Kustodian.Graph.Run;

namespace Kustodian.Graph.Fetch;

/// <summary>What probing found for one table of one account (<see cref="GraphCollectionReader"/>): the columns Graph won't serve
/// in a list, the columns it refuses for permission, and when they were found.</summary>
public sealed record GraphProbeFindings(IReadOnlyList<string> NotListed, IReadOnlyList<string> Denied, DateTimeOffset FoundAt);

/// <summary>The columns Graph lists by default for one table of one account: the properties of an object in its answer to a
/// list read without <c>$select</c>, and when that was read.</summary>
public sealed record GraphDefaultColumns(IReadOnlyList<string> Columns, DateTimeOffset ReadAt);

/// <summary>
/// What the reader learnt about how a table lists for an account, kept for a while (<see cref="GraphLimits.ProbeCacheTtl"/>), so a
/// run soon after another needn't ask again: some collections (sign-in logs) throttle hard. The columns probing found a table
/// can't serve in a list are left out straight away instead of probed again, the columns Graph lists by default are what a
/// query that names no other column selects, and a table that refused <c>$top</c> is read without it. An entry is one table (its
/// path) of one account.
/// </summary>
public interface IGraphProbeCache
{
    /// <summary>The table's findings, or null when there are none (or they have expired).</summary>
    ValueTask<GraphProbeFindings?> GetAsync(string accountKey, string path, CancellationToken ct);

    /// <summary>Keeps <paramref name="notListed"/> and <paramref name="denied"/> as the table's findings, found now, in place of
    /// any earlier ones. With both empty the table has none.</summary>
    ValueTask SetAsync(string accountKey, string path, IReadOnlyList<string> notListed, IReadOnlyList<string> denied, CancellationToken ct);

    /// <summary>The columns Graph lists by default for the table, or null when they haven't been read (or have expired).</summary>
    ValueTask<GraphDefaultColumns?> GetDefaultsAsync(string accountKey, string path, CancellationToken ct);

    /// <summary>Keeps <paramref name="columns"/> as the columns Graph lists by default for the table, read now.</summary>
    ValueTask SetDefaultsAsync(string accountKey, string path, IReadOnlyList<string> columns, CancellationToken ct);

    /// <summary>The columns Graph lists by default for every table of the account that has them, by path.</summary>
    ValueTask<IReadOnlyDictionary<string, GraphDefaultColumns>> DefaultsOfAsync(string accountKey, CancellationToken ct);

    /// <summary>Whether Graph refused <c>$top</c> for the table (and that hasn't expired).</summary>
    ValueTask<bool> RefusesTopAsync(string accountKey, string path, CancellationToken ct);

    /// <summary>Keeps whether Graph refuses <c>$top</c> for the table, found now; false forgets an earlier refusal.</summary>
    ValueTask SetRefusesTopAsync(string accountKey, string path, bool refuses, CancellationToken ct);

    /// <summary>Forgets everything of the account.</summary>
    ValueTask RemoveAccountAsync(string accountKey, CancellationToken ct);

    /// <summary>Forgets everything, of every account.</summary>
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

    public ValueTask<GraphDefaultColumns?> GetDefaultsAsync(string accountKey, string path, CancellationToken ct)
        => ValueTask.FromResult<GraphDefaultColumns?>(null);

    public ValueTask SetDefaultsAsync(string accountKey, string path, IReadOnlyList<string> columns, CancellationToken ct)
        => ValueTask.CompletedTask;

    public ValueTask<IReadOnlyDictionary<string, GraphDefaultColumns>> DefaultsOfAsync(string accountKey, CancellationToken ct)
        => ValueTask.FromResult<IReadOnlyDictionary<string, GraphDefaultColumns>>(new Dictionary<string, GraphDefaultColumns>());

    public ValueTask<bool> RefusesTopAsync(string accountKey, string path, CancellationToken ct) => ValueTask.FromResult(false);

    public ValueTask SetRefusesTopAsync(string accountKey, string path, bool refuses, CancellationToken ct) => ValueTask.CompletedTask;

    public ValueTask RemoveAccountAsync(string accountKey, CancellationToken ct) => ValueTask.CompletedTask;

    public ValueTask ClearAsync(CancellationToken ct) => ValueTask.CompletedTask;
}

/// <summary><see cref="IGraphProbeCache"/> in the process's memory, for <see cref="GraphLimits.ProbeCacheTtl"/> of
/// <paramref name="limits"/> (7 days by default) after the findings were found or the defaults read.</summary>
public sealed class MemoryGraphProbeCache(TimeProvider time, GraphLimits? limits = null) : IGraphProbeCache
{
    private readonly ConcurrentDictionary<(string Account, string Path), GraphProbeFindings> _entries = new();
    private readonly ConcurrentDictionary<(string Account, string Path), GraphDefaultColumns> _defaults = new();
    private readonly ConcurrentDictionary<(string Account, string Path), DateTimeOffset> _refusesTop = new();
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

    public ValueTask<GraphDefaultColumns?> GetDefaultsAsync(string accountKey, string path, CancellationToken ct)
    {
        if (!_defaults.TryGetValue((accountKey, path), out var entry))
            return ValueTask.FromResult<GraphDefaultColumns?>(null);
        if (time.GetUtcNow() - entry.ReadAt >= _ttl)
        {
            _defaults.TryRemove(new KeyValuePair<(string, string), GraphDefaultColumns>((accountKey, path), entry));
            return ValueTask.FromResult<GraphDefaultColumns?>(null);
        }
        return ValueTask.FromResult<GraphDefaultColumns?>(entry);
    }

    public ValueTask SetDefaultsAsync(string accountKey, string path, IReadOnlyList<string> columns, CancellationToken ct)
    {
        _defaults[(accountKey, path)] = new GraphDefaultColumns([.. columns], time.GetUtcNow());
        return ValueTask.CompletedTask;
    }

    public ValueTask<IReadOnlyDictionary<string, GraphDefaultColumns>> DefaultsOfAsync(string accountKey, CancellationToken ct)
    {
        var now = time.GetUtcNow();
        return ValueTask.FromResult<IReadOnlyDictionary<string, GraphDefaultColumns>>(_defaults
            .Where(e => e.Key.Account == accountKey && now - e.Value.ReadAt < _ttl)
            .ToDictionary(e => e.Key.Path, e => e.Value, StringComparer.Ordinal));
    }

    public ValueTask<bool> RefusesTopAsync(string accountKey, string path, CancellationToken ct)
    {
        if (!_refusesTop.TryGetValue((accountKey, path), out var foundAt))
            return ValueTask.FromResult(false);
        if (time.GetUtcNow() - foundAt >= _ttl)
        {
            _refusesTop.TryRemove(new KeyValuePair<(string, string), DateTimeOffset>((accountKey, path), foundAt));
            return ValueTask.FromResult(false);
        }
        return ValueTask.FromResult(true);
    }

    public ValueTask SetRefusesTopAsync(string accountKey, string path, bool refuses, CancellationToken ct)
    {
        if (refuses)
            _refusesTop[(accountKey, path)] = time.GetUtcNow();
        else
            _refusesTop.TryRemove((accountKey, path), out _);
        return ValueTask.CompletedTask;
    }

    public ValueTask RemoveAccountAsync(string accountKey, CancellationToken ct)
    {
        foreach (var key in _entries.Keys.Where(k => k.Account == accountKey))
            _entries.TryRemove(key, out _);
        foreach (var key in _defaults.Keys.Where(k => k.Account == accountKey))
            _defaults.TryRemove(key, out _);
        foreach (var key in _refusesTop.Keys.Where(k => k.Account == accountKey))
            _refusesTop.TryRemove(key, out _);
        return ValueTask.CompletedTask;
    }

    public ValueTask ClearAsync(CancellationToken ct)
    {
        _entries.Clear();
        _defaults.Clear();
        _refusesTop.Clear();
        return ValueTask.CompletedTask;
    }
}
