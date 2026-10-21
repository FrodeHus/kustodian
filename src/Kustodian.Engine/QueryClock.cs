using System.Globalization;
using System.Text;
using Kusto.Language;
using Kusto.Language.Symbols;
using Kusto.Language.Syntax;

namespace Kustodian.Engine;

/// <summary>Pins the query's time to the run's: <c>now()</c>, <c>now(offset)</c> and <c>ago(span)</c> become datetime
/// literals of the request's <c>Now</c>, the same instant the planner pushed <c>$filter</c> bounds with, so Graph and the
/// engine agree on a row near the bound. And datetime literals with an offset or <c>Z</c> become their UTC instant.
/// <para>Why a rewrite: KustoLoco 1.4.9 has no clock to set (its <c>now()</c> and <c>ago()</c> read
/// <c>DateTime.UtcNow</c>), and its extra functions can't replace built-ins (they are merged into one dictionary, and a
/// duplicate key throws). Kusto.Language reads <c>datetime(…+02:00)</c> as local time, which KustoLoco then compares by
/// ticks with UTC values: off by the machine's offset unless rewritten.</para>
/// <para>Only calls Kusto.Language binds to the built-in functions are touched, and the rewrite works on the parse tree's
/// spans, so nothing inside strings or comments changes.</para></summary>
internal static class QueryClock
{
    private const string LiteralFormat = "yyyy-MM-dd HH:mm:ss.fffffff";

    /// <exception cref="FormatException">A datetime literal with an offset can't be read.</exception>
    public static string Rewrite(string kql, DateTime nowUtc)
    {
        var code = KustoCode.ParseAndAnalyze(kql, GlobalState.Default);
        var targets = code.Syntax
            .GetDescendants<Expression>(e => Replacement(e, nowUtc, _ => "") is not null)
            .OrderBy(e => e.TextStart)
            .ThenByDescending(e => e.Width)
            .ToList();
        if (targets.Count == 0)
            return kql;

        string Render(int start, int end)
        {
            var text = new StringBuilder();
            var position = start;
            foreach (var target in targets)
            {
                // Outermost first: anything starting before the position is inside a target already replaced.
                if (target.TextStart < position || target.TextStart < start || target.End > end)
                    continue;
                text.Append(kql, position, target.TextStart - position);
                text.Append(Replacement(target, nowUtc, argument => Render(argument.TextStart, argument.End)));
                position = target.End;
            }
            return text.Append(kql, position, end - position).ToString();
        }

        return Render(0, kql.Length);
    }

    /// <summary>The text that replaces <paramref name="expression"/>, or null when it stays. <paramref name="render"/> gives
    /// an argument's text with its own replacements.</summary>
    private static string? Replacement(Expression expression, DateTime nowUtc, Func<Expression, string> render)
    {
        var now = $"datetime({nowUtc.ToString(LiteralFormat, CultureInfo.InvariantCulture)})";
        switch (expression)
        {
            case FunctionCallExpression call when call.ReferencedSymbol == Functions.Now:
                return call.ArgumentList.Expressions.Count switch
                {
                    0 => now,
                    1 => $"({now} + ({render(call.ArgumentList.Expressions[0].Element)}))",
                    _ => null,
                };
            case FunctionCallExpression call when call.ReferencedSymbol == Functions.Ago && call.ArgumentList.Expressions.Count == 1:
                return $"({now} - ({render(call.ArgumentList.Expressions[0].Element)}))";
            case LiteralExpression { LiteralValue: DateTime { Kind: DateTimeKind.Local } } literal:
                return $"datetime({Utc(literal.Token.Text).ToString(LiteralFormat, CultureInfo.InvariantCulture)})";
            default:
                return null;
        }
    }

    /// <summary>A datetime literal's instant in UTC, read from its text (not through local time, which is ambiguous for an
    /// hour each autumn). A literal that can't be read throws <see cref="FormatException"/>: leaving Kusto.Language's
    /// local-time value would compare off by the machine's offset, silently.</summary>
    internal static DateTime Utc(string literalText)
    {
        var open = literalText.IndexOf('(', StringComparison.Ordinal);
        var close = literalText.LastIndexOf(')');
        if (open >= 0 && close > open
            && DateTime.TryParse(literalText[(open + 1)..close].Trim(), CultureInfo.InvariantCulture,
                DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal, out var value))
            return value;
        throw new FormatException($"Can't read {literalText} as a point in time. Write it as datetime(yyyy-MM-ddTHH:mm:ssZ).");
    }
}
