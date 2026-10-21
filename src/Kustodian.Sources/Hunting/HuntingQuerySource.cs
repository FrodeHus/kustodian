using Kustodian.Graph.Query;
using Kustodian.Graph.Run;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

namespace Kustodian.Sources.Hunting;

/// <summary>
/// The <c>hunting</c> source: a run on Microsoft Defender's advanced hunting through <see cref="HuntingClient"/>. The parameters are
/// substituted as for Graph (<see cref="ParameterSubstitution"/>), and a query error's position is mapped back to the query as
/// written. The timespan is the run's option, or 30 days. Every way a run can fail is an outcome of the <see cref="RunResult"/>
/// (sign-in included); only <see cref="ConsentRequiredException"/> and the caller cancelling are thrown.
/// </summary>
public sealed class HuntingQuerySource(HuntingClient client, TimeProvider time, ILogger<HuntingQuerySource>? logger = null) : IQuerySource
{
    public const string DefaultTimespan = "P30D";

    private readonly ILogger<HuntingQuerySource> _log = logger ?? NullLogger<HuntingQuerySource>.Instance;

    public string Name => "hunting";

    public async Task<RunResult> RunAsync(QueryRunRequest request, IProgress<RunEvent>? progress, CancellationToken ct)
    {
        var diagnostics = new RunDiagnostics(time, request.RunId);
        var started = time.GetTimestamp();

        RunResult End(RunOutcome outcome, string? message, GraphQueryError? error = null, HuntingAnswer? answer = null) =>
            new(outcome, message, error, answer?.Columns ?? [], answer?.Rows ?? [], answer?.Rows.Count ?? 0, [], time.GetElapsedTime(started))
            {
                RunId = diagnostics.RunId,
                Diagnostics = diagnostics.Entries,
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

        try
        {
            progress?.Report(new RunEvent("requesting", "Running the query in Microsoft Defender", diagnostics.RunId));
            var answer = await client.RunAsync(request.AccountKey, substitution.Text!, request.Options?.Timespan ?? DefaultTimespan,
                diagnostics, ct);
            progress?.Report(new RunEvent("done", "Microsoft Defender answered", diagnostics.RunId));
            if (answer.Outcome == RunOutcome.QueryError && answer is { Line: { } line, Column: { } column })
            {
                var (mappedLine, mappedColumn) = substitution.MapBack(line, column);
                return End(answer.Outcome, answer.Message, new GraphQueryError(mappedLine, mappedColumn, answer.Message ?? ""));
            }

            return End(answer.Outcome, answer.Message, answer: answer.Outcome == RunOutcome.Ok ? answer : null);
        }
        catch (Exception ex) when (SourceFailure.Handles(ex, ct))
        {
            var (outcome, message) = SourceFailure.Of(ex, _log, "hunting");
            return End(outcome, message);
        }
    }
}
