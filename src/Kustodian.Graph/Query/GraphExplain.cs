using Kustodian.Graph.Fetch;
using Kustodian.Graph.Run;
using Kustodian.Graph.Schema;

namespace Kustodian.Graph.Query;

/// <summary>What a run would ask Graph for from one table. <see cref="Url"/> is the first page's URL relative to the Graph
/// version, exactly as the reader sends it (<see cref="GraphCollectionReader.FirstPageUrl"/>); <see cref="Pushed"/> and
/// <see cref="Local"/> are the query's <c>where</c> conditions sent to Graph and run locally (with why);
/// <see cref="PerObject"/> the columns read one object at a time; <see cref="Permissions"/> the least-privileged delegated
/// permissions for listing the table.</summary>
public sealed record ExplainTable(string Table, string Url, IReadOnlyList<string> Select, string? Filter, IReadOnlyList<string> Pushed,
    IReadOnlyList<LocalCondition> Local, IReadOnlyList<string> PerObject, IReadOnlyList<string> Permissions, string DocsUrl);

/// <summary>The limits a run reads within (<see cref="GraphLimits"/>), the fetch budget in megabytes.</summary>
public sealed record ExplainLimits(int ObjectsPerTable, int FetchBudgetMb, int PerObjectReadsPerTable);

/// <summary>What a query would send to Graph, or why it can't run: <see cref="Error"/> (a parse or bind error with its
/// position; line and column are 0 for a parameter that is missing or doesn't fit, which has no position) or
/// <see cref="Refusal"/>. <see cref="Tables"/> is empty unless the query can run.</summary>
public sealed record ExplainView(GraphQueryError? Error, string? Refusal, IReadOnlyList<ExplainTable> Tables, ExplainLimits Limits);

/// <summary>Explain: the same plan a run makes (<see cref="GraphQueryPlanner"/>), described table by table, without
/// sending anything. Pure: no account, no network.</summary>
public static class GraphExplain
{
    private const long BytesPerMegabyte = 1L << 20;

    /// <param name="now">The time to plan for, for <c>now()</c> and <c>ago()</c> in the filter.</param>
    public static ExplainView Explain(GraphSchema schema, string kql, DateTimeOffset now, GraphLimits limits)
    {
        var explained = GraphQueryPlanner.PlanExplained(schema, kql, now);
        var plan = explained.Plan;
        var tables = plan.Fetches.Select((fetch, i) => Describe(fetch, explained.Filters[i])).ToList();
        return new ExplainView(plan.Error, plan.Refusal, tables, Limits(limits));
    }

    /// <summary><see cref="Explain(GraphSchema, string, DateTimeOffset, GraphLimits)"/> with <paramref name="parameters"/>
    /// substituted as a run substitutes them (<see cref="ParameterSubstitution.Apply"/>). An error's position is in
    /// <paramref name="kql"/> as written.</summary>
    public static ExplainView Explain(GraphSchema schema, string kql, IReadOnlyList<ParameterValue> parameters, DateTimeOffset now,
        GraphLimits limits)
    {
        var substitution = ParameterSubstitution.Apply(kql, parameters);
        if (substitution.Missing is { } missing)
            return Failed($"Fill in {missing} to explain this query.", limits);
        if (substitution.Error is { } invalid)
            return Failed(invalid.Message, limits);

        var view = Explain(schema, substitution.Text!, now, limits);
        if (view.Error is not { } error)
            return view;
        var (line, column) = substitution.MapBack(error.Line, error.Column);
        return view with { Error = error with { Line = line, Column = column } };
    }

    private static ExplainView Failed(string message, GraphLimits limits) =>
        new(new GraphQueryError(0, 0, message), null, [], Limits(limits));

    private static ExplainTable Describe(GraphFetch fetch, FilterExplanation filter)
    {
        var table = fetch.Table;
        return new ExplainTable(table.Name, GraphCollectionReader.FirstPageUrl(table.Path, fetch.Select, fetch.Filter), fetch.Select,
            fetch.Filter, filter.Pushed, filter.Local, fetch.Unreadable, table.Permissions, table.DocsUrl);
    }

    private static ExplainLimits Limits(GraphLimits limits) =>
        new(limits.ObjectsPerTable, (int)(limits.FetchBudgetBytes / BytesPerMegabyte), limits.PerObjectReadsPerTable);
}
