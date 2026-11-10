using Kustodian.Graph.Query;
using Kustodian.Graph.Run;
using Kustodian.Sources.Arg;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

namespace Kustodian.Sources.Logs;

/// <summary>
/// The <c>logs</c> source: a run on a Log Analytics workspace the user picked, through <see cref="LogsClient"/>. Without a workspace
/// nothing is sent; a workspace the account's own list doesn't have blocks the run (<see cref="WorkspaceCheck"/>). The timespan is
/// the run's option, or one day. Every way a run can fail is an outcome of the <see cref="RunResult"/> (sign-in included); only
/// <see cref="ConsentRequiredException"/> and the caller cancelling are thrown.
/// </summary>
public sealed class LogsQuerySource(LogsClient client, ArmDirectory directory, TimeProvider time, ILogger<LogsQuerySource>? logger = null) : IQuerySource
{
    public const string DefaultTimespan = "P1D";

    private readonly ILogger<LogsQuerySource> _log = logger ?? NullLogger<LogsQuerySource>.Instance;

    public string Name => "logs";

    public async Task<RunResult> RunAsync(QueryRunRequest request, IProgress<RunEvent>? progress, CancellationToken ct)
    {
        var diagnostics = new RunDiagnostics(time, request.RunId);
        var started = time.GetTimestamp();

        RunResult End(RunOutcome outcome, string? message, GraphQueryError? error = null, LogsAnswer? answer = null) =>
            new(outcome, message, error, answer?.Columns ?? [], answer?.Rows ?? [], answer?.Rows.Count ?? 0, [], time.GetElapsedTime(started))
            {
                RunId = diagnostics.RunId,
                Diagnostics = diagnostics.Entries,
                Permissions = outcome == RunOutcome.NoPermission ? [LogsClient.Permission] : [],
            };

        var substitution = ParameterSubstitution.Apply(request.Kql, request.Parameters);
        if (substitution.Missing is { } missing)
        {
            return End(RunOutcome.QueryError, $"Fill in {missing} before running.");
        }

        if (substitution.Error is { } invalid)
        {
            return End(RunOutcome.QueryError, invalid.Message);
        }

        if (request.Options?.Workspaces is not { Count: > 0 } chosen)
        {
            return End(RunOutcome.QueryError, "Pick a workspace before running.");
        }

        try
        {
            var (match, blocked) = await WorkspaceCheck.RunAsync(directory, request.AccountKey, chosen[0], ct);
            if (match is null)
            {
                return End(RunOutcome.WorkspaceUnavailable, blocked);
            }

            progress?.Report(new RunEvent("requesting", $"Running the query in Log Analytics on {(string.IsNullOrEmpty(match.Name) ? WorkspaceCheck.ShortId(match.CustomerId) : match.Name)}", diagnostics.RunId));
            var answer = await client.RunAsync(request.AccountKey, match.CustomerId, substitution.Text!,
                request.Options?.Timespan ?? DefaultTimespan, diagnostics, ct);
            progress?.Report(new RunEvent("done", "Log Analytics answered", diagnostics.RunId));
            if (answer.Outcome == RunOutcome.QueryError && answer is { Line: { } line, Column: { } column })
            {
                var (mappedLine, mappedColumn) = substitution.MapBack(line, column);
                return End(answer.Outcome, answer.Message, new GraphQueryError(mappedLine, mappedColumn, answer.Message ?? ""));
            }

            if (answer is { Outcome: RunOutcome.Ok, PartialError: { } partial })
            {
                diagnostics.Add(new DiagnosticEntry(diagnostics.NowMs, DiagnosticKinds.Warning,
                    $"Log Analytics returned part of the result: {partial}", null, null, null));
            }

            return End(answer.Outcome, answer.Message, answer: answer.Outcome == RunOutcome.Ok ? answer : null);
        }
        catch (Exception ex) when (SourceFailure.Handles(ex, ct))
        {
            var (outcome, message, cause) = SourceFailure.Of(ex, _log, "logs");
            return End(outcome, message) with { Cause = cause };
        }
    }
}
