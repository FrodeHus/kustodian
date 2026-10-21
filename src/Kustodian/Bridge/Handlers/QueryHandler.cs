using System.Text.Json;
using System.Text.Json.Nodes;
using Kustodian.Graph.Query;
using Kustodian.Graph.Run;
using Kustodian.Graph.Schema;
using Kustodian.Library;
using Kustodian.Storage;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

namespace Kustodian.Messaging.Handlers;

/// <summary>One Graph run with its parameters, as <see cref="GraphRunner"/> does it.</summary>
public delegate Task<RunResult> GraphRun(string accountKey, string kql, IReadOnlyList<ParameterValue> parameters, bool refresh,
    IProgress<RunEvent>? progress, CancellationToken ct);

/// <summary><c>query.complete</c>, <c>query.explain</c>, <c>query.run</c> and <c>query.cancel</c>. Each tab has at most one
/// run: a new run on a tab cancels the one before, and <c>query.cancel</c> cancels it. A cancelled run answers with the error
/// code <c>cancelled</c>. Every run that finishes is added to <paramref name="recent"/> (when given); a cancelled run is not,
/// and a failure to write Recent is logged and never fails the run. A run's (and an explain's) <c>parameters</c> are a list of
/// <see cref="ParameterValue"/>; fields missing from (or null in) one take their defaults. <c>query.explain</c> describes what
/// a run would send, within <paramref name="limits"/> (<see cref="GraphExplain"/>): it needs no account and sends nothing.</summary>
public sealed class QueryHandler(GraphSchema schema, Func<Task<string?>> activeAccount, GraphRun run, RecentService? recent = null,
    TimeProvider? time = null, ILogger<QueryHandler>? logger = null, GraphLimits? limits = null)
{
    private const string GraphSource = "graph";
    private static readonly ParameterValue DefaultParameter = new("", "text", "", false);

    private readonly TimeProvider _time = time ?? TimeProvider.System;
    private readonly ILogger<QueryHandler> _log = logger ?? NullLogger<QueryHandler>.Instance;
    private readonly GraphLimits _limits = limits ?? GraphLimits.Default;
    private readonly Lock _gate = new();
    private readonly Dictionary<string, CancellationTokenSource> _runs = new(StringComparer.Ordinal);

    public void Register(Bridge bridge)
    {
        // Completion parses and binds the query: CPU work, done off the thread that dispatches messages in order.
        bridge.Register("query.complete", (p, _) =>
        {
            var request = BridgeJson.Params<CompleteParams>(p);
            return Task.Run<object?>(() => Complete(request));
        });
        // Explain plans the query as a run does (CPU work, off the dispatching thread) and stops there.
        bridge.Register("query.explain", (p, _) =>
        {
            var request = ReadWithParameters<ExplainParams>(p);
            return Task.Run<object?>(() => Explain(request));
        });
        bridge.Register("query.run", async (p, ct) => await RunAsync(bridge, ReadWithParameters<RunParams>(p), ct));
        bridge.Register("query.cancel", (p, _) =>
        {
            Cancel(BridgeJson.Params<CancelParams>(p));
            return Task.FromResult<object?>(null);
        });
    }

    private IReadOnlyList<GraphCompletionItem> Complete(CompleteParams p)
    {
        RequireGraph(p.Source);
        if (p.Kql is null || p.Position < 0 || p.Position > p.Kql.Length)
        {
            throw new BridgeException(BridgeErrorCodes.BadRequest, "The completion request needs kql and a position inside it.");
        }

        return GraphCompletion.Complete(schema, p.Kql, p.Position);
    }

    private ExplainView Explain(ExplainParams p)
    {
        RequireGraph(p.Source);
        if (p.Kql is null)
        {
            throw new BridgeException(BridgeErrorCodes.BadRequest, "Explain needs kql.");
        }

        return GraphExplain.Explain(schema, p.Kql, p.Parameters ?? [], _time.GetUtcNow(), _limits);
    }

    private async Task<RunResult> RunAsync(Bridge bridge, RunParams p, CancellationToken closing)
    {
        RequireGraph(p.Source);
        if (string.IsNullOrEmpty(p.TabId) || p.Kql is null)
        {
            throw new BridgeException(BridgeErrorCodes.BadRequest, "A run needs a tabId and kql.");
        }

        // The tab's run is registered before the first await, so runs and cancels on a tab take effect in the order they
        // arrived: a newer run always replaces an older one, and a cancel right after a run finds it.
        var tabId = p.TabId;
        var cts = CancellationTokenSource.CreateLinkedTokenSource(closing);
        CancellationTokenSource? previous;
        lock (_gate)
        {
            _runs.TryGetValue(tabId, out previous);
            _runs[tabId] = cts;
        }

        if (previous is not null)
        {
            CancelRun(previous);
        }

        try
        {
            if (await activeAccount() is not { } account)
            {
                // No run starts, but the answer still names one, as every run's does.
                return new RunResult(RunOutcome.SignInNeeded, GraphRunner.SignInMessage, null, [], [], 0, [], TimeSpan.Zero)
                {
                    RunId = Guid.NewGuid().ToString("D"),
                };
            }

            cts.Token.ThrowIfCancellationRequested();
            var progress = new TabProgress(bridge, tabId);
            var started = _time.GetUtcNow();
            var result = await run(account, p.Kql, p.Parameters ?? [], p.Refresh, progress, cts.Token);
            await RecordAsync(p, started, result);
            return result;
        }
        finally
        {
            lock (_gate)
            {
                if (_runs.TryGetValue(tabId, out var current) && current == cts)
                {
                    _runs.Remove(tabId);
                }
            }

            cts.Dispose();
        }
    }

    /// <summary>Adds a finished run to Recent. Recent is a convenience: if it can't be written, that is logged and the run's
    /// result still goes out.</summary>
    private async Task RecordAsync(RunParams p, DateTimeOffset started, RunResult result)
    {
        if (recent is null)
        {
            return;
        }

        try
        {
            var run = new RecentRun(Guid.NewGuid().ToString("D"), p.Source!, p.Kql!, p.Parameters ?? [],
                started, (long)Math.Round(result.Duration.TotalMilliseconds), result.Total,
                JsonNamingPolicy.CamelCase.ConvertName(result.Outcome.ToString()));
            await recent.AddAsync(run, CancellationToken.None);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _log.LogWarning(ex, "The run could not be added to Recent");
        }
    }

    /// <summary>A <c>query.run</c>'s or <c>query.explain</c>'s params, each parameter's missing fields taken from
    /// <see cref="DefaultParameter"/>. A parameter that isn't an object is a <c>bad_request</c>.</summary>
    private static T ReadWithParameters<T>(JsonElement p)
        where T : class, IHasParameters
    {
        if (p.ValueKind != JsonValueKind.Object)
        {
            return BridgeJson.Params<T>(p);
        }

        var defaults = JsonSerializer.SerializeToNode(DefaultParameter, BridgeJson.Options)!.AsObject();
        var filled = JsonDefaults.FillElements(JsonObject.Create(p)!, nameof(IHasParameters.Parameters), defaults);
        var request = BridgeJson.Params<T>(JsonSerializer.SerializeToElement(filled, BridgeJson.Options));
        if (request.Parameters?.Any(parameter => parameter is null) == true)
        {
            throw new BridgeException(BridgeErrorCodes.BadRequest, "The request's params are not valid.");
        }

        return request;
    }

    private void Cancel(CancelParams p)
    {
        if (string.IsNullOrEmpty(p.TabId))
        {
            throw new BridgeException(BridgeErrorCodes.BadRequest, "A cancel needs a tabId.");
        }

        CancellationTokenSource? cts;
        lock (_gate)
        {
            _runs.TryGetValue(p.TabId, out cts);
        }

        if (cts is not null)
        {
            CancelRun(cts);
        }
    }

    /// <summary>Cancels a run's token. The run may end and dispose it meanwhile; then there is nothing left to cancel.</summary>
    private static void CancelRun(CancellationTokenSource cts)
    {
        try
        {
            cts.Cancel();
        }
        catch (ObjectDisposedException)
        {
            // The run ended first.
        }
    }

    private static void RequireGraph(string? source)
    {
        if (source != GraphSource)
        {
            throw new BridgeException(BridgeErrorCodes.BadRequest, $"Unknown source {source}.");
        }
    }

    /// <summary>Sends each stage as a <c>query.progress</c> event (<c>{tabId, runId, stage, detail}</c>) as it happens, on the
    /// run's own thread, so events keep their order and all go out before the run's answer.</summary>
    private sealed class TabProgress(Bridge bridge, string tabId) : IProgress<RunEvent>
    {
        public void Report(RunEvent value) =>
            bridge.Emit("query.progress", new ProgressData(tabId, value.RunId, value.Stage, value.Detail));
    }

    private sealed record ProgressData(string TabId, string RunId, string Stage, string Detail);

    private sealed record CompleteParams(string? Source, string? Kql, int Position);

    /// <summary>A request that carries query parameters.</summary>
    private interface IHasParameters
    {
        IReadOnlyList<ParameterValue>? Parameters { get; }
    }

    private sealed record RunParams(string? TabId, string? Source, string? Kql, bool Refresh,
        IReadOnlyList<ParameterValue>? Parameters = null) : IHasParameters;

    private sealed record ExplainParams(string? Source, string? Kql, IReadOnlyList<ParameterValue>? Parameters = null) : IHasParameters;

    private sealed record CancelParams(string? TabId);
}
