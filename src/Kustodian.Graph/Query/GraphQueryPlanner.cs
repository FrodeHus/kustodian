using Kustodian.Graph.Schema;
using Kusto.Language;
using Kusto.Language.Editor;
using Kusto.Language.Symbols;
using Kusto.Language.Syntax;

namespace Kustodian.Graph.Query;

/// <summary>What a query needs from Graph, or why it can't run: a parse or bind error (with its position), or a refusal
/// (it reaches outside the Graph tables).</summary>
public sealed record GraphQueryPlan(IReadOnlyList<GraphFetch> Fetches, GraphQueryError? Error, string? Refusal)
{
    public bool CanRun => Error is null && Refusal is null;
}

/// <summary>One table to fetch: the properties to <c>$select</c> (always explicit, always with <c>id</c>) and the
/// <c>$filter</c> pushed down, if any. <see cref="Unreadable"/> are the columns the query names that a list never returns
/// (not listable): left out of the <c>$select</c> and read one object at a time instead. <see cref="Named"/> are the table's
/// columns the query names itself (not those it only passes through): only those are ever read one object at a time.
/// <see cref="Top"/> is the most rows the query takes from the table, when nothing runs locally before its <c>take</c>: the
/// reader asks Graph for no more and stops once it has them. <see cref="Clauses"/> are the <c>$filter</c>'s conjuncts (empty
/// when it was built by hand: then <see cref="Filter"/> is one clause). <see cref="OrderBy"/> is the sort the query takes its
/// <see cref="Top"/> rows by (<c>sort by x desc | take n</c>, <c>top n by x</c>), sent as <c>$orderby</c>. <see cref="Count"/>
/// is the result column's name when the whole query counts the table's rows after pushed filters only, and Graph keeps exactly
/// the rows the query keeps: the reader then asks Graph for the count instead of the rows.</summary>
public sealed record GraphFetch(GraphTable Table, IReadOnlyList<string> Select, string? Filter)
{
    public IReadOnlyList<string> Unreadable { get; init; } = [];
    public IReadOnlyList<string> Named { get; init; } = [];
    public int? Top { get; init; }
    public IReadOnlyList<FilterClause> Clauses { get; init; } = [];
    public GraphOrderBy? OrderBy { get; init; }
    public string? Count { get; init; }

    /// <summary>Some of the query's <c>where</c> conditions on the table run locally, after the read: they are not (all) in the
    /// <c>$filter</c>, or the table is read more than once. Rows Graph returns then may not all reach the result, which matters
    /// to a column read one object at a time.</summary>
    public bool FilteredLocally { get; init; }

    /// <summary>The columns the query touches that are left out because the tenant lacks their license
    /// (<see cref="GraphLicenseGate"/>): not selected, not read one object at a time, and no condition or sort on them is sent.
    /// Their values are empty.</summary>
    public IReadOnlyList<GraphLicenseGap> LicenseLeftOut { get; init; } = [];

    /// <summary>The license the table needs and the tenant lacks: a run stops before reading anything.</summary>
    public GraphLicenseRequirement? MissingLicense { get; init; }

    /// <summary>The <c>$filter</c>'s conjuncts: <see cref="Clauses"/>, or <see cref="Filter"/> as one.</summary>
    public IReadOnlyList<FilterClause> FilterClauses => Clauses.Count > 0 ? Clauses : Filter is { } filter ? [new FilterClause(filter)] : [];
}

/// <summary>A sort sent as <c>$orderby</c>: a datetime or number column, descending (KQL's default, nulls last) or ascending
/// with nulls last. Graph's order is checked on what it returns: rows out of order, or a null, mean the read starts again
/// without it.</summary>
public sealed record GraphOrderBy(string Column, bool Descending)
{
    public string OData => Column + (Descending ? " desc" : " asc");
}

/// <summary>A parse or bind error at a 1-based line and column.</summary>
public sealed record GraphQueryError(int Line, int Column, string Message);

/// <summary>A plan and, for each of its fetches in order, how its <c>$filter</c> came about (for Explain).</summary>
internal sealed record ExplainedPlan(GraphQueryPlan Plan, IReadOnlyList<FilterExplanation> Filters);

/// <summary>Reads a query with Kusto.Language against the Graph schema and works out which tables and columns it touches.
/// Pure: nothing is fetched.</summary>
public static class GraphQueryPlanner
{
    private const string OnlyGraphTables = "Only Graph tables can be queried.";

    /// <summary>The <c>evaluate</c> plugins that only reshape rows already there. Every other plugin is refused: some load
    /// data from outside (<c>sql_request</c>, <c>http_request</c>), some run code (<c>python</c>, <c>r</c>).</summary>
    private static readonly HashSet<string> AllowedPlugins = new(StringComparer.Ordinal) { "bag_unpack", "narrow", "pivot" };

    /// <param name="now">The run's time, for <c>now()</c> and <c>ago()</c> in a pushed-down filter.</param>
    /// <param name="licenses">What the tenant's licenses leave out (<see cref="GraphLicenseGate"/>); without it, nothing.</param>
    public static GraphQueryPlan Plan(GraphSchema schema, string kql, DateTimeOffset now, GraphLicenseGate? licenses = null)
        => PlanExplained(schema, kql, now, licenses).Plan;

    /// <summary>The plan with, for each of its fetches (in the same order), how its <c>$filter</c> came about: the leading
    /// <c>where</c> conditions pushed and kept local (<see cref="GraphFilterTranslator.Explain"/>), then every later
    /// <c>where</c> on the table's pipe as local (<see cref="PushdownReasons.NotLeading"/>).</summary>
    internal static ExplainedPlan PlanExplained(GraphSchema schema, string kql, DateTimeOffset now, GraphLicenseGate? licenses = null)
    {
        var globals = GraphGlobals.Plain(schema);
        var code = KustoCode.ParseAndAnalyze(kql, globals);

        // Refusals come before errors: an attempt to reach outside the Graph tables is refused (and audited) even when it
        // doesn't bind, for example a plugin Kusto.Language doesn't know.
        if (Refusal(code) is { } refusal)
            return new ExplainedPlan(new GraphQueryPlan([], null, refusal), []);

        // Structural errors before bind errors: an unknown database or cluster would otherwise show as Kusto's "not found".
        if (StructureError(code.Syntax) is { } structure)
        {
            var (line, column) = Position(kql, structure.Node.TextStart);
            return new ExplainedPlan(new GraphQueryPlan([], new GraphQueryError(line, column, structure.Message), null), []);
        }

        if (code.GetDiagnostics().Where(d => d.Severity == DiagnosticSeverity.Error).OrderBy(d => d.Start).FirstOrDefault() is { } error)
        {
            var (line, column) = Position(kql, error.Start);
            return new ExplainedPlan(new GraphQueryPlan([], new GraphQueryError(line, column, error.Message), null), []);
        }

        var databaseTables = globals.Database.Tables.ToHashSet<TableSymbol>(ReferenceEqualityComparer.Instance);
        var tableSymbols = TableUses(code)
            .Select(u => u.Table)
            .Where(databaseTables.Contains)
            .Distinct(ReferenceEqualityComparer.Instance)
            .Cast<TableSymbol>()
            .ToList();

        var references = code.Syntax.GetDescendants<NameReference>();
        var columnRefs = references.Select(r => r.ReferencedSymbol).OfType<ColumnSymbol>().ToHashSet();
        var names = references.Select(r => r.SimpleName).ToHashSet(StringComparer.Ordinal);
        // What the query names itself, before the columns it only passes through are added.
        var namedRefs = columnRefs.ToHashSet();
        var namedNames = names.ToHashSet(StringComparer.Ordinal);
        // Columns the result passes through without the query naming them (no project): those have to be fetched too. A
        // union's output columns are new symbols, so their names count as well.
        if (code.ResultType is TableSymbol result)
        {
            columnRefs.UnionWith(result.Columns);
            names.UnionWith(result.Columns.Select(c => c.Name));
        }

        var everyColumn = UsesColumnsImplicitly(code.Syntax);

        var fetches = new List<GraphFetch>();
        var filters = new List<FilterExplanation>();
        foreach (var symbol in tableSymbols)
        {
            if (schema.Find(symbol.Name) is not { } table)
                continue;
            // A join's `on appId` resolves to neither side's column symbol, so names count too. Over-fetching a column is
            // cheap; missing one silently empties it. A column a list never returns is never selected (Graph would refuse
            // the request); when the query names it, the reader reads it one object at a time instead.
            var getOnly = table.Columns.Where(c => !c.Listable).Select(c => c.Name).ToHashSet(StringComparer.Ordinal);
            // A column whose license the tenant lacks is never read: Graph would refuse the list, or send it empty.
            var unlicensed = licenses?.MissingColumns(table) ?? new Dictionary<string, GraphLicenseRequirement>();
            var leftOut = symbol.Columns
                .Where(c => unlicensed.ContainsKey(c.Name))
                .Where(c => everyColumn || columnRefs.Contains(c) || names.Contains(c.Name))
                .Select(c => new GraphLicenseGap(c.Name, unlicensed[c.Name]))
                .ToList();
            var select = symbol.Columns
                .Where(c => !getOnly.Contains(c.Name) && !unlicensed.ContainsKey(c.Name))
                .Where(c => everyColumn || columnRefs.Contains(c) || names.Contains(c.Name))
                .Select(c => c.Name)
                .Append("id")
                .Distinct(StringComparer.Ordinal)
                .ToList();
            var named = symbol.Columns
                .Where(c => !unlicensed.ContainsKey(c.Name))
                .Where(c => namedRefs.Contains(c) || namedNames.Contains(c.Name))
                .Select(c => c.Name)
                .ToList();
            var unreadable = named.Where(getOnly.Contains).ToList();
            var licenseNames = unlicensed.ToDictionary(p => p.Key, p => p.Value.License, StringComparer.Ordinal);
            // A table read more than once (a self-join) is never filtered: one fetch has to serve every use.
            var explanation = LeadingPredicates(code, symbol) is { } predicates
                ? GraphFilterTranslator.Explain(table, predicates, now, schema.ComplexTypes, licenseNames)
                : new FilterExplanation(null, [], []);
            var later = LaterPredicates(code, symbol)
                .Select(p => new LocalCondition(GraphFilterTranslator.Text(p), PushdownReasons.NotLeading));
            var local = explanation with { Local = [.. explanation.Local, .. later] };
            filters.Add(local);
            // A self-join's wheres are all in `later` (the table gets no pushdown), so they count here too.
            var filteredLocally = local.Local.Count > 0;
            // Only when every leading where went to Graph whole: a condition kept local would have to see rows past the limit.
            var (top, orderBy) = explanation.Local.Count == 0 ? RowLimit(code, symbol, table) : (null, null);
            // A sort on a column that isn't read can't pick Graph's first rows.
            if (orderBy is not null && unlicensed.ContainsKey(orderBy.Column))
                (top, orderBy) = (null, null);
            // Only when Graph keeps exactly the query's rows, and the count is the query's whole answer.
            var count = explanation.Exact && tableSymbols.Count == 1 ? CountColumn(code, symbol) : null;
            fetches.Add(new GraphFetch(table, select, explanation.Filter)
            {
                Unreadable = unreadable, Named = named, Top = top, OrderBy = orderBy, Clauses = explanation.Clauses, Count = count,
                LicenseLeftOut = leftOut, MissingLicense = licenses?.MissingFor(table), FilteredLocally = filteredLocally,
            });
        }
        return new ExplainedPlan(new GraphQueryPlan(fetches, null, null), filters);
    }

    /// <summary>The conditions of the <c>where</c> operators on <paramref name="table"/>'s pipe that
    /// <see cref="LeadingPredicates"/> doesn't return: those after another operator, and, when the table is used more than
    /// once, all of them. Each where's whole condition, in the order written.</summary>
    internal static IReadOnlyList<Expression> LaterPredicates(KustoCode code, TableSymbol table)
    {
        var uses = TableUses(code).Where(u => ReferenceEquals(u.Table, table)).ToList();
        var predicates = new List<Expression>();
        foreach (var use in uses)
        {
            var leading = uses.Count == 1;
            SyntaxNode node = use.Node;
            while (node.Parent is PipeExpression pipe && ReferenceEquals(pipe.Expression, node))
            {
                if (pipe.Operator is FilterOperator where)
                {
                    if (!leading)
                        predicates.Add(where.Condition);
                }
                else
                {
                    leading = false;
                }
                node = pipe;
            }
        }
        return predicates;
    }

    /// <summary>The predicates of the <c>where</c> operators directly after <paramref name="table"/>'s reference, before any
    /// other operator: what <c>$filter</c> may narrow the fetch by. Null when the table is used more than once (a self-join:
    /// one fetch serves every use, so none can be narrowed) or not at all; empty when another operator comes first.</summary>
    internal static IReadOnlyList<Expression>? LeadingPredicates(KustoCode code, TableSymbol table)
    {
        var uses = TableUses(code).Where(u => ReferenceEquals(u.Table, table)).ToList();
        if (uses.Count != 1)
            return null;

        var predicates = new List<Expression>();
        SyntaxNode node = uses[0].Node;
        while (node.Parent is PipeExpression pipe && ReferenceEquals(pipe.Expression, node) && pipe.Operator is FilterOperator where)
        {
            predicates.Add(where.Condition);
            node = pipe;
        }
        return predicates;
    }

    /// <summary>The <c>take</c> or <c>limit</c> of a fixed number of rows directly after <paramref name="table"/>'s reference and
    /// its leading <c>where</c> operators, if any: the most rows the query reads from the table. Also a <c>sort</c> by one
    /// column followed by such a <c>take</c>, or a <c>top</c>, when Graph can be asked for the same order
    /// (<see cref="SortOf"/>): then the sort comes with it. Null when the table is used more than once, any other operator
    /// comes first, or the count isn't a positive literal. Whether those wheres all went to Graph is the caller's to check.</summary>
    internal static (int? Top, GraphOrderBy? OrderBy) RowLimit(KustoCode code, TableSymbol table, GraphTable? graphTable = null)
    {
        var uses = TableUses(code).Where(u => ReferenceEquals(u.Table, table)).ToList();
        if (uses.Count != 1)
            return (null, null);

        SyntaxNode node = uses[0].Node;
        GraphOrderBy? sorted = null;
        while (node.Parent is PipeExpression pipe && ReferenceEquals(pipe.Expression, node))
        {
            switch (pipe.Operator)
            {
                case FilterOperator when sorted is null:
                    node = pipe;
                    continue;
                case TakeOperator take when Count(take.Expression) is { } count:
                    return (count, sorted);
                case SortOperator { Expressions.Count: 1 } sort when sorted is null && graphTable is not null
                    && SortOf(sort.Expressions[0].Element, graphTable, descendingByDefault: true) is { } order:
                    sorted = order;
                    node = pipe;
                    continue;
                case TopOperator top when sorted is null && graphTable is not null && Count(top.Expression) is { } count
                    && SortOf(top.ByExpression, graphTable, descendingByDefault: true) is { } order:
                    return (count, order);
                default:
                    return (null, null);
            }
        }
        return (null, null);
    }

    private static int? Count(Expression expression) => expression switch
    {
        LiteralExpression { LiteralValue: long count } when count is > 0 and <= int.MaxValue => (int)count,
        LiteralExpression { LiteralValue: int count } when count > 0 => count,
        _ => null,
    };

    /// <summary>The sort Graph can be asked for: one datetime or number column of the table (text isn't, as Graph's order of
    /// text isn't KQL's), descending with nulls last (KQL's default for both) or ascending with nulls last written out. KQL
    /// puts nulls first when ascending, which Graph isn't known to do.</summary>
    private static GraphOrderBy? SortOf(Expression expression, GraphTable table, bool descendingByDefault)
    {
        var (column, ordering) = expression is OrderedExpression ordered ? (ordered.Expression, ordered.Ordering) : (expression, null);
        if (column is not NameReference { ReferencedSymbol: ColumnSymbol symbol }
            || table.Columns.FirstOrDefault(c => c.Name == symbol.Name) is not { Collection: false, Type: "datetime" or "int" or "long" or "real" } graphColumn)
            return null;
        var direction = ordering?.AscOrDescKeyword?.Text;
        var descending = direction switch
        {
            "desc" => true,
            "asc" => false,
            _ => descendingByDefault,
        };
        var nulls = ordering?.NullsClause?.FirstOrLastKeyword?.Text;
        var nullsLast = nulls switch
        {
            "last" => true,
            "first" => false,
            _ => descending,
        };
        return nullsLast ? new GraphOrderBy(graphColumn.Name, descending) : null;
    }

    /// <summary>The result column's name when the whole query is <paramref name="table"/>'s reference, its leading
    /// <c>where</c> operators, then <c>count</c> or <c>summarize count()</c> (named or not, with no <c>by</c>) and nothing
    /// else. Null otherwise.</summary>
    internal static string? CountColumn(KustoCode code, TableSymbol table)
    {
        var uses = TableUses(code).Where(u => ReferenceEquals(u.Table, table)).ToList();
        if (uses.Count != 1)
            return null;
        SyntaxNode node = uses[0].Node;
        while (node.Parent is PipeExpression pipe && ReferenceEquals(pipe.Expression, node))
        {
            if (pipe.Operator is FilterOperator)
            {
                node = pipe;
                continue;
            }
            var counts = pipe.Operator switch
            {
                CountOperator { AsIdentifier: null } => true,
                SummarizeOperator { ByClause: null, Aggregates.Count: 1 } summarize => IsCount(summarize.Aggregates[0].Element),
                _ => false,
            };
            // Nothing may follow: the count has to be the query's answer.
            if (!counts || !ReferenceEquals(pipe, Answer(code.Syntax))
                || code.ResultType is not TableSymbol { Columns: [{ Type: var type } column] } || type != ScalarTypes.Long)
                return null;
            return column.Name;
        }
        return null;
    }

    /// <summary>The expression of the query's last statement: its answer.</summary>
    private static Expression? Answer(SyntaxNode syntax) => syntax is QueryBlock block
        ? block.Statements.Select(s => s.Element).OfType<ExpressionStatement>().LastOrDefault()?.Expression
        : null;

    private static bool IsCount(Expression aggregate) => aggregate switch
    {
        SimpleNamedExpression named => IsCount(named.Expression),
        FunctionCallExpression { ArgumentList.Expressions.Count: 0 } call => call.ReferencedSymbol == Aggregates.Count,
        _ => false,
    };

    /// <summary>Every place the query reads a table: by name (<c>applications</c>, <c>database("graph").applications</c>),
    /// by wildcard (<c>union app*</c>, one use per table it matches) or through <c>table("applications")</c>. The node is the
    /// whole reference, so a pipe after it can be followed.</summary>
    private static IEnumerable<(Expression Node, TableSymbol Table)> TableUses(KustoCode code)
    {
        foreach (var expression in code.Syntax.GetDescendants<Expression>())
        {
            var symbol = expression switch
            {
                NameReference r => r.ReferencedSymbol,
                FunctionCallExpression f when f.Name.SimpleName == "table" => f.ResultType,
                _ => null,
            };
            var node = expression.Parent is PathExpression path && ReferenceEquals(path.Selector, expression) ? path : expression;
            switch (symbol)
            {
                case TableSymbol table:
                    yield return (node, table);
                    break;
                case GroupSymbol group:
                    foreach (var member in group.Members.OfType<TableSymbol>())
                        yield return (node, member);
                    break;
            }
        }
    }

    /// <summary>Functions that read columns without naming them (or name them in a string), so no column reference shows
    /// which ones they need.</summary>
    private static readonly HashSet<string> ImplicitColumnFunctions =
        new(StringComparer.Ordinal) { "pack_all", "column_ifexists", "columnifexists", "bag_pack_columns" };

    /// <summary>Whether the query reads columns it doesn't name: <c>*</c>, <c>search</c>, <c>pack_all()</c> and the like,
    /// any <c>evaluate</c> plugin (it reshapes whatever columns it is given), or <c>fork</c>. Then every column of every
    /// table it reads is fetched: a column left out would be silently empty.</summary>
    private static bool UsesColumnsImplicitly(SyntaxNode syntax) =>
        syntax.GetFirstDescendant<SyntaxNode>(n => n switch
        {
            StarExpression or SearchOperator or EvaluateOperator or ForkOperator => true,
            FunctionCallExpression f => ImplicitColumnFunctions.Contains(f.Name.SimpleName),
            _ => false,
        }) is not null;

    /// <summary>A query Graph query can't answer as written: more than one result statement (only the last result's
    /// columns would be planned for), or a table in another cluster or database.</summary>
    private static (SyntaxNode Node, string Message)? StructureError(SyntaxNode syntax)
    {
        if (syntax is QueryBlock block)
        {
            var results = block.Statements.Select(s => s.Element).OfType<ExpressionStatement>()
                .Where(s => s.Expression.ResultType is TableSymbol).ToList();
            if (results.Count > 1)
                return (results[1], "Graph query returns one result. Remove the extra statements.");
        }

        var elsewhere = syntax.GetFirstDescendant<FunctionCallExpression>(f => f.Name.SimpleName switch
        {
            "cluster" => true,
            "database" => !(f.ArgumentList.Expressions.Count == 1
                && f.ArgumentList.Expressions[0].Element is LiteralExpression { LiteralValue: string name }
                && name == GraphGlobals.DatabaseName),
            _ => false,
        });
        return elsewhere is null ? null : (elsewhere, "Only Microsoft Graph tables can be queried.");
    }

    /// <summary>Why <paramref name="kql"/> is refused (it reaches outside the Graph tables), or null. Needs no schema: the
    /// engine worker checks again with this, so both sides refuse exactly the same queries.</summary>
    public static string? RefusalOf(string kql) => Refusal(KustoCode.Parse(kql));

    private static string? Refusal(KustoCode code)
    {
        if (code.Kind != CodeKinds.Query)
            return $"Management commands aren't available in Graph query. {OnlyGraphTables}";
        if (code.Syntax.GetFirstDescendant<ExternalDataExpression>() is not null)
            return $"externaldata isn't available in Graph query. {OnlyGraphTables}";
        foreach (var evaluate in code.Syntax.GetDescendants<EvaluateOperator>())
        {
            var plugin = evaluate.FunctionCall.Name.SimpleName;
            if (!AllowedPlugins.Contains(plugin))
                return $"The {plugin} plugin isn't available in Graph query. Only bag_unpack, narrow and pivot are.";
        }
        return null;
    }

    /// <summary>The 1-based line and column of a character offset.</summary>
    private static (int Line, int Column) Position(string text, int offset)
    {
        offset = Math.Clamp(offset, 0, text.Length);
        var line = 1;
        var lineStart = 0;
        for (var i = 0; i < offset; i++)
        {
            if (text[i] == '\n')
            {
                line++;
                lineStart = i + 1;
            }
        }
        return (line, offset - lineStart + 1);
    }
}
