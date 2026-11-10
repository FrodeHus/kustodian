using System.Text.Json;
using Kustodian.Graph.Query;
using Kustodian.Graph.Run;
using Microsoft.Extensions.Logging;
using Kustodian.Sources.Arg;
using Microsoft.Extensions.Logging.Abstractions;

namespace Kustodian.Sources.Hunting;

/// <summary>
/// The <c>hunting</c> source: a run on Microsoft Defender's advanced hunting through <see cref="HuntingClient"/>. The parameters are
/// substituted as for Graph (<see cref="ParameterSubstitution"/>), and a query error's position is mapped back to the query as
/// written. The timespan is the run's option, or 30 days. Every way a run can fail is an outcome of the <see cref="RunResult"/>
/// (sign-in included); only <see cref="ConsentRequiredException"/> and the caller cancelling are thrown.
/// </summary>
public sealed class HuntingQuerySource(HuntingClient client, ArmDirectory directory, TimeProvider time, ILogger<HuntingQuerySource>? logger = null) : IQuerySource
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
                Permissions = outcome == RunOutcome.NoPermission ? [HuntingClient.Permission] : [],
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

        var workspace = request.Options?.Workspaces is { Count: > 0 } chosen ? chosen[0] : null;
        try
        {
            // Graph answers from the primary workspace when it can't find the one asked for, so the id is only sent once the
            // account's own list has it.
            if (workspace is not null)
            {
                var visible = await directory.WorkspacesAsync(request.AccountKey, ct);
                if (!visible.Any(w => string.Equals(w.CustomerId, workspace.CustomerId, StringComparison.OrdinalIgnoreCase)))
                {
                    return End(RunOutcome.WorkspaceUnavailable, $"{workspace.Name} isn't available to this account. Pick a workspace.");
                }

                diagnostics.Add(new DiagnosticEntry(diagnostics.NowMs, DiagnosticKinds.Note,
                    $"If Defender can't reach {workspace.Name}, it answers from your primary workspace.", null, null, null));
            }

            progress?.Report(new RunEvent("requesting", "Running the query in Microsoft Defender", diagnostics.RunId));
            var answer = await client.RunAsync(request.AccountKey, substitution.Text!, request.Options?.Timespan ?? DefaultTimespan,
                workspace?.CustomerId, diagnostics, ct);
            progress?.Report(new RunEvent("done", "Microsoft Defender answered", diagnostics.RunId));
            if (answer.Outcome == RunOutcome.QueryError && answer is { Line: { } line, Column: { } column })
            {
                var (mappedLine, mappedColumn) = substitution.MapBack(line, column);
                return End(answer.Outcome, answer.Message, new GraphQueryError(mappedLine, mappedColumn, answer.Message ?? ""));
            }

            if (workspace is not null && answer.Outcome == RunOutcome.Ok && ForeignTenantId(answer, workspace.CustomerId))
            {
                diagnostics.Add(new DiagnosticEntry(diagnostics.NowMs, DiagnosticKinds.Warning,
                    $"Some rows came from another workspace than {workspace.Name}: Defender may have answered from your primary workspace.",
                    null, null, null));
            }

            return End(answer.Outcome, answer.Message, answer: answer.Outcome == RunOutcome.Ok ? answer : null);
        }
        catch (ArmDirectoryException ex)
        {
            return End(RunOutcome.WorkspaceUnavailable, ex.Message);
        }
        catch (Exception ex) when (SourceFailure.Handles(ex, ct))
        {
            var (outcome, message, cause) = SourceFailure.Of(ex, _log, "hunting");
            return End(outcome, message) with { Cause = cause };
        }
    }

    /// <summary>Whether the answer has a string <c>TenantId</c> column with a non-empty value other than
    /// <paramref name="customerId"/> (a workspace's customer id is a GUID: compared ignoring case).</summary>
    private static bool ForeignTenantId(HuntingAnswer answer, string customerId)
    {
        var index = answer.Columns.ToList().FindIndex(c => c.Name == "TenantId");
        return index >= 0 && answer.Rows.Any(r => r[index] is { ValueKind: JsonValueKind.String } v
            && v.GetString() is { Length: > 0 } id && !string.Equals(id, customerId, StringComparison.OrdinalIgnoreCase));
    }
}
