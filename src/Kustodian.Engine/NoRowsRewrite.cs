using Kusto.Language;
using Kusto.Language.Symbols;
using Kusto.Language.Syntax;

namespace Kustodian.Engine;

/// <summary>Rewrites the two operators KustoLoco 1.5.0 gets wrong when they read no columns, into equivalents that do.
/// <list type="bullet">
/// <item><c>where</c> on a condition that reads no column (<c>where false</c>): KustoLoco drops every chunk, and putting
/// the result together then fails with "Sequence contains no elements". It becomes <c>extend k = (condition) | where k
/// | project-away k</c>.</item>
/// <item><c>project</c> of expressions that read no column (<c>project x = 'none'</c>): KustoLoco makes one row per chunk,
/// even an empty one, so no rows become one. It becomes <c>extend x = 'none' | project x</c>.</item>
/// </list>
/// Both are equivalent in Kusto, so a needless rewrite costs only time. A name that doesn't bind (a column of a table the
/// request doesn't carry) counts as a column, and the operator stays.</summary>
internal static class NoRowsRewrite
{
    public static string Rewrite(string kql, IEnumerable<TableSymbol> tables)
    {
        var globals = GlobalState.Default.WithDatabase(new DatabaseSymbol("tables", tables.Cast<Symbol>().ToArray()));
        var condition = FreshName(kql);
        // One operator per pass: a rewritten one reads a column, so it isn't found again, and nested ones keep their spans.
        while (true)
        {
            var code = KustoCode.ParseAndAnalyze(kql, globals);
            var target = code.Syntax.GetDescendants<QueryOperator>(o => Replacement(o, condition) is not null).FirstOrDefault();
            if (target is null)
                return kql;
            kql = kql[..target.TextStart] + Replacement(target, condition) + kql[target.End..];
        }
    }

    private static string? Replacement(QueryOperator op, string condition) => op switch
    {
        FilterOperator { Parameters.Count: 0 } where when ReadsNoColumn(where.Condition) =>
            $"extend {condition} = ({where.Condition}) | where {condition} | project-away {condition}",
        ProjectOperator project when project.Expressions.Count > 0
            && project.ResultType is TableSymbol result && result.Columns.Count == project.Expressions.Count
            && project.Expressions.All(e => e.Element is not CompoundNamedExpression && ReadsNoColumn(e.Element)) =>
            "extend " + string.Join(", ", project.Expressions.Select((e, i) =>
                $"{Quote(result.Columns[i].Name)} = {(e.Element is SimpleNamedExpression named ? named.Expression : e.Element)}"))
            + " | project " + string.Join(", ", result.Columns.Select(c => Quote(c.Name))),
        _ => null,
    };

    private static bool ReadsNoColumn(Expression expression) =>
        !expression.GetDescendantsOrSelf<StarExpression>().Any()
        && expression.GetDescendantsOrSelf<NameReference>().All(n => n.ReferencedSymbol is not (null or ColumnSymbol or ErrorSymbol));

    private static string Quote(string name) => $"['{name.Replace("\\", "\\\\", StringComparison.Ordinal).Replace("'", "\\'", StringComparison.Ordinal)}']";

    /// <summary>A column name the query doesn't use.</summary>
    private static string FreshName(string kql)
    {
        var name = "kustodian_condition";
        for (var i = 1; kql.Contains(name, StringComparison.Ordinal); i++)
            name = $"kustodian_condition{i}";
        return name;
    }
}
