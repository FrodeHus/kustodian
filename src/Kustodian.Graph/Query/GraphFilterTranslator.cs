using System.Globalization;
using System.Text.RegularExpressions;
using Kustodian.Graph.Schema;
using Kusto.Language;
using Kusto.Language.Symbols;
using Kusto.Language.Syntax;

namespace Kustodian.Graph.Query;

/// <summary>Turns the <c>where</c> predicates directly after a table reference into a Graph <c>$filter</c>.
/// Pushdown only narrows the fetch: the engine still runs the whole query, so a pushed filter has to keep at least the
/// rows the KQL keeps. Anything that might keep fewer is left out. Pure.</summary>
public static partial class GraphFilterTranslator
{
    /// <summary>The <c>$filter</c> for <paramref name="leadingWherePredicates"/>, or null when nothing can be pushed. Each
    /// top-level <c>and</c> conjunct is pushed or left out on its own; an <c>or</c> only when every branch can be.</summary>
    /// <param name="now">The run's time, for <c>now()</c> and <c>ago()</c>.</param>
    /// <param name="complexTypes">The schema's complex types, for conditions on a nested property; without them none is pushed.</param>
    public static string? Translate(GraphTable table, IReadOnlyList<Expression> leadingWherePredicates, DateTimeOffset now,
        IReadOnlyDictionary<string, IReadOnlyList<GraphField>>? complexTypes = null)
        => Explain(table, leadingWherePredicates, now, complexTypes).Filter;

    /// <summary>What <see cref="Translate"/> sends, with each top-level <c>and</c> conjunct of
    /// <paramref name="leadingWherePredicates"/> either pushed or kept local with the rule that keeps it
    /// (<see cref="PushdownReasons"/>). A column Graph filters on only alone (<see cref="PushdownReasons.Alone"/>) wins: once a
    /// condition on it is pushed, the conditions on other columns run locally.</summary>
    /// <param name="now">The run's time, for <c>now()</c> and <c>ago()</c>.</param>
    /// <param name="complexTypes">The schema's complex types, for conditions on a nested property.</param>
    public static FilterExplanation Explain(GraphTable table, IReadOnlyList<Expression> leadingWherePredicates, DateTimeOffset now,
        IReadOnlyDictionary<string, IReadOnlyList<GraphField>>? complexTypes = null)
    {
        var context = new Context(table, now.UtcDateTime, complexTypes ?? new Dictionary<string, IReadOnlyList<GraphField>>());
        var results = leadingWherePredicates.SelectMany(Conjuncts).Select(c => (Conjunct: c, Result: context.Translate(c))).ToList();
        var alone = results.Select(r => r.Result).FirstOrDefault(r => r.Filter is not null && r.Alone is not null).Alone;

        var clauses = new List<FilterClause>();
        var pushed = new List<string>();
        var local = new List<LocalCondition>();
        var exact = true;
        foreach (var (conjunct, result) in results)
        {
            if (result.Filter is { } filter && (alone is null || result.Alone == alone))
            {
                clauses.Add(new FilterClause(filter, result.Feature, result.Advanced));
                pushed.Add(Text(conjunct));
                exact &= result.Exact;
            }
            else
            {
                local.Add(new LocalCondition(Text(conjunct), result.Reason ?? PushdownReasons.Alone(alone!)));
                exact = false;
            }
        }
        return new FilterExplanation(clauses.Count == 0 ? null : string.Join(" and ", clauses.Select(c => c.OData)), pushed, local)
        {
            Clauses = clauses,
            Exact = exact,
        };
    }

    /// <summary>An expression as written, on one line, with its comments and runs of white space each read as one space.</summary>
    internal static string Text(Expression expression) => expression.ToString(IncludeTrivia.SingleLine).Trim();

    private static IEnumerable<Expression> Conjuncts(Expression expression) => Unwrap(expression) switch
    {
        BinaryExpression { Kind: SyntaxKind.AndExpression } and => Conjuncts(and.Left).Concat(Conjuncts(and.Right)),
        var other => [other],
    };

    private static Expression Unwrap(Expression expression)
    {
        while (expression is ParenthesizedExpression parenthesized)
            expression = parenthesized.Expression;
        return expression;
    }

    private enum Kind { String, DateTime, Number, Bool }

    /// <summary>An expression as OData (<see cref="Filter"/>), or why it can't be pushed (<see cref="Reason"/>).
    /// <see cref="Exact"/>: Graph keeps exactly the rows the KQL keeps. <see cref="Feature"/> and <see cref="Advanced"/> are as
    /// in <see cref="FilterClause"/>; <see cref="Alone"/> is the column Graph filters on only alone, when the expression is on
    /// it.</summary>
    private readonly record struct Pushdown(string? Filter, string? Reason, bool Exact = false, string? Feature = null,
        bool Advanced = false, string? Alone = null)
    {
        public static Pushdown Keep(string reason) => new(null, reason);
    }

    /// <summary>A function of a column the translator reads through: <c>tolower()</c>, <c>toupper()</c>.</summary>
    private enum Fold { None, Lower, Upper }

    /// <summary>What a condition's left side filters on: <see cref="Path"/> as OData (<c>signInActivity/lastSignInDateTime</c>),
    /// <see cref="Name"/> as the query names it, the operators Graph allows on it, and its kind. <see cref="Nested"/>: a
    /// property of a complex column. <see cref="Alone"/>: the column Graph filters on only alone.</summary>
    private sealed record Target(string Path, string Name, IReadOnlyList<string> Filter, Kind Kind, string Type, bool Nested,
        string? Alone, Fold Fold);

    [GeneratedRegex(@"not with any other filterable propert", RegexOptions.IgnoreCase)]
    private static partial Regex AloneText();

    private sealed partial class Context(GraphTable table, DateTime now, IReadOnlyDictionary<string, IReadOnlyList<GraphField>> complexTypes)
    {
        /// <summary>The whole expression as OData, or why it can't be pushed: no part of it is pushed unless all of it is.</summary>
        public Pushdown Translate(Expression expression)
        {
            expression = Unwrap(expression);
            switch (expression)
            {
                case BinaryExpression { Kind: SyntaxKind.AndExpression } and:
                {
                    var left = Translate(and.Left);
                    if (left.Filter is null)
                        return left;
                    var right = Translate(and.Right);
                    return right.Filter is null ? right : Combine(left, right, $"{left.Filter} and {right.Filter}");
                }
                case BinaryExpression { Kind: SyntaxKind.OrExpression } or:
                    return Translate(or.Left) is { Filter: { } l } first && Translate(or.Right) is { Filter: { } r } second
                        ? Combine(first, second, $"({l} or {r})")
                        : Pushdown.Keep(PushdownReasons.OrSide);
                case BinaryExpression binary:
                    return Comparison(binary);
                case BetweenExpression between:
                    return Between(between);
                case InExpression { Kind: SyntaxKind.InExpression or SyntaxKind.InCsExpression } @in:
                    return In(@in);
                case InExpression other:
                    return Resolve(other.Left) is { } target
                        ? Pushdown.Keep(target.Fold == Fold.None ? PushdownReasons.Operator(target.Name) : PushdownReasons.Folded)
                        : NotAColumn(other.Left);
                case FunctionCallExpression call when call.ReferencedSymbol == Functions.Not:
                    return Pushdown.Keep(PushdownReasons.Not);
                case FunctionCallExpression call when call.ReferencedSymbol == Functions.SetHasElement && call.ArgumentList.Expressions.Count == 2:
                    return HasElement(call);
                case FunctionCallExpression call when call.ArgumentList.Expressions.Count == 1:
                    return NullCheck(call);
                // A bare column (a bool used as the condition) names it; any other condition the translator doesn't know is
                // never named as if it were a column.
                default:
                    return NotAColumn(expression);
            }
        }

        /// <summary>Two pushed parts joined as <paramref name="filter"/>: exact only if both are, and never a column Graph
        /// filters on only alone mixed with anything else.</summary>
        private static Pushdown Combine(Pushdown left, Pushdown right, string filter)
        {
            if (left.Alone != right.Alone)
                return Pushdown.Keep(PushdownReasons.Alone(left.Alone ?? right.Alone!));
            var features = new[] { left.Feature, right.Feature }.OfType<string>().SelectMany(f => f.Split(", ")).Distinct().ToList();
            return new Pushdown(filter, null, left.Exact && right.Exact, features.Count == 0 ? null : string.Join(", ", features),
                left.Advanced || right.Advanced, left.Alone);
        }

        /// <summary>A pushed condition on <paramref name="target"/>: a nested property is a feature of its own (its path), and
        /// carries the column Graph filters on only alone.</summary>
        private static Pushdown Push(Target target, string filter, bool exact, string? feature = null, bool advanced = false)
        {
            var features = new[] { target.Nested ? target.Path : null, feature }.OfType<string>().ToList();
            return new Pushdown(filter, null, exact, features.Count == 0 ? null : string.Join(", ", features), advanced, target.Alone);
        }

        private Pushdown Comparison(BinaryExpression binary)
        {
            if (Resolve(binary.Left) is not { } target)
            {
                return binary.Kind is SyntaxKind.HasExpression or SyntaxKind.HasCsExpression or SyntaxKind.ContainsExpression
                        or SyntaxKind.ContainsCsExpression && CollectionColumn(binary.Left) is not null
                    ? Pushdown.Keep(PushdownReasons.WordsInArray)
                    : NotAColumn(binary.Left);
            }
            if (target.Fold != Fold.None)
                return Folded(binary, target);
            var kind = target.Kind;

            if (binary.Kind is SyntaxKind.StartsWithExpression or SyntaxKind.StartsWithCsExpression)
            {
                // KQL's startswith ignores case; startswith_cs is kept to the same tables for simplicity.
                if (kind != Kind.String || !Allows(target, "startsWith"))
                    return Pushdown.Keep(PushdownReasons.Operator(target.Name));
                if (!table.DirectoryObject)
                    return Pushdown.Keep(PushdownReasons.CaseInsensitive);
                return Value(binary.Right, kind, Rounding.Exact,
                    prefix => Push(target, $"startswith({target.Path},{prefix})", binary.Kind == SyntaxKind.StartsWithExpression));
            }

            if (binary.Kind is SyntaxKind.EndsWithExpression or SyntaxKind.EndsWithCsExpression)
            {
                // Microsoft documents endswith only on directory objects, in advanced query mode, where it ignores case as
                // KQL's endswith does; endswith_cs keeps fewer rows than Graph's, so it is pushed too.
                if (kind != Kind.String || !Allows(target, "endsWith"))
                    return Pushdown.Keep(PushdownReasons.Operator(target.Name));
                if (!table.DirectoryObject)
                    return Pushdown.Keep(PushdownReasons.DirectoryOnly);
                return Value(binary.Right, kind, Rounding.Exact,
                    suffix => Push(target, $"endswith({target.Path},{suffix})", binary.Kind == SyntaxKind.EndsWithExpression,
                        $"endswith({target.Path})", advanced: true));
            }

            // Exact: Graph keeps exactly what KQL keeps. A string eq isn't (Graph ignores case on directory objects, and isn't
            // known not to elsewhere); a strict datetime bound sent inclusive isn't.
            var (op, rounding, exact) = binary.Kind switch
            {
                SyntaxKind.EqualExpression => ("eq", Rounding.Exact, kind != Kind.String),
                // Graph's string eq ignores case on directory objects, so there it keeps at least what =~ keeps. Elsewhere it
                // may not.
                SyntaxKind.EqualTildeExpression when kind == Kind.String && table.DirectoryObject => ("eq", Rounding.Exact, true),
                // Graph's string ne ignores case too, so on strings it would keep fewer than != keeps. On directory objects
                // ne needs advanced query mode, which Graph query doesn't use.
                SyntaxKind.NotEqualExpression when kind != Kind.String && !table.DirectoryObject => ("ne", Rounding.Exact, true),
                // Graph's datetime precision isn't known, so a strict datetime bound is sent inclusive: it only widens.
                SyntaxKind.LessThanExpression when kind is Kind.DateTime => ("le", Rounding.Up, false),
                SyntaxKind.GreaterThanExpression when kind is Kind.DateTime => ("ge", Rounding.Down, false),
                SyntaxKind.LessThanExpression when kind is Kind.Number => ("lt", Rounding.Up, true),
                SyntaxKind.LessThanOrEqualExpression when kind is Kind.DateTime or Kind.Number => ("le", Rounding.Up, true),
                SyntaxKind.GreaterThanExpression when kind is Kind.Number => ("gt", Rounding.Down, true),
                SyntaxKind.GreaterThanOrEqualExpression when kind is Kind.DateTime or Kind.Number => ("ge", Rounding.Down, true),
                _ => (null, Rounding.Exact, false),
            };
            if (op is null)
            {
                return Pushdown.Keep(binary.Kind switch
                {
                    SyntaxKind.EqualTildeExpression when kind == Kind.String => PushdownReasons.CaseInsensitive,
                    SyntaxKind.NotEqualExpression or SyntaxKind.BangTildeExpression when table.DirectoryObject
                        => PushdownReasons.AdvancedQuery,
                    SyntaxKind.NotEqualExpression or SyntaxKind.BangTildeExpression when kind == Kind.String
                        => PushdownReasons.CaseFolded,
                    _ => PushdownReasons.Operator(target.Name),
                });
            }
            if (!Allows(target, op))
                return Pushdown.Keep(PushdownReasons.Operator(target.Name));
            exact &= OnWholeSecond(binary.Right, kind);
            return Value(binary.Right, kind, rounding, value => Push(target, $"{target.Path} {op} {value}", exact));
        }

        /// <summary><c>tolower(c) == "x"</c> (or <c>=~</c>, or <c>toupper</c>) as <c>c eq 'x'</c>, on directory objects only,
        /// where Graph's eq ignores case: it keeps every row whose value is <c>x</c> in any case, which is all KQL keeps. Exact
        /// when the literal is already in the folded case (else KQL keeps no row at all).</summary>
        private Pushdown Folded(BinaryExpression binary, Target target)
        {
            if (!table.DirectoryObject || binary.Kind is not (SyntaxKind.EqualExpression or SyntaxKind.EqualTildeExpression))
                return Pushdown.Keep(PushdownReasons.Folded);
            if (!Allows(target, "eq"))
                return Pushdown.Keep(PushdownReasons.Operator(target.Name));
            var exact = Unwrap(binary.Right) is LiteralExpression { LiteralValue: string text }
                && (binary.Kind == SyntaxKind.EqualTildeExpression
                    || text == (target.Fold == Fold.Lower ? text.ToLowerInvariant() : text.ToUpperInvariant()));
            return Value(binary.Right, Kind.String, Rounding.Exact, value => Push(target, $"{target.Path} eq {value}", exact));
        }

        /// <summary><c>c between (a .. b)</c> on a datetime or number as <c>c ge a and c le b</c>: datetimes widen to the
        /// second. <c>!between</c> isn't pushed.</summary>
        private Pushdown Between(BetweenExpression between)
        {
            if (Resolve(between.Left) is not { Fold: Fold.None } target)
                return NotAColumn(between.Left);
            if (between.Kind != SyntaxKind.BetweenExpression || target.Kind is not (Kind.DateTime or Kind.Number)
                || !Allows(target, "ge") || !Allows(target, "le"))
                return Pushdown.Keep(PushdownReasons.Operator(target.Name));
            var low = Value(between.Right.First, target.Kind, Rounding.Down, v => new Pushdown(v, null));
            if (low.Filter is null)
                return low;
            var high = Value(between.Right.Second, target.Kind, Rounding.Up, v => new Pushdown(v, null));
            if (high.Filter is null)
                return high;
            var exact = OnWholeSecond(between.Right.First, target.Kind) && OnWholeSecond(between.Right.Second, target.Kind);
            return Push(target, $"{target.Path} ge {low.Filter} and {target.Path} le {high.Filter}", exact);
        }

        private Pushdown In(InExpression @in)
        {
            if (Resolve(@in.Left) is not { } target)
                return NotAColumn(@in.Left);
            var kind = target.Kind;
            if (target.Fold != Fold.None)
                return Pushdown.Keep(PushdownReasons.Folded);
            if (kind is Kind.Bool || !Allows(target, "in"))
                return Pushdown.Keep(PushdownReasons.Operator(target.Name));
            // in~ ignores case, which Graph's in is only known to do on directory objects.
            var ignoresCase = @in.Operator.Text.Contains('~', StringComparison.Ordinal);
            if (ignoresCase && !table.DirectoryObject)
                return Pushdown.Keep(PushdownReasons.CaseInsensitive);
            if (@in.Right is not ExpressionList list)
                return Pushdown.Keep(PushdownReasons.FixedValue);
            // Graph has no empty in list.
            if (list.Expressions.Count == 0)
                return Pushdown.Keep(PushdownReasons.Inexact);
            var values = new List<string>();
            foreach (var element in list.Expressions)
            {
                var value = Value(element.Element, kind, Rounding.Exact, v => new Pushdown(v, null));
                if (value.Filter is null)
                    return value;
                values.Add(value.Filter);
            }
            return Push(target, $"{target.Path} in ({string.Join(",", values)})", kind != Kind.String || ignoresCase);
        }

        /// <summary><c>set_has_element(c, "x")</c> on a column that is an array of text, as <c>c/any(p:p eq 'x')</c>: an
        /// element equal to <c>x</c> is one Graph's eq keeps (it ignores case on directory objects, so it keeps more). Only on
        /// directory objects, where Microsoft documents lambdas on these arrays, and in advanced query mode, which some of them
        /// need.</summary>
        private Pushdown HasElement(FunctionCallExpression call)
        {
            var array = call.ArgumentList.Expressions[0].Element;
            if (CollectionColumn(array) is not { ComplexType: null } column)
                return NotAColumn(array);
            if (!Allows(column.Filter, "eq"))
                return Pushdown.Keep(PushdownReasons.Operator(column.Name));
            if (!table.DirectoryObject)
                return Pushdown.Keep(PushdownReasons.DirectoryOnly);
            return Value(call.ArgumentList.Expressions[1].Element, Kind.String, Rounding.Exact,
                value => new Pushdown($"{column.Name}/any(p:p eq {value})", null, false, $"{column.Name}/any", true));
        }

        /// <summary><c>isnull(c)</c>, <c>isnotnull(c)</c> and <c>isnotempty(c)</c>. A string is never null in KQL, so
        /// <c>isnotnull</c> keeps every row there and <c>ne null</c> would keep fewer: only <c>isnull</c> is pushed on strings.
        /// Neither is pushed on directory objects, where null checks need advanced query mode. <c>isnotempty</c> keeps only
        /// rows with a value, so <c>ne null</c> keeps at least those: it is pushed on directory objects too, in advanced query
        /// mode.</summary>
        private Pushdown NullCheck(FunctionCallExpression call)
        {
            var argument = call.ArgumentList.Expressions[0].Element;
            var isNull = call.ReferencedSymbol == Functions.IsNull;
            var isNotNull = call.ReferencedSymbol == Functions.IsNotNull;
            var isNotEmpty = call.ReferencedSymbol == Functions.IsNotEmpty;
            if ((isNull || isNotNull) && table.DirectoryObject)
                return Pushdown.Keep(PushdownReasons.AdvancedQuery);
            if (Resolve(argument) is not { Fold: Fold.None } target)
                return NotAColumn(argument);
            var kind = target.Kind;
            if (isNull && Allows(target, "eq"))
                return Push(target, $"{target.Path} eq null", kind != Kind.String);
            if (isNotNull && kind == Kind.String)
                return Pushdown.Keep(PushdownReasons.IsNotNullOnText);
            if (isNotNull && Allows(target, "ne"))
                return Push(target, $"{target.Path} ne null", true);
            // On directory objects every property that takes eq takes ne in advanced query mode.
            if (isNotEmpty && table.DirectoryObject && (Allows(target, "eq") || Allows(target, "ne")))
                return Push(target, $"{target.Path} ne null", kind != Kind.String, $"{target.Path} ne null", advanced: true);
            if (isNotEmpty && Allows(target, "ne"))
                return Push(target, $"{target.Path} ne null", kind != Kind.String);
            return Pushdown.Keep(PushdownReasons.Operator(target.Name));
        }

        /// <summary><paramref name="expression"/> as a literal of the column's kind, formatted; else why not: an empty string
        /// is never pushed, a value that isn't fixed (a column, a function of one) can't be compared with, and a fixed value
        /// Graph can't represent faithfully (a datetime that isn't on a whole second for an exact match) isn't compared
        /// exactly.</summary>
        private Pushdown Value(Expression expression, Kind kind, Rounding rounding, Func<string, Pushdown> format)
        {
            if (Literal(expression, kind, rounding) is { } value)
                return format(value);
            expression = Unwrap(expression);
            if (kind == Kind.String && expression is LiteralExpression { LiteralValue: string { Length: 0 } })
                return Pushdown.Keep(PushdownReasons.EmptyString);
            return Pushdown.Keep(Fixed(expression) ? PushdownReasons.Inexact : PushdownReasons.FixedValue);
        }

        /// <summary>Whether the value needs no rounding to go to Graph: anything but a datetime off a whole second.</summary>
        private bool OnWholeSecond(Expression expression, Kind kind) => kind != Kind.DateTime || Literal(expression, kind, Rounding.Exact) is not null;

        /// <summary>A literal, or <c>now()</c>/<c>ago()</c> of literals: a value that doesn't depend on the row.</summary>
        private static bool Fixed(Expression expression) => Unwrap(expression) switch
        {
            LiteralExpression => true,
            FunctionCallExpression call when call.ReferencedSymbol == Functions.Now || call.ReferencedSymbol == Functions.Ago
                => call.ArgumentList.Expressions.All(a => Unwrap(a.Element) is LiteralExpression),
            _ => false,
        };

        /// <summary>Why the left side <paramref name="expression"/> can't be filtered on: a plain column of the table whose
        /// type Graph can't filter (a collection, a dynamic value) doesn't allow the operator; anything else (a function of
        /// a column, a nested field) isn't a plain column.</summary>
        private Pushdown NotAColumn(Expression expression) =>
            Pushdown.Keep(Unwrap(expression) is NameReference { ReferencedSymbol: ColumnSymbol symbol }
                && table.Columns.Any(c => c.Name == symbol.Name)
                ? PushdownReasons.Operator(symbol.Name)
                : PushdownReasons.FixedValue);

        /// <summary>A column of the table that is an array.</summary>
        private GraphColumn? CollectionColumn(Expression expression) =>
            Unwrap(expression) is NameReference { ReferencedSymbol: ColumnSymbol symbol }
                && table.Columns.FirstOrDefault(c => c.Name == symbol.Name) is { Collection: true } column
                ? column
                : null;

        /// <summary>What the left side filters on: a top-level column of the table with a type that can be pushed; a property
        /// of a complex column Graph filters on (<c>signInActivity.lastSignInDateTime</c>, also inside a conversion to its own
        /// type, <c>todatetime(...)</c>); or <c>tolower()</c>/<c>toupper()</c> of a text column. Anything else (another function
        /// of a column, an array) is not.</summary>
        private Target? Resolve(Expression expression)
        {
            expression = Unwrap(expression);
            switch (expression)
            {
                case FunctionCallExpression { ArgumentList.Expressions.Count: 1 } call
                    when call.ReferencedSymbol == Functions.ToLower || call.ReferencedSymbol == Functions.ToUpper:
                    return Resolve(call.ArgumentList.Expressions[0].Element) is { Kind: Kind.String, Fold: Fold.None, Nested: false } text
                        ? text with { Fold = call.ReferencedSymbol == Functions.ToLower ? Fold.Lower : Fold.Upper }
                        : null;
                case FunctionCallExpression { ArgumentList.Expressions.Count: 1 } call
                    when Unwrap(call.ArgumentList.Expressions[0].Element) is PathExpression path:
                    // A conversion that changes no value of the property's type: toint of a real would.
                    return Nested(path) is { } nested && Converts(call.ReferencedSymbol, nested.Type) ? nested : null;
                case PathExpression path:
                    return Nested(path);
                case NameReference { ReferencedSymbol: ColumnSymbol symbol }:
                    if (table.Columns.FirstOrDefault(c => c.Name == symbol.Name) is not { Collection: false } column
                        || KindOf(column.Type) is not { } kind)
                        return null;
                    return new Target(column.Name, column.Name, column.Filter, kind, column.Type, false, null, Fold.None);
                default:
                    return null;
            }
        }

        /// <summary>A property of a complex column, when the column documents <c>$filter</c> (its operators are the
        /// property's: Graph documents them on the column) and the property has a type that can be pushed.</summary>
        private Target? Nested(PathExpression path)
        {
            if (Unwrap(path.Expression) is not NameReference { ReferencedSymbol: ColumnSymbol symbol } || path.Selector is not NameReference selector)
                return null;
            if (table.Columns.FirstOrDefault(c => c.Name == symbol.Name) is not { Collection: false, ComplexType: { } complex, Filter.Count: > 0 } column)
                return null;
            if (complexTypes.GetValueOrDefault(complex)?.FirstOrDefault(f => f.Name == selector.SimpleName) is not { Collection: false, ComplexType: null } field
                || KindOf(field.Type) is not { } kind)
                return null;
            return new Target($"{column.Name}/{field.Name}", $"{column.Name}.{field.Name}", column.Filter, kind, field.Type, true,
                AloneText().IsMatch(column.Description) ? column.Name : null, Fold.None);
        }

        private static Kind? KindOf(string type) => type switch
        {
            "string" => Kind.String,
            "datetime" => Kind.DateTime,
            "int" or "long" or "real" => Kind.Number,
            "bool" => Kind.Bool,
            _ => null,
        };

        private static bool Converts(Symbol? function, string type) => type switch
        {
            "string" => function == Functions.ToString,
            "datetime" => function == Functions.ToDateTime,
            "bool" => function == Functions.ToBool || function == Functions.ToBoolean,
            "int" => function == Functions.ToInt || function == Functions.ToLong || function == Functions.ToReal || function == Functions.ToDouble,
            "long" => function == Functions.ToLong || function == Functions.ToReal || function == Functions.ToDouble,
            "real" => function == Functions.ToReal || function == Functions.ToDouble,
            _ => false,
        };

        private static bool Allows(Target target, string op) => Allows(target.Filter, op);

        private static bool Allows(IReadOnlyList<string> filter, string op) => filter.Contains(op, StringComparer.OrdinalIgnoreCase);

        private enum Rounding { Exact, Down, Up }

        /// <summary>A literal (or <c>now()</c>/<c>ago()</c>) of the column's kind as OData. Datetimes are sent to the second:
        /// a lower bound rounds down and an upper bound rounds up, so the range only widens; an exact match that isn't on a
        /// whole second isn't pushed.</summary>
        private string? Literal(Expression expression, Kind kind, Rounding rounding)
        {
            expression = Unwrap(expression);
            switch (kind)
            {
                // KQL has no null strings: a missing value reads as "", so an empty literal matches rows that Graph's
                // eq '' (or startswith '') drops. Never pushed.
                case Kind.String when expression is LiteralExpression { LiteralValue: string { Length: > 0 } text }:
                    return $"'{text.Replace("'", "''", StringComparison.Ordinal)}'";
                case Kind.Bool when expression is LiteralExpression { LiteralValue: bool flag }:
                    return flag ? "true" : "false";
                case Kind.Number when expression is LiteralExpression literal:
                    return literal.LiteralValue switch
                    {
                        int i => i.ToString(CultureInfo.InvariantCulture),
                        long l => l.ToString(CultureInfo.InvariantCulture),
                        double => RealValue(literal) is { } d ? d.ToString("R", CultureInfo.InvariantCulture) : null,
                        _ => null,
                    };
                case Kind.DateTime when DateTimeValue(expression) is { } value:
                    return DateTimeLiteral(value, rounding);
                default:
                    return null;
            }
        }

        private DateTime? DateTimeValue(Expression expression)
        {
            if (expression is LiteralExpression { LiteralValue: DateTime } literal)
                return DateTimeLiteralValue(literal);
            if (expression is not FunctionCallExpression call)
                return null;
            var arguments = call.ArgumentList.Expressions;
            TimeSpan? Offset() => arguments.Count == 1 && Unwrap(arguments[0].Element) is LiteralExpression { LiteralValue: TimeSpan } span
                ? TimeSpanValue(span)
                : null;
            try
            {
                if (call.ReferencedSymbol == Functions.Now)
                    return arguments.Count == 0 ? now : Offset() is { } offset ? now + offset : null;
                if (call.ReferencedSymbol == Functions.Ago)
                    return Offset() is { } ago ? now - ago : null;
            }
            catch (ArgumentOutOfRangeException)
            {
                // ago(100000000d): not a date Graph can compare with, so nothing is pushed.
            }
            return null;
        }

        // Kusto.Language parses real and timespan literals in the current culture (1.5 is 0 where the decimal separator
        // is a comma), so their text is read here, invariantly. Anything else isn't pushed.

        private static double? RealValue(LiteralExpression literal) =>
            double.TryParse(literal.Token.Text, NumberStyles.Float, CultureInfo.InvariantCulture, out var value) && double.IsFinite(value)
                ? value
                : null;

        private static TimeSpan? TimeSpanValue(LiteralExpression literal)
        {
            var match = TimeSpanText().Match(literal.Token.Text);
            if (!match.Success
                || !TimeSpanUnits.TryGetValue(match.Groups["unit"].Value, out var ticksPerUnit)
                || !decimal.TryParse(match.Groups["amount"].Value, NumberStyles.AllowDecimalPoint, CultureInfo.InvariantCulture, out var amount))
                return null;
            var ticks = amount * ticksPerUnit;
            return ticks <= TimeSpan.MaxValue.Ticks ? TimeSpan.FromTicks((long)ticks) : null;
        }

        /// <summary>A datetime literal read invariantly, and only when Kusto.Language reads it the same way.</summary>
        private static DateTime? DateTimeLiteralValue(LiteralExpression literal)
        {
            var text = literal.Token.Text;
            var open = text.IndexOf('(', StringComparison.Ordinal);
            var close = text.LastIndexOf(')');
            if (open < 0 || close <= open)
                return null;
            if (!DateTime.TryParse(text[(open + 1)..close].Trim(), CultureInfo.InvariantCulture,
                    DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal, out var value))
                return null;
            // Kusto.Language turns a literal with an offset or Z into local time; an unmarked one stays as written (UTC).
            if (literal.LiteralValue is not DateTime kusto)
                return null;
            if (kusto.Kind == DateTimeKind.Local)
                kusto = kusto.ToUniversalTime();
            return kusto.Ticks == value.Ticks ? DateTime.SpecifyKind(value, DateTimeKind.Utc) : null;
        }

        private static readonly Dictionary<string, long> TimeSpanUnits = new(StringComparer.Ordinal)
        {
            ["d"] = TimeSpan.TicksPerDay, ["day"] = TimeSpan.TicksPerDay, ["days"] = TimeSpan.TicksPerDay,
            ["h"] = TimeSpan.TicksPerHour, ["hr"] = TimeSpan.TicksPerHour, ["hrs"] = TimeSpan.TicksPerHour,
            ["hour"] = TimeSpan.TicksPerHour, ["hours"] = TimeSpan.TicksPerHour,
            ["m"] = TimeSpan.TicksPerMinute, ["min"] = TimeSpan.TicksPerMinute, ["minute"] = TimeSpan.TicksPerMinute,
            ["minutes"] = TimeSpan.TicksPerMinute,
            ["s"] = TimeSpan.TicksPerSecond, ["sec"] = TimeSpan.TicksPerSecond, ["second"] = TimeSpan.TicksPerSecond,
            ["seconds"] = TimeSpan.TicksPerSecond,
            ["ms"] = TimeSpan.TicksPerMillisecond, ["milli"] = TimeSpan.TicksPerMillisecond, ["millis"] = TimeSpan.TicksPerMillisecond,
            ["millisecond"] = TimeSpan.TicksPerMillisecond, ["milliseconds"] = TimeSpan.TicksPerMillisecond,
        };

        [GeneratedRegex(@"^(?<amount>\d+(\.\d+)?)(?<unit>[a-z]+)$", RegexOptions.CultureInvariant)]
        private static partial Regex TimeSpanText();

        private static string? DateTimeLiteral(DateTime value, Rounding rounding)
        {
            var remainder = value.Ticks % TimeSpan.TicksPerSecond;
            if (remainder != 0)
            {
                if (rounding == Rounding.Exact)
                    return null;
                value = value.AddTicks(-remainder);
                if (rounding == Rounding.Up)
                {
                    if (value > DateTime.MaxValue.AddSeconds(-1))
                        return null;
                    value = value.AddSeconds(1);
                }
            }
            return value.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", CultureInfo.InvariantCulture);
        }
    }
}
