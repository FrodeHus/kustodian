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
    public static string? Translate(GraphTable table, IReadOnlyList<Expression> leadingWherePredicates, DateTimeOffset now)
        => Explain(table, leadingWherePredicates, now).Filter;

    /// <summary>What <see cref="Translate"/> sends, with each top-level <c>and</c> conjunct of
    /// <paramref name="leadingWherePredicates"/> either pushed or kept local with the rule that keeps it
    /// (<see cref="PushdownReasons"/>).</summary>
    /// <param name="now">The run's time, for <c>now()</c> and <c>ago()</c>.</param>
    public static FilterExplanation Explain(GraphTable table, IReadOnlyList<Expression> leadingWherePredicates, DateTimeOffset now)
    {
        var context = new Context(table, now.UtcDateTime);
        var filters = new List<string>();
        var pushed = new List<string>();
        var local = new List<LocalCondition>();
        foreach (var conjunct in leadingWherePredicates.SelectMany(Conjuncts))
        {
            var result = context.Translate(conjunct);
            if (result.Filter is { } filter)
            {
                filters.Add(filter);
                pushed.Add(Text(conjunct));
            }
            else
            {
                local.Add(new LocalCondition(Text(conjunct), result.Reason!));
            }
        }
        return new FilterExplanation(filters.Count == 0 ? null : string.Join(" and ", filters), pushed, local);
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

    /// <summary>An expression as OData (<see cref="Filter"/>), or why it can't be pushed (<see cref="Reason"/>).</summary>
    private readonly record struct Pushdown(string? Filter, string? Reason)
    {
        public static Pushdown Push(string filter) => new(filter, null);
        public static Pushdown Keep(string reason) => new(null, reason);
    }

    private sealed partial class Context(GraphTable table, DateTime now)
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
                    return right.Filter is null ? right : Pushdown.Push($"{left.Filter} and {right.Filter}");
                }
                case BinaryExpression { Kind: SyntaxKind.OrExpression } or:
                    return Translate(or.Left).Filter is { } l && Translate(or.Right).Filter is { } r
                        ? Pushdown.Push($"({l} or {r})")
                        : Pushdown.Keep(PushdownReasons.OrSide);
                case BinaryExpression binary:
                    return Comparison(binary);
                case InExpression { Kind: SyntaxKind.InExpression or SyntaxKind.InCsExpression } @in:
                    return In(@in);
                case InExpression other:
                    return Pushdown.Keep(PushdownReasons.Operator(Name(other.Left)));
                case FunctionCallExpression call when call.ReferencedSymbol == Functions.Not:
                    return Pushdown.Keep(PushdownReasons.Not);
                case FunctionCallExpression call when call.ArgumentList.Expressions.Count == 1:
                    return NullCheck(call);
                default:
                    return Pushdown.Keep(PushdownReasons.Operator(Name(expression)));
            }
        }

        private Pushdown Comparison(BinaryExpression binary)
        {
            if (Column(binary.Left) is not var (column, kind))
                return Pushdown.Keep(PushdownReasons.Operator(Name(binary.Left)));

            if (binary.Kind is SyntaxKind.StartsWithExpression or SyntaxKind.StartsWithCsExpression)
            {
                // KQL's startswith ignores case; startswith_cs is kept to the same tables for simplicity.
                if (kind != Kind.String || !Allows(column, "startsWith"))
                    return Pushdown.Keep(PushdownReasons.Operator(column.Name));
                if (!table.DirectoryObject)
                    return Pushdown.Keep(PushdownReasons.CaseInsensitive);
                return Value(binary.Right, column, kind, Rounding.Exact, prefix => $"startswith({column.Name},{prefix})");
            }

            var (op, rounding) = binary.Kind switch
            {
                SyntaxKind.EqualExpression => ("eq", Rounding.Exact),
                // Graph's string eq ignores case on directory objects, so there it keeps at least what =~ keeps. Elsewhere it
                // may not.
                SyntaxKind.EqualTildeExpression when kind == Kind.String && table.DirectoryObject => ("eq", Rounding.Exact),
                // Graph's string ne ignores case too, so on strings it would keep fewer than != keeps. On directory objects
                // ne needs advanced query mode, which Graph query doesn't use.
                SyntaxKind.NotEqualExpression when kind != Kind.String && !table.DirectoryObject => ("ne", Rounding.Exact),
                // Graph's datetime precision isn't known, so a strict datetime bound is sent inclusive: it only widens.
                SyntaxKind.LessThanExpression when kind is Kind.DateTime => ("le", Rounding.Up),
                SyntaxKind.GreaterThanExpression when kind is Kind.DateTime => ("ge", Rounding.Down),
                SyntaxKind.LessThanExpression when kind is Kind.Number => ("lt", Rounding.Up),
                SyntaxKind.LessThanOrEqualExpression when kind is Kind.DateTime or Kind.Number => ("le", Rounding.Up),
                SyntaxKind.GreaterThanExpression when kind is Kind.Number => ("gt", Rounding.Down),
                SyntaxKind.GreaterThanOrEqualExpression when kind is Kind.DateTime or Kind.Number => ("ge", Rounding.Down),
                _ => (null, Rounding.Exact),
            };
            if (op is null)
            {
                return Pushdown.Keep(binary.Kind switch
                {
                    SyntaxKind.EqualTildeExpression when kind == Kind.String => PushdownReasons.CaseInsensitive,
                    SyntaxKind.NotEqualExpression when table.DirectoryObject => PushdownReasons.AdvancedQuery,
                    _ => PushdownReasons.Operator(column.Name),
                });
            }
            if (!Allows(column, op))
                return Pushdown.Keep(PushdownReasons.Operator(column.Name));
            return Value(binary.Right, column, kind, rounding, value => $"{column.Name} {op} {value}");
        }

        private Pushdown In(InExpression @in)
        {
            if (Column(@in.Left) is not var (column, kind))
                return Pushdown.Keep(PushdownReasons.Operator(Name(@in.Left)));
            if (kind is Kind.Bool || !Allows(column, "in"))
                return Pushdown.Keep(PushdownReasons.Operator(column.Name));
            // in~ ignores case, which Graph's in is only known to do on directory objects.
            if (@in.Operator.Text.Contains('~', StringComparison.Ordinal) && !table.DirectoryObject)
                return Pushdown.Keep(PushdownReasons.CaseInsensitive);
            if (@in.Right is not ExpressionList list || list.Expressions.Count == 0)
                return Pushdown.Keep(PushdownReasons.Operator(column.Name));
            var values = new List<string>();
            foreach (var element in list.Expressions)
            {
                var value = Value(element.Element, column, kind, Rounding.Exact, v => v);
                if (value.Filter is null)
                    return value;
                values.Add(value.Filter);
            }
            return Pushdown.Push($"{column.Name} in ({string.Join(",", values)})");
        }

        /// <summary><c>isnull(c)</c> and <c>isnotnull(c)</c>. A string is never null in KQL, so <c>isnotnull</c> keeps every
        /// row there and <c>ne null</c> would keep fewer: only <c>isnull</c> is pushed on strings. Neither is pushed on
        /// directory objects, where null checks need advanced query mode.</summary>
        private Pushdown NullCheck(FunctionCallExpression call)
        {
            var argument = call.ArgumentList.Expressions[0].Element;
            var isNull = call.ReferencedSymbol == Functions.IsNull;
            var isNotNull = call.ReferencedSymbol == Functions.IsNotNull;
            if ((isNull || isNotNull) && table.DirectoryObject)
                return Pushdown.Keep(PushdownReasons.AdvancedQuery);
            if (Column(argument) is not var (column, kind))
                return Pushdown.Keep(PushdownReasons.Operator(Name(argument)));
            if (isNull && Allows(column, "eq"))
                return Pushdown.Push($"{column.Name} eq null");
            if (isNotNull && kind == Kind.String)
                return Pushdown.Keep(PushdownReasons.IsNotNullOnText);
            if (isNotNull && Allows(column, "ne"))
                return Pushdown.Push($"{column.Name} ne null");
            return Pushdown.Keep(PushdownReasons.Operator(column.Name));
        }

        /// <summary><paramref name="expression"/> as a literal of the column's kind, formatted; else why not: an empty string
        /// is never pushed, and any other value Graph can't compare with (a column, a function of one, a datetime that isn't
        /// on a whole second for an exact match) counts as the operator not being allowed.</summary>
        private Pushdown Value(Expression expression, GraphColumn column, Kind kind, Rounding rounding, Func<string, string> format)
        {
            if (Literal(expression, kind, rounding) is { } value)
                return Pushdown.Push(format(value));
            return Pushdown.Keep(kind == Kind.String && Unwrap(expression) is LiteralExpression { LiteralValue: string { Length: 0 } }
                ? PushdownReasons.EmptyString
                : PushdownReasons.Operator(column.Name));
        }

        /// <summary>What a condition is about, for its reason: the column's name, or the expression as written.</summary>
        private static string Name(Expression expression) => Unwrap(expression) is NameReference reference ? reference.SimpleName : Text(expression);

        /// <summary>A top-level column of the table with a type that can be pushed. Nested fields and functions of columns
        /// are not columns.</summary>
        private (GraphColumn Column, Kind Kind)? Column(Expression expression)
        {
            if (Unwrap(expression) is not NameReference { ReferencedSymbol: ColumnSymbol symbol })
                return null;
            if (table.Columns.FirstOrDefault(c => c.Name == symbol.Name) is not { Collection: false } column)
                return null;
            Kind? kind = column.Type switch
            {
                "string" => Kind.String,
                "datetime" => Kind.DateTime,
                "int" or "long" or "real" => Kind.Number,
                "bool" => Kind.Bool,
                _ => null,
            };
            return kind is { } k ? (column, k) : null;
        }

        private static bool Allows(GraphColumn column, string op) => column.Filter.Contains(op, StringComparer.OrdinalIgnoreCase);

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
