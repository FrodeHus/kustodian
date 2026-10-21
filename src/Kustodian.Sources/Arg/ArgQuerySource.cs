using Kustodian.Graph.Query;
using Kustodian.Graph.Run;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

namespace Kustodian.Sources.Arg;

/// <summary>
/// The <c>arg</c> source: a run on Azure Resource Graph through <see cref="ArgClient"/>, reading at most
/// <paramref name="rowsPerRun"/> rows (the <c>ArgRowsPerRun</c> setting the app started with). The parameters are substituted as
/// for Graph (<see cref="ParameterSubstitution"/>), and a query error's position is mapped back to the query as written. The scope
/// is the run's option, or "all I can see". Every way a run can fail is an outcome of the <see cref="RunResult"/> (an ARM sign-in
/// included, ruling 2); only <see cref="ConsentRequiredException"/> and the caller cancelling are thrown.
/// </summary>
public sealed class ArgQuerySource(ArgClient client, int rowsPerRun, TimeProvider time, ILogger<ArgQuerySource>? logger = null) : IQuerySource
{
    private readonly ILogger<ArgQuerySource> _log = logger ?? NullLogger<ArgQuerySource>.Instance;

    public string Name => "arg";

    public async Task<RunResult> RunAsync(QueryRunRequest request, IProgress<RunEvent>? progress, CancellationToken ct)
    {
        var diagnostics = new RunDiagnostics(time, request.RunId);
        var started = time.GetTimestamp();

        RunResult End(RunOutcome outcome, string? message, GraphQueryError? error = null, ArgAnswer? answer = null) =>
            new(outcome, message, error, answer?.Columns ?? [], answer?.Rows ?? [], answer?.Total ?? 0, [], time.GetElapsedTime(started))
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
            progress?.Report(new RunEvent("requesting", "Running the query in Azure Resource Graph", diagnostics.RunId));
            var answer = await client.RunAsync(request.AccountKey, substitution.Text!, request.Options?.Scope ?? ArgScope.Default,
                rowsPerRun, diagnostics, ct, page => progress?.Report(new RunEvent("paging",
                    $"Reading page {page + 1} from Azure Resource Graph", diagnostics.RunId)));
            progress?.Report(new RunEvent("done", "Azure Resource Graph answered", diagnostics.RunId));
            if (answer.Outcome == RunOutcome.QueryError && answer is { Line: { } line, Column: { } column })
            {
                var (mappedLine, mappedColumn) = substitution.MapBack(line, column);
                return End(answer.Outcome, answer.Message, new GraphQueryError(mappedLine, mappedColumn, answer.Message ?? ""));
            }

            return End(answer.Outcome, answer.Message, answer: answer.Outcome == RunOutcome.Ok ? answer : null);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex) when (SignInRequiredException.IsIn(ex) && ConsentRequiredException.FindIn(ex) is null)
        {
            return End(RunOutcome.SignInNeeded, GraphRunner.SignInMessage);
        }
        catch (Exception ex) when (ConsentRequiredException.FindIn(ex) is null)
        {
            // The reason is logged, not shown.
            _log.LogError(ex, "A Resource Graph query failed unexpectedly");
            return End(RunOutcome.Failed, GraphRunner.Unexpected);
        }
    }
}
