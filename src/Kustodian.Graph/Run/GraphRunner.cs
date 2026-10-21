using System.Globalization;
using System.Text.Json.Nodes;
using Kustodian.Graph.Engine;
using Kustodian.Graph.Fetch;
using Kustodian.Graph.Query;
using Kustodian.Graph.Schema;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

namespace Kustodian.Graph.Run;

/// <summary>
/// One run from KQL to rows: plan the query, read every fetch of the plan in parallel under one lease on the fetch budget, then
/// run the KQL unchanged on an engine worker over those tables only. The lease is held until the engine has answered, as the
/// fetched objects stay in memory until then. Every way a run can fail is an outcome of the <see cref="RunResult"/>, never an
/// exception, except that the caller cancelling throws <see cref="OperationCanceledException"/>. Each run has an id and a
/// diagnostics log (<see cref="RunDiagnostics"/>): every request it sends carries the log, the readers add their steps, the
/// engine its worker events, and the result and every progress event carry the id.
/// </summary>
public sealed class GraphRunner(GraphSchema schema, GraphCollectionReader reader, GraphFetchBudget budget, GraphEnginePool engine,
    GraphLimits limits, TimeProvider time, ILogger<GraphRunner>? logger = null)
{
    /// <summary>The limits this runner runs within. The engine sends back at most <see cref="GraphLimits.RowsPerRun"/> rows;
    /// <see cref="RunResult.Total"/> counts them all.</summary>
    public GraphLimits Limits => limits;
    private readonly ILogger<GraphRunner> _log = logger ?? NullLogger<GraphRunner>.Instance;
    public const string SignInMessage = "Sign in again to run this query.";
    public const string Unexpected = "The query couldn't be run because of an unexpected error. Try again.";
    private const long BytesPerMegabyte = 1L << 20;

    /// <summary>A collection read that failed, with the fetch it was for.</summary>
    private sealed class FetchFailedException(GraphFetch fetch, Exception error) : Exception(error.Message, error)
    {
        public GraphFetch Fetch { get; } = fetch;
    }

    public Task<RunResult> RunAsync(string accountKey, string kql, bool refresh, IProgress<RunEvent>? progress, CancellationToken ct)
        => RunAsync(accountKey, kql, [], refresh, progress, ct);

    /// <summary>A run of <paramref name="kql"/> with its <paramref name="parameters"/> substituted
    /// (<see cref="ParameterSubstitution.Apply"/>). A required parameter without a value, or a value that isn't of its type, is
    /// a <see cref="RunOutcome.QueryError"/> without a position; a query error's position is in <paramref name="kql"/> as
    /// written, not in the substituted text.</summary>
    public Task<RunResult> RunAsync(string accountKey, string kql, IReadOnlyList<ParameterValue> parameters, bool refresh,
        IProgress<RunEvent>? progress, CancellationToken ct)
        => RunAsync(accountKey, kql, parameters, refresh, null, progress, ct);

    /// <summary>As <see cref="RunAsync(string, string, IReadOnlyList{ParameterValue}, bool, IProgress{RunEvent}?, CancellationToken)"/>,
    /// named <paramref name="runId"/> when that is a GUID in <c>D</c> format (<see cref="RunDiagnostics.IsRunId"/>), otherwise
    /// with a new id.</summary>
    public async Task<RunResult> RunAsync(string accountKey, string kql, IReadOnlyList<ParameterValue> parameters, bool refresh,
        string? runId, IProgress<RunEvent>? progress, CancellationToken ct)
    {
        var diagnostics = new RunDiagnostics(time, runId);
        var substitution = ParameterSubstitution.Apply(kql, parameters);
        if (substitution.Missing is { } missing)
            return new RunResult(RunOutcome.QueryError, $"Fill in {missing} before running.", null, [], [], 0, [], TimeSpan.Zero)
                { RunId = diagnostics.RunId };
        if (substitution.Error is { } invalid)
            return new RunResult(RunOutcome.QueryError, invalid.Message, null, [], [], 0, [], TimeSpan.Zero) { RunId = diagnostics.RunId };
        return await RunSubstitutedAsync(accountKey, substitution.Text!, substitution.MapBack, refresh,
            progress is null ? null : new StampedProgress(progress, diagnostics.RunId), diagnostics, ct);
    }

    /// <summary>The run of a query whose parameters are substituted; <paramref name="mapBack"/> maps a position in it to the
    /// query as written.</summary>
    private async Task<RunResult> RunSubstitutedAsync(string accountKey, string kql, Func<int, int, (int Line, int Column)> mapBack,
        bool refresh, IProgress<RunEvent>? progress, RunDiagnostics diagnostics, CancellationToken ct)
    {
        var started = time.GetTimestamp();
        var now = time.GetUtcNow();
        IReadOnlyList<GraphFetch> fetches = [];
        GraphCollection?[] collections = [];
        GraphFetch? failed = null;
        IReadOnlyList<string> failedRequests = [];

        RunResult End(RunOutcome outcome, string? message = null, GraphQueryError? error = null, EngineResponse? answer = null)
        {
            var tables = fetches.Select((f, i) => (Fetch: f, Read: collections[i])).Where(x => x.Read is not null)
                .Select(x => Describe(x.Fetch.Table.Name, x.Read!)).ToList();
            if (failed is not null)
                tables.Add(new TableFetch(failed.Table.Name, failedRequests, false, [], [], [], 0, false, 0));
            return new RunResult(outcome, message, error, answer?.Columns ?? [], answer?.Rows ?? [], answer?.Total ?? 0, tables,
                time.GetElapsedTime(started), answer?.DroppedValues ?? 0)
            {
                RunId = diagnostics.RunId,
                Diagnostics = diagnostics.Entries,
            };
        }

        try
        {
            progress?.Report(new RunEvent("planning", "Planning the query"));
            var plan = GraphQueryPlanner.Plan(schema, kql, now);
            if (plan.Error is { } error)
            {
                var (line, column) = mapBack(error.Line, error.Column);
                return End(RunOutcome.QueryError, error.Message, error with { Line = line, Column = column });
            }
            if (plan.Refusal is { } refusal)
                return End(RunOutcome.Refused, refusal);
            fetches = plan.Fetches;
            collections = new GraphCollection?[fetches.Count];

            // One lease for the whole run, held until the engine has answered.
            using var lease = budget.Lease();
            await FetchAsync(accountKey, fetches, lease, collections, refresh, progress, diagnostics, ct);
            ReportReads(fetches, collections, progress);

            progress?.Report(new RunEvent("engine", "Running the query"));
            var tables = fetches.Select((f, i) => Table(f.Table, collections[i]!.Objects)).ToList();
            var answer = await engine.RunAsync(new EngineRequest(kql, now, tables, limits.RowsPerRun), diagnostics.RunId,
                new EngineLog(diagnostics), ct);
            if (answer.Error is { } engineError)
                return End(RunOutcome.Failed, engineError);
            if (answer.Refusal is { } engineRefusal)
                return End(RunOutcome.Refused, engineRefusal);
            return End(RunOutcome.Ok, answer: answer);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw;
        }
        catch (FetchFailedException ex)
        {
            failed = ex.Fetch;
            if (ex.InnerException is GraphReadException read)
                failedRequests = read.Requests;
            var (outcome, message) = IsSignIn(ex.InnerException) ? (RunOutcome.SignInNeeded, SignInMessage) : ReadFailure(ex);
            return End(outcome, message);
        }
        catch (GraphEngineException ex)
        {
            return ex.Failure switch
            {
                GraphEngineFailure.TimedOut => End(RunOutcome.EngineTimeout, string.Create(CultureInfo.InvariantCulture,
                    $"The query took longer than {(long)Math.Ceiling(engine.Options.Timeout.TotalSeconds)} s and was stopped.")),
                GraphEngineFailure.OutOfMemory => End(RunOutcome.EngineMemory, string.Create(CultureInfo.InvariantCulture,
                    $"The query used more than {engine.Options.MemoryLimitBytes / BytesPerMegabyte} MB and was stopped.")),
                _ => End(RunOutcome.Failed, ex.Message),
            };
        }
        catch (Exception ex)
        {
            if (IsSignIn(ex))
                return End(RunOutcome.SignInNeeded, SignInMessage);
            // The reason is logged, not shown.
            _log.LogError(ex, "A Graph query failed unexpectedly");
            return End(RunOutcome.Failed, Unexpected);
        }
    }

    private (RunOutcome Outcome, string Message) ReadFailure(FetchFailedException ex)
    {
        var table = ex.Fetch.Table;
        if (ex.InnerException is not GraphReadException read)
            return (RunOutcome.Failed, Unexpected);
        return read.Failure switch
        {
            GraphReadFailure.NoPermission => (RunOutcome.NoPermission, NoPermissionMessage(table)),
            GraphReadFailure.Throttled => (RunOutcome.Throttled, read.RetryAfterSeconds is { } seconds
                ? string.Create(CultureInfo.InvariantCulture, $"Graph is throttling requests. Try again in {seconds} s.")
                : read.Message),
            GraphReadFailure.TooLarge => (RunOutcome.TooLarge,
                $"Too much data from {table.Name} for one run ({(budget.MaxBytes / BytesPerMegabyte).ToString(CultureInfo.InvariantCulture)} MB). "
                + "Add a filter or project fewer columns."),
            // The object cap's own text says what to do: add a `where` Graph can filter on.
            GraphReadFailure.TooManyObjects => (RunOutcome.TooLarge, read.Message),
            _ => (RunOutcome.Failed, read.Message),
        };
    }

    /// <summary>Any one of the table's permissions will do; read permissions (<c>*.Read*</c> without <c>Write</c>) are named
    /// first, as the least a user needs to ask for.</summary>
    private static string NoPermissionMessage(GraphTable table)
        => table.Permissions.Count > 0
            ? $"You don't have permission to read {table.Name}. It needs one of: {string.Join(", ", ReadFirst(table.Permissions))}."
            : $"You don't have permission to read {table.Name}. {table.DocsUrl}";

    /// <summary><paramref name="permissions"/> with the read-only ones first, otherwise in their order.</summary>
    private static IEnumerable<string> ReadFirst(IEnumerable<string> permissions)
        => permissions.OrderBy(p => IsReadOnly(p) ? 0 : 1);

    private static bool IsReadOnly(string permission)
        => permission.Contains(".Read", StringComparison.Ordinal) && !permission.Contains("Write", StringComparison.Ordinal);

    /// <summary>Whether the failure is, or was caused by, the account needing to sign in again.</summary>
    private static bool IsSignIn(Exception? ex) => SignInRequiredException.IsIn(ex) || ex switch
    {
        GraphReadException { Failure: GraphReadFailure.SignInNeeded } => true,
        AggregateException aggregate => aggregate.InnerExceptions.Any(IsSignIn),
        { InnerException: { } inner } => IsSignIn(inner),
        _ => false,
    };

    /// <summary>Reads the plan's collections in parallel under the run's lease. The first read that fails stops the others and
    /// is thrown as a <see cref="FetchFailedException"/>.</summary>
    private async Task FetchAsync(string accountKey, IReadOnlyList<GraphFetch> fetches, GraphFetchLease lease, GraphCollection?[] collections,
        bool refresh, IProgress<RunEvent>? progress, RunDiagnostics diagnostics, CancellationToken ct)
    {
        using var siblings = CancellationTokenSource.CreateLinkedTokenSource(ct);
        FetchFailedException? first = null;
        var reads = fetches.Select(async (fetch, i) =>
        {
            progress?.Report(new RunEvent("fetching", fetch.Table.Name));
            try
            {
                collections[i] = await reader.ReadAsync(accountKey, fetch, lease, refresh, diagnostics, siblings.Token);
            }
            catch (Exception ex) when (!(ex is OperationCanceledException && siblings.IsCancellationRequested))
            {
                Interlocked.CompareExchange(ref first, new FetchFailedException(fetch, ex), null);
                await siblings.CancelAsync();
            }
        }).ToList();
        try
        {
            await Task.WhenAll(reads);
        }
        catch (OperationCanceledException) when (first is not null && !ct.IsCancellationRequested)
        {
            // A sibling cancelled after the first failure: that failure is the answer.
        }
        if (first is not null)
            throw first;
        ct.ThrowIfCancellationRequested();
    }

    /// <summary>What the reads did beyond reading, as stages: columns Graph wouldn't serve in a list (found by probing), then
    /// columns read one object at a time.</summary>
    private static void ReportReads(IReadOnlyList<GraphFetch> fetches, GraphCollection?[] collections, IProgress<RunEvent>? progress)
    {
        if (progress is null)
            return;
        for (var i = 0; i < fetches.Count; i++)
        {
            var probed = collections[i]!.Unreadable.Except(fetches[i].Unreadable, StringComparer.Ordinal).Concat(collections[i]!.Denied).ToList();
            if (probed.Count > 0)
                progress.Report(new RunEvent("probing", $"{fetches[i].Table.Name}: {string.Join(", ", probed)}"));
        }
        for (var i = 0; i < fetches.Count; i++)
        {
            if (collections[i]!.PerObject.Count > 0)
                progress.Report(new RunEvent("per-object", $"{fetches[i].Table.Name}: {string.Join(", ", collections[i]!.PerObject)}"));
        }
    }

    /// <summary>Progress events with the run's id.</summary>
    private sealed class StampedProgress(IProgress<RunEvent> inner, string runId) : IProgress<RunEvent>
    {
        public void Report(RunEvent value) => inner.Report(value with { RunId = runId });
    }

    /// <summary>The engine's worker events as <see cref="DiagnosticKinds.Engine"/> entries; the answer or kill carries the time
    /// since the start.</summary>
    private sealed class EngineLog(RunDiagnostics diagnostics) : IProgress<EngineRunInfo>
    {
        private long? _startedMs;

        public void Report(EngineRunInfo value)
        {
            var now = diagnostics.NowMs;
            if (value.Event == "start")
                _startedMs = now;
            var worker = value.WorkerPid.ToString(CultureInfo.InvariantCulture);
            var detail = value.Event switch
            {
                "start" => $"worker {worker} started",
                "done" when value.PeakBytes is { } peak
                    => $"worker {worker} answered, peak {(peak / BytesPerMegabyte).ToString(CultureInfo.InvariantCulture)} MB",
                "done" => $"worker {worker} answered",
                _ => $"worker {worker} killed: {value.Reason}",
            };
            diagnostics.Add(new DiagnosticEntry(now, DiagnosticKinds.Engine, detail, null, value.Event == "start" ? null : now - _startedMs, null));
        }
    }

    private static TableFetch Describe(string table, GraphCollection read)
        => new(table, read.Requests, read.Unfiltered, read.Unreadable, read.Denied, read.PerObject, read.PerObjectFailed,
            read.PerObjectCapped, read.PerObjectCached);

    /// <summary>The table as the engine loads it: every column of the schema's table, so it is the table the editor shows.</summary>
    private static EngineTable Table(GraphTable table, IReadOnlyList<JsonObject> rows)
        => new(table.Name, table.Columns.Select(c => new EngineColumn(c.Name, c.Type)).ToList(), rows);
}
