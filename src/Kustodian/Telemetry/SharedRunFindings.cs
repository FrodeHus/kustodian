using System.Collections.Concurrent;
using System.Globalization;
using Kustodian.Graph.Engine;
using Kustodian.Graph.Fetch;
using Kustodian.Graph.Query;
using Kustodian.Graph.Run;
using Kustodian.Graph.Schema;

namespace Kustodian.Telemetry;

/// <summary>
/// Shares, when the user opted in (<paramref name="sharing"/>), what a Graph run found out about Graph or about Kustodian's
/// limits, as one event each:
/// <list type="bullet">
/// <item><c>GraphRefusal</c>: Graph refused a table read with a client error Kustodian couldn't work around (not a permission,
/// sign-in or throttling answer): the HTTP status and Graph's <c>error.code</c>, never its message, which can quote values.</item>
/// <item><c>GraphPushdownMiss</c>: a <c>where</c> condition ran locally instead of in <c>$filter</c>: the reason's code
/// (<see cref="PushdownReasons.Code"/>) and the column, when it is one of the table's schema columns. Not for a later
/// <c>where</c> (<c>notLeading</c>) or a column left out for its license, which describes the tenant.</item>
/// <item><c>GraphPermissionMismatch</c>: Graph refused a table for permission although the account's token holds one of the
/// permissions the schema lists for it: that permission.</item>
/// <item><c>GraphLimitHit</c>: a run hit one of Kustodian's limits: which one, and its value in the user's settings.</item>
/// </list>
/// Every event names the table by its schema path; none holds the account, the tenant, a query, a value or a row. Each event is
/// sent once per app session, and the send doesn't hold up the run.
/// </summary>
public sealed class SharedRunFindings(GraphSchema schema, GraphLimits limits, GraphEngineOptions engine,
    Func<CancellationToken, Task<bool>> sharing, AppInsightsTelemetry telemetry,
    Func<string, CancellationToken, Task<IReadOnlyList<string>>> scopesOf)
{
    public const string RefusalEvent = "GraphRefusal";
    public const string PushdownEvent = "GraphPushdownMiss";
    public const string PermissionEvent = "GraphPermissionMismatch";
    public const string LimitEvent = "GraphLimitHit";
    private const long BytesPerMegabyte = 1L << 20;

    private readonly ConcurrentDictionary<string, byte> _sent = new(StringComparer.Ordinal);

    /// <summary>Shares what <paramref name="result"/>, a run for <paramref name="accountKey"/>, found.</summary>
    public async Task ShareAsync(string accountKey, RunResult result, CancellationToken ct)
    {
        if (!telemetry.Configured || !await sharing(ct))
            return;
        var scopes = result is { Outcome: RunOutcome.NoPermission, ReadFailure.Failure: GraphReadFailure.NoPermission }
            ? await scopesOf(accountKey, ct)
            : [];
        foreach (var (name, properties) in Findings(result, scopes))
        {
            var key = name + "|" + string.Join("|", properties.OrderBy(p => p.Key, StringComparer.Ordinal).Select(p => p.Key + "=" + p.Value));
            // Not awaited: a slow or unreachable ingestion endpoint mustn't hold up the query. The send never throws.
            if (_sent.TryAdd(key, 0))
                _ = telemetry.TrackEventAsync(name, properties, CancellationToken.None);
        }
    }

    private IEnumerable<(string Name, Dictionary<string, string> Properties)> Findings(RunResult result, IReadOnlyList<string> scopes)
    {
        if (result.ReadFailure is { } failure && schema.Find(failure.Table) is { } failed)
        {
            if (failure is { Failure: GraphReadFailure.Failed or GraphReadFailure.NotFound, Status: >= 400 and < 500 and not (401 or 403 or 429) })
            {
                var properties = Properties(failed, ("status", failure.Status.Value.ToString(CultureInfo.InvariantCulture)));
                if (failure.Code is { } code)
                    properties["code"] = code;
                yield return (RefusalEvent, properties);
            }
            if (failure.Failure == GraphReadFailure.NoPermission
                && result.Permissions.FirstOrDefault(p => scopes.Contains(p, StringComparer.OrdinalIgnoreCase)) is { } held)
                yield return (PermissionEvent, Properties(failed, ("permission", held)));
            if (failure.Failure == GraphReadFailure.TooManyObjects)
                yield return Limit(failed, "objectsPerTable", limits.ObjectsPerTable);
            if (failure.Failure == GraphReadFailure.TooLarge)
                yield return Limit(failed, "fetchBudgetMb", limits.FetchBudgetBytes / BytesPerMegabyte);
        }

        var tables = result.Tables.Select(t => schema.Find(t.Table)).OfType<GraphTable>().DistinctBy(t => t.Path).ToList();
        var paths = string.Join(",", tables.Select(t => t.Path).Order(StringComparer.Ordinal));
        if (paths.Length > 0)
        {
            if (result.Outcome == RunOutcome.EngineTimeout)
                yield return (LimitEvent, Limit("engineTimeoutSeconds", (long)engine.Timeout.TotalSeconds, paths));
            if (result.Outcome == RunOutcome.EngineMemory)
                yield return (LimitEvent, Limit("engineHeapMb", engine.MemoryLimitBytes / BytesPerMegabyte, paths));
            if (result.Outcome == RunOutcome.Ok && result.Total > result.Rows.Count)
                yield return (LimitEvent, Limit("rowsPerRun", limits.RowsPerRun, paths));
        }

        foreach (var fetch in result.Tables)
        {
            if (schema.Find(fetch.Table) is not { } table)
                continue;
            foreach (var local in fetch.Local)
            {
                if (PushdownReasons.Code(local.Reason) is not { Code: not ("notLeading" or "singleObject" or "unlicensed") } reason)
                    continue;
                var properties = Properties(table, ("reason", reason.Code));
                if (reason.Column is { } column && table.Columns.Any(c => c.Name == column))
                    properties["column"] = column;
                yield return (PushdownEvent, properties);
            }
            if (fetch.PerObjectCapped)
                yield return Limit(table, "perObjectReadsPerTable", limits.PerObjectReadsPerTable);
            foreach (var relationship in fetch.Relationships)
            {
                if (relationship.Capped)
                    yield return Limit(table, "relationshipObjectsPerTable", limits.RelationshipObjectsPerTable, relationship.Column);
                if (relationship.Truncated > 0)
                    yield return Limit(table, "relationshipEntriesPerObject", limits.RelationshipEntriesPerObject, relationship.Column);
            }
        }
    }

    private static Dictionary<string, string> Properties(GraphTable table, params (string Key, string Value)[] more)
    {
        var properties = new Dictionary<string, string>(StringComparer.Ordinal) { ["path"] = table.Path };
        foreach (var (key, value) in more)
            properties[key] = value;
        return properties;
    }

    private static (string, Dictionary<string, string>) Limit(GraphTable table, string limit, long value, string? column = null)
    {
        var properties = Properties(table, ("limit", limit), ("value", value.ToString(CultureInfo.InvariantCulture)));
        if (column is not null && table.Columns.Any(c => c.Name == column))
            properties["column"] = column;
        return (LimitEvent, properties);
    }

    /// <summary>A limit of the whole run: the paths of every table it read.</summary>
    private static Dictionary<string, string> Limit(string limit, long value, string paths) => new(StringComparer.Ordinal)
    {
        ["path"] = paths,
        ["limit"] = limit,
        ["value"] = value.ToString(CultureInfo.InvariantCulture),
    };
}
