using System.Collections.Concurrent;
using Kustodian.Graph.Run;

namespace Kustodian.Graph.Fetch;

/// <summary>
/// <see cref="IGraphObjectCache"/> in the process's memory, for <see cref="GraphLimits.PerObjectCacheTtl"/> of
/// <paramref name="limits"/> (30 minutes by default) after Graph sent the values. An entry is one object of one table of one
/// account, for one set of columns (in any order).
/// </summary>
public sealed class MemoryGraphObjectCache(TimeProvider time, GraphLimits? limits = null) : IGraphObjectCache
{
    private readonly record struct Key(string Account, string Path, string Columns, string Id);

    private readonly ConcurrentDictionary<Key, GraphCachedValues> _entries = new();
    private readonly TimeSpan _ttl = (limits ?? GraphLimits.Default).PerObjectCacheTtl;

    private static Key KeyOf(string accountKey, string path, IReadOnlyList<string> columns, string id)
        => new(accountKey, path, string.Join(",", columns.Order(StringComparer.Ordinal)), id);

    public ValueTask<GraphCachedValues?> GetAsync(string accountKey, string path, IReadOnlyList<string> columns, string id, CancellationToken ct)
    {
        var key = KeyOf(accountKey, path, columns, id);
        if (!_entries.TryGetValue(key, out var entry))
            return ValueTask.FromResult<GraphCachedValues?>(null);
        if (time.GetUtcNow() - entry.ReadAt >= _ttl)
        {
            _entries.TryRemove(new KeyValuePair<Key, GraphCachedValues>(key, entry));
            return ValueTask.FromResult<GraphCachedValues?>(null);
        }
        return ValueTask.FromResult<GraphCachedValues?>(entry);
    }

    public ValueTask SetAsync(string accountKey, string path, IReadOnlyList<string> columns, string id, string json, CancellationToken ct)
    {
        var now = time.GetUtcNow();
        // Expired entries are dropped as new ones come in, so a long session doesn't keep growing.
        foreach (var (key, entry) in _entries)
        {
            if (now - entry.ReadAt >= _ttl)
                _entries.TryRemove(new KeyValuePair<Key, GraphCachedValues>(key, entry));
        }
        _entries[KeyOf(accountKey, path, columns, id)] = new GraphCachedValues(json, now);
        return ValueTask.CompletedTask;
    }

    public ValueTask RemoveAccountAsync(string accountKey, CancellationToken ct)
    {
        foreach (var key in _entries.Keys.Where(k => k.Account == accountKey))
            _entries.TryRemove(key, out _);
        return ValueTask.CompletedTask;
    }

    /// <summary>How many entries are held, expired ones not yet swept included.</summary>
    internal int Count => _entries.Count;

    /// <summary>Forgets everything, of every account.</summary>
    public void Clear() => _entries.Clear();
}
