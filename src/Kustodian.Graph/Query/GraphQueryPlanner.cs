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
/// columns the query names itself (not those it only passes through): only those are ever read one object at a time.</summary>
public sealed record GraphFetch(GraphTable Table, IReadOnlyList<string> Select, string? Filter)
{
    public IReadOnlyList<string> Unreadable { get; init; } = [];
    public IReadOnlyList<string> Named { get; init; } = [];
}

/// <summary>A parse or bind error at a 1-based line and column.</summary>
public sealed record GraphQueryError(int Line, int Column, string Message);

/// <summary>Reads a query with Kusto.Language against the Graph schema and works out which tables and columns it touches.
/// Pure: nothing is fetched.</summary>
public static class GraphQueryPlanner
{
    private const string OnlyGraphTables = "Only Graph tables can be queried.";

    /// <summary>The <c>evaluate</c> plugins that only reshape rows already there. Every other plugin is refused: some load
    /// data from outside (<c>sql_request</c>, <c>http_request</c>), some run code (<c>python</c>, <c>r</c>).</summary>
    private static readonly HashSet<string> AllowedPlugins = new(StringComparer.Ordinal) { "bag_unpack", "narrow", "pivot" };

    /// <param name="now">The run's time, for <c>now()</c> and <c>ago()</c> in a pushed-down filter.</param>
    public static GraphQueryPlan Plan(GraphSchema schema, string kql, DateTimeOffset now)
    {
        var globals = GraphGlobals.Plain(schema);
        var code = KustoCode.ParseAndAnalyze(kql, globals);

        // Refusals come before errors: an attempt to reach outside the Graph tables is refused (and audited) even when it
        // doesn't bind, for example a plugin Kusto.Language doesn't know.
        if (Refusal(code) is { } refusal)
            return new GraphQueryPlan([], null, refusal);

        // Structural errors before bind errors: an unknown database or cluster would otherwise show as Kusto's "not found".
        if (StructureError(code.Syntax) is { } structure)
        {
            var (line, column) = Position(kql, structure.Node.TextStart);
            return new GraphQueryPlan([], new GraphQueryError(line, column, structure.Message), null);
        }

        if (code.GetDiagnostics().Where(d => d.Severity == DiagnosticSeverity.Error).OrderBy(d => d.Start).FirstOrDefault() is { } error)
        {
            var (line, column) = Position(kql, error.Start);
            return new GraphQueryPlan([], new GraphQueryError(line, column, error.Message), null);
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
        foreach (var symbol in tableSymbols)
        {
            if (schema.Find(symbol.Name) is not { } table)
                continue;
            // A join's `on appId` resolves to neither side's column symbol, so names count too. Over-fetching a column is
            // cheap; missing one silently empties it. A column a list never returns is never selected (Graph would refuse
            // the request); when the query names it, the reader reads it one object at a time instead.
            var getOnly = table.Columns.Where(c => !c.Listable).Select(c => c.Name).ToHashSet(StringComparer.Ordinal);
            var select = symbol.Columns
                .Where(c => !getOnly.Contains(c.Name))
                .Where(c => everyColumn || columnRefs.Contains(c) || names.Contains(c.Name))
                .Select(c => c.Name)
                .Append("id")
                .Distinct(StringComparer.Ordinal)
                .ToList();
            var named = symbol.Columns
                .Where(c => namedRefs.Contains(c) || namedNames.Contains(c.Name))
                .Select(c => c.Name)
                .ToList();
            var unreadable = named.Where(getOnly.Contains).ToList();
            // A table read more than once (a self-join) is never filtered: one fetch has to serve every use.
            var filter = LeadingPredicates(code, symbol) is { } predicates ? GraphFilterTranslator.Translate(table, predicates, now) : null;
            fetches.Add(new GraphFetch(table, select, filter) { Unreadable = unreadable, Named = named });
        }
        return new GraphQueryPlan(fetches, null, null);
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
