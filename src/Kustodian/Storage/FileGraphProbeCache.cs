using Kustodian.Graph.Fetch;
using Kustodian.Graph.Run;

namespace Kustodian.Storage;

/// <summary>
/// <see cref="IGraphProbeCache"/> in <c>graph-probes.json</c>, <c>{version:1, tables:[{account, path, notListed, denied,
/// foundAt}]}</c>, for <see cref="GraphLimits.ProbeCacheTtl"/> of <paramref name="limits"/> (7 days by default), so a restarted
/// app doesn't probe a table again. The file is read on first use and written on every change; expired tables are dropped as it
/// is written. A file that is corrupt is moved aside and reads as no findings.
/// </summary>
public sealed class FileGraphProbeCache(JsonFileStore store, TimeProvider time, GraphLimits? limits = null) : IGraphProbeCache
{
    public const string FileName = "graph-probes.json";

    private readonly UserDataFile<ProbesFile> _file = new(store, FileName, () => new ProbesFile(1, []), IsValid);
    private readonly SemaphoreSlim _gate = new(1, 1);
    private readonly TimeSpan _ttl = (limits ?? GraphLimits.Default).ProbeCacheTtl;
    private List<ProbedTable>? _tables;

    public async ValueTask<GraphProbeFindings?> GetAsync(string accountKey, string path, CancellationToken ct)
    {
        await _gate.WaitAsync(ct);
        try
        {
            var table = (await TablesAsync(ct)).FirstOrDefault(t => t.Account == accountKey && t.Path == path);
            return table is null || Expired(table) ? null : new GraphProbeFindings(table.NotListed, table.Denied, table.FoundAt);
        }
        finally
        {
            _gate.Release();
        }
    }

    public ValueTask SetAsync(string accountKey, string path, IReadOnlyList<string> notListed, IReadOnlyList<string> denied,
        CancellationToken ct) =>
        ChangeAsync(tables =>
        {
            tables.RemoveAll(t => t.Account == accountKey && t.Path == path);
            if (notListed.Count > 0 || denied.Count > 0)
            {
                tables.Add(new ProbedTable(accountKey, path, [.. notListed], [.. denied], time.GetUtcNow()));
            }
        }, ct);

    public ValueTask RemoveAccountAsync(string accountKey, CancellationToken ct) =>
        ChangeAsync(tables => tables.RemoveAll(t => t.Account == accountKey), ct);

    public ValueTask ClearAsync(CancellationToken ct) => ChangeAsync(tables => tables.Clear(), ct);

    private async ValueTask ChangeAsync(Action<List<ProbedTable>> change, CancellationToken ct)
    {
        await _gate.WaitAsync(ct);
        try
        {
            var tables = await TablesAsync(ct);
            change(tables);
            tables.RemoveAll(Expired);
            await _file.WriteAsync(new ProbesFile(1, [.. tables]), ct);
        }
        finally
        {
            _gate.Release();
        }
    }

    private bool Expired(ProbedTable table) => time.GetUtcNow() - table.FoundAt >= _ttl;

    private async Task<List<ProbedTable>> TablesAsync(CancellationToken ct) =>
        _tables ??= [.. (await _file.ReadAsync(ct)).Value.Tables];

    private static bool IsValid(ProbesFile file) => file.Version == 1 && file.Tables is not null
        && file.Tables.All(t => t is { Account: not null, Path: not null, NotListed: not null, Denied: not null });

    private sealed record ProbedTable(string Account, string Path, IReadOnlyList<string> NotListed, IReadOnlyList<string> Denied,
        DateTimeOffset FoundAt);

    private sealed record ProbesFile(int Version, IReadOnlyList<ProbedTable> Tables);
}
