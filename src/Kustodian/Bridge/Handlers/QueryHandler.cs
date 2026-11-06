using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Kustodian.Graph.Engine;
using Kustodian.Graph.Fetch;
using Kustodian.Graph.Query;
using Kustodian.Graph.Run;
using Kustodian.Graph.Schema;
using Kustodian.Library;
using Kustodian.Sources;
using Kustodian.Storage;
using Kustodian.Telemetry;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

namespace Kustodian.Messaging.Handlers;

/// <summary><c>query.complete</c>, <c>query.explain</c>, <c>query.run</c> and <c>query.cancel</c>. A run goes to the source
/// its <c>source</c> names in <paramref name="sources"/> (an unknown one is a <c>bad_request</c>), with its <c>options</c>
/// (<see cref="QueryOptions"/>; options that aren't valid are a <c>bad_request</c> and nothing runs). Each tab has at most one
/// run: a new run on a tab cancels the one before, and <c>query.cancel</c> cancels it. A cancelled run answers with the error
/// code <c>cancelled</c>. Every run that finishes is added to <paramref name="recent"/> (when given), unless its <c>addToRecent</c> is
/// false (default true; workbook widgets pass false); a cancelled run is not, and a failure to write Recent is logged and never fails the run. A run's (and an explain's) <c>parameters</c> are a list of
/// <see cref="ParameterValue"/>; fields missing from (or null in) one take their defaults, and so do those of its options. A
/// run's optional <c>runId</c> names it (progress events and the answer carry it) when it is a GUID in <c>D</c> format;
/// otherwise the host names it. <c>query.explain</c> describes what a Graph run would send, within <paramref name="limits"/>
/// (<see cref="GraphExplain"/>): it sends nothing but, with the active account's tenant licenses (<paramref name="licenses"/>,
    /// read once per account), leaves out what they lack, as a run does. Explain and completion are Graph's only: for another
/// source they are a <c>bad_request</c>. A run whose source meets a <see cref="ConsentRequiredException"/> (an ARM token that needs
/// the user) answers <see cref="RunOutcome.ConsentNeeded"/> with its message; the account stays signed in. With a
/// <paramref name="reporter"/>, every run that doesn't end <see cref="RunOutcome.Ok"/> (nor cancelled) gets a report ID; it is
/// reported when the run failed unexpectedly (<see cref="RunResult.Cause"/>). The <paramref name="trail"/> hears
/// <c>run.start(&lt;source&gt;)</c> and <c>run.end(&lt;outcome&gt;)</c>.</summary>
public sealed class QueryHandler(GraphSchema schema, Func<Task<string?>> activeAccount, IReadOnlyDictionary<string, IQuerySource> sources,
    RecentService? recent = null, TimeProvider? time = null, ILogger<QueryHandler>? logger = null, GraphLimits? limits = null,
    ITenantLicenses? licenses = null, ErrorReporter? reporter = null, ErrorTrail? trail = null)
{
    private const string GraphSource = "graph";
    private const string ExplainRefused = "Explain is only available for Microsoft Graph.";
    private const string CompletionRefused = "Completion comes from the editor for this source.";
    private const long BytesPerMegabyte = 1L << 20;
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
        bridge.Register("query.explain", (p, ct) =>
        {
            var request = ReadWithParameters<ExplainParams>(p);
            return Task.Run<object?>(async () => Explain(request, await LicenseGateAsync(ct)));
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
        RequireGraph(p.Source, CompletionRefused);
        if (p.Kql is null || p.Position < 0 || p.Position > p.Kql.Length)
        {
            throw new BridgeException(BridgeErrorCodes.BadRequest, "The completion request needs kql and a position inside it.");
        }

        return GraphCompletion.Complete(schema, p.Kql, p.Position);
    }

    /// <summary>What the active account's tenant licenses leave out, or null when nobody is signed in or they aren't read.</summary>
    private async Task<GraphLicenseGate?> LicenseGateAsync(CancellationToken ct) =>
        licenses is not null && await activeAccount() is { } account
            ? new GraphLicenseGate(GraphLicenses.Bundled, await licenses.GetAsync(account, false, ct))
            : null;

    private ExplainView Explain(ExplainParams p, GraphLicenseGate? gate)
    {
        RequireGraph(p.Source, ExplainRefused);
        if (p.Kql is null)
        {
            throw new BridgeException(BridgeErrorCodes.BadRequest, "Explain needs kql.");
        }

        return GraphExplain.Explain(schema, p.Kql, p.Parameters ?? [], _time.GetUtcNow(), _limits, gate);
    }

    private async Task<RunResult> RunAsync(Bridge bridge, RunParams p, CancellationToken closing)
    {
        if (p.Source is null || !sources.TryGetValue(p.Source, out var source))
        {
            throw new BridgeException(BridgeErrorCodes.BadRequest, $"Unknown source {p.Source}.");
        }

        if (string.IsNullOrEmpty(p.TabId) || p.Kql is null)
        {
            throw new BridgeException(BridgeErrorCodes.BadRequest, "A run needs a tabId and kql.");
        }

        if (QueryOptions.Problem(p.Options) is { } problem)
        {
            throw new BridgeException(BridgeErrorCodes.BadRequest, problem);
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
                return Reported(p, new RunResult(RunOutcome.SignInNeeded, GraphRunner.SignInMessage, null, [], [], 0, [], TimeSpan.Zero)
                {
                    RunId = new RunDiagnostics(_time, p.RunId).RunId,
                });
            }

            cts.Token.ThrowIfCancellationRequested();
            trail?.Add($"run.start({p.Source})");
            var progress = new TabProgress(bridge, tabId);
            var started = _time.GetUtcNow();
            var request = new QueryRunRequest(account, p.Kql, p.Parameters ?? [], p.Refresh, p.RunId, p.Options);
            RunResult result;
            try
            {
                result = await source.RunAsync(request, progress, cts.Token);
            }
            catch (Exception ex) when (ConsentRequiredException.FindIn(ex) is { } consent)
            {
                // The account is still signed in: the UI offers to grant access (account.consent) and runs again.
                result = new RunResult(RunOutcome.ConsentNeeded, consent.Message, null, [], [], 0, [], _time.GetUtcNow() - started)
                {
                    RunId = new RunDiagnostics(_time, p.RunId).RunId,
                };
            }

            trail?.Add($"run.end({JsonNamingPolicy.CamelCase.ConvertName(result.Outcome.ToString())})");
            await RecordAsync(p, started, result);
            return Reported(p, result);
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
        if (recent is null || !p.AddToRecent)
        {
            return;
        }

        try
        {
            var run = new RecentRun(Guid.NewGuid().ToString("D"), p.Source!, p.Kql!, p.Parameters ?? [],
                started, (long)Math.Round(result.Duration.TotalMilliseconds), result.Total,
                JsonNamingPolicy.CamelCase.ConvertName(result.Outcome.ToString()), p.Options);
            await recent.AddAsync(run, CancellationToken.None);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _log.LogWarning(ex, "The run could not be added to Recent");
        }
    }

    /// <summary><paramref name="result"/> with its report ID, when it isn't <see cref="RunOutcome.Ok"/> and there is a reporter.
    /// The query, its parameters, the exception, Graph's answer and the engine's stderr go into the full report only; the
    /// automatic report gets the scrubbed exception (the worker's own, when it wrote a crash frame) and the engine's numbers.</summary>
    private RunResult Reported(RunParams p, RunResult result)
    {
        if (reporter is null || result.Outcome == RunOutcome.Ok)
        {
            return result;
        }

        var engine = result.Cause as GraphEngineException;
        List<FullReportSection> details = [new("query", "Query", p.Kql ?? "", true)];
        if (p.Parameters is { Count: > 0 } parameters)
        {
            details.Add(new FullReportSection("parameters", "Parameters",
                string.Join('\n', parameters.Select(v => $"{v.Name} ({v.Type}) = {v.Value}")), false));
        }

        if (result.Message is { } message)
        {
            details.Add(new FullReportSection("message", "Message", message, false));
        }

        if (result.Cause is { } cause)
        {
            details.Add(new FullReportSection("exception", "Exception", cause.ToString() + CrashText(engine?.Crash), false));
        }

        if (result.ReadFailure is { } read)
        {
            var text = new StringBuilder().AppendLine(CultureInfo.InvariantCulture,
                $"{read.Table}: {read.Failure}, status {read.Status?.ToString(CultureInfo.InvariantCulture) ?? "none"}, code {read.Code ?? "none"}");
            foreach (var request in result.Tables.Where(t => t.Table == read.Table).SelectMany(t => t.Requests))
            {
                text.AppendLine(request);
            }

            if (read.Body is { Length: > 0 } body)
            {
                text.AppendLine().AppendLine(body);
            }

            details.Add(new FullReportSection("graphError", "Graph error", text.ToString().TrimEnd(), false));
        }

        if (engine is { StderrTail.Count: > 0 })
        {
            details.Add(new FullReportSection("engineStderr", "Engine output", string.Join('\n', engine.StderrTail), false));
        }

        var unexpected = result.Cause is not null;
        var kind = engine is { Failure: GraphEngineFailure.Crashed } ? "engine.crash"
            : unexpected ? "run.failed"
            : $"run.{JsonNamingPolicy.CamelCase.ConvertName(result.Outcome.ToString())}";
        var exceptions = engine?.Crash is { } crash ? ErrorScrubber.Of(crash)
            : result.Cause is { } thrown ? ErrorScrubber.Of(thrown)
            : [];
        var facts = new ErrorFacts(Source: p.Source, ExitCode: engine?.ExitCode,
            PeakMemoryMb: engine?.PeakBytes is { } peak ? (int)(peak / BytesPerMegabyte) : null,
            WorkerUptimeS: engine?.WorkerUptime is { } uptime ? (int)uptime.TotalSeconds : null);
        return result with { ReportId = reporter.Capture(new ErrorCapture(kind, unexpected, exceptions, facts, details)) };
    }

    /// <summary>The worker's crash frame as text, after the host's own exception: each exception's type, message and frames.</summary>
    private static string CrashText(EngineCrash? crash)
    {
        if (crash is null)
        {
            return "";
        }

        var text = new StringBuilder().AppendLine().AppendLine().AppendLine("The engine worker's crash:");
        foreach (var e in crash.Exceptions)
        {
            text.AppendLine(CultureInfo.InvariantCulture, $"{e.TypeName}: {e.Message}");
            foreach (var f in e.Frames)
            {
                text.AppendLine(CultureInfo.InvariantCulture, $"  at {f.Method} ({f.Assembly})");
            }
        }

        return text.ToString().TrimEnd();
    }

    /// <summary>A <c>query.run</c>'s or <c>query.explain</c>'s params, each parameter's missing fields taken from
    /// <see cref="DefaultParameter"/>, and the options' from theirs (<see cref="QueryOptionsDefaults"/>). A parameter that isn't
    /// an object, or options with a null among their ids, are a <c>bad_request</c>.</summary>
    private static T ReadWithParameters<T>(JsonElement p)
        where T : class, IHasParameters
    {
        if (p.ValueKind != JsonValueKind.Object)
        {
            return BridgeJson.Params<T>(p);
        }

        var defaults = JsonSerializer.SerializeToNode(DefaultParameter, BridgeJson.Options)!.AsObject();
        var filled = QueryOptionsDefaults.Fill(
            JsonDefaults.FillElements(JsonObject.Create(p)!, nameof(IHasParameters.Parameters), defaults), BridgeJson.Options);
        var request = BridgeJson.Params<T>(JsonSerializer.SerializeToElement(filled, BridgeJson.Options));
        if (request.Parameters?.Any(parameter => parameter is null) == true
            || (request is RunParams run && !QueryOptionsDefaults.IsComplete(run.Options)))
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

    /// <summary>Explain and completion are Graph's: another known source is refused with <paramref name="refusal"/>.</summary>
    private void RequireGraph(string? source, string refusal)
    {
        if (source != GraphSource)
        {
            throw new BridgeException(BridgeErrorCodes.BadRequest,
                source is not null && sources.ContainsKey(source) ? refusal : $"Unknown source {source}.");
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
        IReadOnlyList<ParameterValue>? Parameters = null, string? RunId = null, QueryOptions? Options = null, bool AddToRecent = true) : IHasParameters;

    private sealed record ExplainParams(string? Source, string? Kql, IReadOnlyList<ParameterValue>? Parameters = null) : IHasParameters;

    private sealed record CancelParams(string? TabId);
}
