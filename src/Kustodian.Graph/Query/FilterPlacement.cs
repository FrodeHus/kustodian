using Kustodian.Graph.Schema;
using Kusto.Language;
using Kusto.Language.Editor;
using Kusto.Language.Symbols;
using Kusto.Language.Syntax;

namespace Kustodian.Graph.Query;

/// <summary>Where a smart filter's <c>| where</c> line goes in a query: the 0-based offset of the end of a syntax node (its
/// trivia excluded), after which the line is inserted.</summary>
public static class FilterPlacement
{
    /// <summary>For Graph (<paramref name="graph"/> non-null), when <paramref name="column"/> is a result column that is one of
    /// a table's own columns, the table is read once, it is the source of the query's outermost pipe chain, and every operator
    /// on that chain keeps rows as they are (<see cref="KeepsRows"/>): after that table's leading <c>where</c> operators (or its reference
    /// when there are none), so the condition is pushed down to Graph and a later <c>take</c> still limits the read.
    /// Otherwise: the end of the last statement's expression, before any trailing <c>take</c>, <c>limit</c> and
    /// <c>render</c>. Null when the text has no query expression.</summary>
    public static int? Offset(string kql, string column, GraphSchema? graph)
    {
        var code = graph is null ? KustoCode.Parse(kql) : KustoCode.ParseAndAnalyze(kql, GraphGlobals.Plain(graph));
        if (code.Kind != CodeKinds.Query || GraphQueryPlanner.Answer(code.Syntax) is not { } answer)
            return null;

        if (graph is not null && Leading(code, answer, column) is { } leading)
            return leading.End;

        SyntaxNode node = answer;
        while (node is PipeExpression { Operator: TakeOperator or RenderOperator } pipe)
            node = pipe.Expression;
        return node.End;
    }

    /// <summary>The last leading <c>where</c> pipe on the table <paramref name="column"/> comes from, or the table's
    /// reference; null when the column is not a table's own, the table is read more than once, or it isn't the source of
    /// <paramref name="answer"/>'s pipe chain through operators that only keep rows.</summary>
    private static SyntaxNode? Leading(KustoCode code, Expression answer, string column)
    {
        if (code.ResultType is not TableSymbol result || result.Columns.FirstOrDefault(c => c.Name == column) is not { } symbol)
            return null;
        var uses = GraphQueryPlanner.TableUses(code).Where(u => u.Table.Columns.Any(c => ReferenceEquals(c, symbol))).ToList();
        if (uses.Count == 0 || GraphQueryPlanner.LeadingPredicates(code, uses[0].Table) is not { } predicates)
            return null;

        SyntaxNode source = answer;
        while (source is PipeExpression pipe)
        {
            if (!KeepsRows(pipe.Operator))
                return null;
            source = pipe.Expression;
        }
        if (!ReferenceEquals(source, uses[0].Node))
            return null;
        return predicates.Count > 0 ? predicates[^1].GetFirstAncestor<PipeExpression>() : uses[0].Node;
    }

    /// <summary>Operators a <c>where</c> on the table's own columns may move ahead of without changing which rows are kept: they
    /// filter, reshape columns, sort or cut a sorted list short. <c>top</c>, <c>summarize</c>, <c>join</c> and the rest pick rows
    /// from the whole input.</summary>
    private static bool KeepsRows(QueryOperator op) => op is FilterOperator or ProjectOperator or ProjectAwayOperator
        or ProjectKeepOperator or ProjectRenameOperator or ExtendOperator or SortOperator or TakeOperator or RenderOperator;
}
