using System.Text.Json;
using System.Text.Json.Nodes;
using Kustodian.Graph.Query;
using Kustodian.Storage;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

namespace Kustodian.Library;

/// <summary>One finished run, as Recent lists it (spec 6.6): what was run and how it went, but no rows. <see cref="Outcome"/> is
/// the run's outcome as the UI names it (<c>ok</c>, <c>queryError</c>, ...). <see cref="Parameters"/> are the values it ran with,
/// typed, so a run opened again from Recent has them as they were.</summary>
public sealed record RecentRun(string Id, string Source, string Text, IReadOnlyList<ParameterValue> Parameters,
    DateTimeOffset StartedAt, long DurationMs, int Rows, string Outcome);

/// <summary>
/// Owns <c>recent.json</c>, <c>{version:1, runs:[...]}</c>: the last <see cref="Capacity"/> runs, newest first. A run missing a
/// field in the file takes that field's default (<see cref="JsonDefaults.Fill"/>, per run and per parameter), so a missing number
/// is 0 and missing parameters are none. A file that is corrupt, or holds a run of the wrong shape, is moved aside and Recent starts empty.
/// </summary>
public sealed class RecentService(JsonFileStore store, ILogger<RecentService>? logger = null)
{
    public const string FileName = "recent.json";
    public const int Capacity = 100;

    private static readonly RecentRun DefaultRun = new("", "graph", "", [], default, 0, 0, "");
    private static readonly ParameterValue DefaultParameter = new("", "text", "", false);

    private readonly UserDataFile<RecentFile> _file = new(store, FileName, () => new RecentFile(1, []), IsValid);
    private readonly SemaphoreSlim _gate = new(1, 1);
    private readonly ILogger<RecentService> _log = logger ?? NullLogger<RecentService>.Instance;

    /// <summary>The runs, newest first.</summary>
    public async Task<IReadOnlyList<RecentRun>> ListAsync(CancellationToken ct = default)
    {
        await _gate.WaitAsync(ct);
        try
        {
            return await ReadAsync(ct);
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>Puts <paramref name="run"/> first and drops the oldest runs beyond <see cref="Capacity"/>.</summary>
    public async Task AddAsync(RecentRun run, CancellationToken ct = default)
    {
        await _gate.WaitAsync(ct);
        try
        {
            var runs = (await ReadAsync(ct)).Prepend(run).Take(Capacity);
            await WriteAsync(runs, ct);
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task ClearAsync(CancellationToken ct = default)
    {
        await _gate.WaitAsync(ct);
        try
        {
            await WriteAsync([], ct);
        }
        finally
        {
            _gate.Release();
        }
    }

    private async Task<IReadOnlyList<RecentRun>> ReadAsync(CancellationToken ct)
    {
        var read = await _file.ReadAsync(ct);
        if (read.Corrupt)
        {
            _log.LogWarning("{File} could not be read; it was moved aside and Recent starts empty", FileName);
        }

        return read.Value.Runs.Select(node => ToRun(node)!).Take(Capacity).ToList();
    }

    private Task WriteAsync(IEnumerable<RecentRun> runs, CancellationToken ct) =>
        _file.WriteAsync(new RecentFile(1, new JsonArray(runs.Select(r => JsonSerializer.SerializeToNode(r, JsonFileStore.Options))
            .ToArray())), ct);

    private static bool IsValid(RecentFile file) => file.Version == 1 && file.Runs is not null && file.Runs.All(n => ToRun(n) is not null);

    /// <summary>The run in <paramref name="node"/> with missing fields defaulted; null when it isn't an object or a value has
    /// the wrong type.</summary>
    private static RecentRun? ToRun(JsonNode? node)
    {
        if (node is not JsonObject value)
        {
            return null;
        }

        try
        {
            var defaults = JsonSerializer.SerializeToNode(DefaultRun, JsonFileStore.Options)!.AsObject();
            var parameterDefaults = JsonSerializer.SerializeToNode(DefaultParameter, JsonFileStore.Options)!.AsObject();
            var run = JsonDefaults.FillElements(JsonDefaults.Fill(value, defaults), nameof(RecentRun.Parameters), parameterDefaults)
                .Deserialize<RecentRun>(JsonFileStore.Options);
            return run is null || run.Parameters.Any(p => p is null) ? null : run;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private sealed record RecentFile(int Version, JsonArray Runs);
}
