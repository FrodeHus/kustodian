using System.Collections.Concurrent;

namespace Kustodian.Graph.Fetch;

/// <summary>
/// <see cref="IGraphObjectCache"/> in the process's memory, for <paramref name="ttl"/> (30 minutes by default) after Graph sent
/// the values. An entry is one object of one table of one account, for one set of columns (in any order).
/// </summary>
public sealed class MemoryGraphObjectCache(TimeProvider time, TimeSpan? ttl = null) : IGraphObjectCache
{
    private readonly record struct Key(string Account, string Path, string Columns, string Id);

    private readonly ConcurrentDictionary<Key, GraphCachedValues> _entries = new();
    private readonly TimeSpan _ttl = ttl ?? TimeSpan.FromMinutes(30);

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
        _entries[KeyOf(accountKey, path, columns, id)] = new GraphCachedValues(json, time.GetUtcNow());
        return ValueTask.CompletedTask;
    }

    public ValueTask RemoveAccountAsync(string accountKey, CancellationToken ct)
    {
        foreach (var key in _entries.Keys.Where(k => k.Account == accountKey))
            _entries.TryRemove(key, out _);
        return ValueTask.CompletedTask;
    }

    /// <summary>Forgets everything, of every account.</summary>
    public void Clear() => _entries.Clear();
}
