using Kustodian.Graph.Fetch;
using Kustodian.Graph.Run;

namespace Kustodian.Storage;

/// <summary>
/// <see cref="IGraphProbeCache"/> in <c>graph-probes.json</c>, <c>{version:1, tables:[{account, path, notListed, denied,
/// foundAt}], defaults:[{account, path, columns, readAt}], refusesTop:[{account, path, foundAt}], refused:[{account, path,
/// clause, foundAt}]}</c>, for <see cref="GraphLimits.ProbeCacheTtl"/> of <paramref name="limits"/> (7 days by default), so a
/// restarted app doesn't probe a table, read its default columns, or send it a <c>$top</c> or another clause it refused, again.
/// A file written before <c>refusesTop</c> or <c>refused</c> existed reads as refusing none.
/// The file is read on first use and written on every change; expired entries are dropped as it is written. A file that is
/// corrupt is moved aside and reads as empty.
/// </summary>
public sealed class FileGraphProbeCache(JsonFileStore store, TimeProvider time, GraphLimits? limits = null) : IGraphProbeCache
{
    public const string FileName = "graph-probes.json";

    private readonly UserDataFile<ProbesFile> _file = new(store, FileName, () => new ProbesFile(1, [], [], [], []), IsValid);
    private readonly SemaphoreSlim _gate = new(1, 1);
    private readonly TimeSpan _ttl = (limits ?? GraphLimits.Default).ProbeCacheTtl;
    private Held? _held;

    public async ValueTask<GraphProbeFindings?> GetAsync(string accountKey, string path, CancellationToken ct)
    {
        var table = await ReadAsync(held => held.Tables.FirstOrDefault(t => t.Account == accountKey && t.Path == path), ct);
        return table is null || Expired(table.FoundAt) ? null : new GraphProbeFindings(table.NotListed, table.Denied, table.FoundAt);
    }

    public ValueTask SetAsync(string accountKey, string path, IReadOnlyList<string> notListed, IReadOnlyList<string> denied,
        CancellationToken ct) =>
        ChangeAsync(held =>
        {
            held.Tables.RemoveAll(t => t.Account == accountKey && t.Path == path);
            if (notListed.Count > 0 || denied.Count > 0)
            {
                held.Tables.Add(new ProbedTable(accountKey, path, [.. notListed], [.. denied], time.GetUtcNow()));
            }
        }, ct);

    public async ValueTask<GraphDefaultColumns?> GetDefaultsAsync(string accountKey, string path, CancellationToken ct)
    {
        var table = await ReadAsync(held => held.Defaults.FirstOrDefault(t => t.Account == accountKey && t.Path == path), ct);
        return table is null || Expired(table.ReadAt) ? null : new GraphDefaultColumns(table.Columns, table.ReadAt);
    }

    public ValueTask SetDefaultsAsync(string accountKey, string path, IReadOnlyList<string> columns, CancellationToken ct) =>
        ChangeAsync(held =>
        {
            held.Defaults.RemoveAll(t => t.Account == accountKey && t.Path == path);
            held.Defaults.Add(new DefaultsTable(accountKey, path, [.. columns], time.GetUtcNow()));
        }, ct);

    public async ValueTask<IReadOnlyDictionary<string, GraphDefaultColumns>> DefaultsOfAsync(string accountKey, CancellationToken ct) =>
        await ReadAsync<IReadOnlyDictionary<string, GraphDefaultColumns>>(held => held.Defaults
            .Where(t => t.Account == accountKey && !Expired(t.ReadAt))
            .ToDictionary(t => t.Path, t => new GraphDefaultColumns(t.Columns, t.ReadAt), StringComparer.Ordinal), ct);

    public async ValueTask<bool> RefusesTopAsync(string accountKey, string path, CancellationToken ct)
    {
        var table = await ReadAsync(held => held.RefusesTop.FirstOrDefault(t => t.Account == accountKey && t.Path == path), ct);
        return table is not null && !Expired(table.FoundAt);
    }

    public ValueTask SetRefusesTopAsync(string accountKey, string path, bool refuses, CancellationToken ct) =>
        ChangeAsync(held =>
        {
            held.RefusesTop.RemoveAll(t => t.Account == accountKey && t.Path == path);
            if (refuses)
                held.RefusesTop.Add(new RefusedTop(accountKey, path, time.GetUtcNow()));
        }, ct);

    public async ValueTask<IReadOnlySet<string>> RefusedAsync(string accountKey, string path, CancellationToken ct) =>
        await ReadAsync<IReadOnlySet<string>>(held => held.Refused
            .Where(t => t.Account == accountKey && t.Path == path && !Expired(t.FoundAt))
            .Select(t => t.Clause)
            .ToHashSet(StringComparer.Ordinal), ct);

    public ValueTask SetRefusedAsync(string accountKey, string path, string clause, bool refused, CancellationToken ct) =>
        ChangeAsync(held =>
        {
            held.Refused.RemoveAll(t => t.Account == accountKey && t.Path == path && t.Clause == clause);
            if (refused)
                held.Refused.Add(new RefusedClause(accountKey, path, clause, time.GetUtcNow()));
        }, ct);

    public ValueTask RemoveAccountAsync(string accountKey, CancellationToken ct) =>
        ChangeAsync(held =>
        {
            held.Refused.RemoveAll(t => t.Account == accountKey);
            held.Tables.RemoveAll(t => t.Account == accountKey);
            held.Defaults.RemoveAll(t => t.Account == accountKey);
            held.RefusesTop.RemoveAll(t => t.Account == accountKey);
        }, ct);

    public ValueTask ClearAsync(CancellationToken ct) =>
        ChangeAsync(held =>
        {
            held.Tables.Clear();
            held.Defaults.Clear();
            held.RefusesTop.Clear();
            held.Refused.Clear();
        }, ct);

    private async Task<T> ReadAsync<T>(Func<Held, T> read, CancellationToken ct)
    {
        await _gate.WaitAsync(ct);
        try
        {
            return read(await HeldAsync(ct));
        }
        finally
        {
            _gate.Release();
        }
    }

    private async ValueTask ChangeAsync(Action<Held> change, CancellationToken ct)
    {
        await _gate.WaitAsync(ct);
        try
        {
            var held = await HeldAsync(ct);
            change(held);
            held.Tables.RemoveAll(t => Expired(t.FoundAt));
            held.Defaults.RemoveAll(t => Expired(t.ReadAt));
            held.RefusesTop.RemoveAll(t => Expired(t.FoundAt));
            held.Refused.RemoveAll(t => Expired(t.FoundAt));
            await _file.WriteAsync(new ProbesFile(1, [.. held.Tables], [.. held.Defaults], [.. held.RefusesTop], [.. held.Refused]), ct);
        }
        finally
        {
            _gate.Release();
        }
    }

    private bool Expired(DateTimeOffset at) => time.GetUtcNow() - at >= _ttl;

    private async Task<Held> HeldAsync(CancellationToken ct)
    {
        if (_held is null)
        {
            var file = (await _file.ReadAsync(ct)).Value;
            _held = new Held([.. file.Tables], [.. file.Defaults], [.. file.RefusesTop ?? []], [.. file.Refused ?? []]);
        }

        return _held;
    }

    private static bool IsValid(ProbesFile file) => file.Version == 1 && file.Tables is not null && file.Defaults is not null
        && file.Tables.All(t => t is { Account: not null, Path: not null, NotListed: not null, Denied: not null })
        && file.Defaults.All(t => t is { Account: not null, Path: not null, Columns: not null })
        && (file.RefusesTop ?? []).All(t => t is { Account: not null, Path: not null })
        && (file.Refused ?? []).All(t => t is { Account: not null, Path: not null, Clause: not null });

    private sealed record Held(List<ProbedTable> Tables, List<DefaultsTable> Defaults, List<RefusedTop> RefusesTop, List<RefusedClause> Refused);

    private sealed record ProbedTable(string Account, string Path, IReadOnlyList<string> NotListed, IReadOnlyList<string> Denied,
        DateTimeOffset FoundAt);

    private sealed record DefaultsTable(string Account, string Path, IReadOnlyList<string> Columns, DateTimeOffset ReadAt);

    private sealed record RefusedTop(string Account, string Path, DateTimeOffset FoundAt);

    private sealed record RefusedClause(string Account, string Path, string Clause, DateTimeOffset FoundAt);

    /// <summary><see cref="RefusesTop"/> and <see cref="Refused"/> are null in a file written before they existed.</summary>
    private sealed record ProbesFile(int Version, IReadOnlyList<ProbedTable> Tables, IReadOnlyList<DefaultsTable> Defaults,
        IReadOnlyList<RefusedTop>? RefusesTop, IReadOnlyList<RefusedClause>? Refused);
}
