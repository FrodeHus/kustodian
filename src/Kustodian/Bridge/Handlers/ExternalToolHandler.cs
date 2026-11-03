using System.Text.Json;
using Kustodian.ExternalTools;

namespace Kustodian.Messaging.Handlers;

/// <summary><c>tools.list</c> answers <c>{tools, problem, path}</c>; <c>tools.edit</c> opens <c>tools.json</c> in an editor;
/// <c>tools.run</c> takes <c>{runId, name, columns, rows}</c> and answers <c>{outcomes}</c>, sending <c>tools.progress</c>
/// (<c>{runId, done, total}</c>) after each row; <c>tools.cancel</c> takes <c>{runId}</c> and stops that run, which answers with
/// the error code <c>cancelled</c>. A tool that can't run is a <c>bad_request</c> whose message says why.</summary>
public sealed class ExternalToolHandler(ExternalToolService tools)
{
    private readonly Lock _gate = new();
    private readonly Dictionary<string, CancellationTokenSource> _runs = new(StringComparer.Ordinal);

    public void Register(Bridge bridge)
    {
        bridge.Register("tools.list", async (_, ct) => await tools.ListAsync(ct));
        bridge.Register("tools.edit", async (_, ct) =>
        {
            await Rejected(async () =>
            {
                await tools.EditAsync(ct);
                return 0;
            });
            return null;
        });
        bridge.Register("tools.run", async (p, ct) => await RunAsync(bridge, BridgeJson.Params<RunParams>(p), ct));
        bridge.Register("tools.cancel", (p, _) =>
        {
            CancellationTokenSource? cts;
            lock (_gate)
            {
                _runs.TryGetValue(BridgeJson.Params<CancelParams>(p).RunId ?? "", out cts);
            }

            try
            {
                cts?.Cancel();
            }
            catch (ObjectDisposedException)
            {
                // The run ended first.
            }

            return Task.FromResult<object?>(null);
        });
    }

    private async Task<object?> RunAsync(Bridge bridge, RunParams p, CancellationToken closing)
    {
        if (string.IsNullOrEmpty(p.RunId) || p.Name is null || p.Columns is null || p.Rows is null
            || p.Rows.Any(r => r is null || r.Length != p.Columns.Length))
        {
            throw new BridgeException(BridgeErrorCodes.BadRequest, "A run needs a runId, a tool name, columns and rows.");
        }

        var runId = p.RunId;
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(closing);
        lock (_gate)
        {
            _runs[runId] = cts;
        }

        try
        {
            return await Rejected(async () => new RunAnswer(await tools.RunAsync(p.Name, p.Columns, p.Rows,
                done => bridge.Emit("tools.progress", new Progress(runId, done, p.Rows.Length)), cts.Token)));
        }
        finally
        {
            lock (_gate)
            {
                _runs.Remove(runId);
            }
        }
    }

    private static async Task<object?> Rejected<T>(Func<Task<T>> action)
    {
        try
        {
            return await action();
        }
        catch (ToolRejectedException ex)
        {
            throw new BridgeException(BridgeErrorCodes.BadRequest, ex.Message);
        }
    }

    private sealed record RunParams(string? RunId, string? Name, string[]? Columns, JsonElement[][]? Rows);

    private sealed record CancelParams(string? RunId);

    private sealed record RunAnswer(IReadOnlyList<ToolOutcome> Outcomes);

    private sealed record Progress(string RunId, int Done, int Total);
}
