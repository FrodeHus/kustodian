using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;
using Kusto.Language;
using Kusto.Language.Parsing;
using Kusto.Language.Syntax;

namespace Kustodian.Graph.Query;

/// <summary>A query parameter's value, as the host's saved-query parameter carries it. <see cref="Type"/> is <c>text</c>,
/// <c>number</c>, <c>timespan</c>, <c>datetime</c> or <c>list</c>.</summary>
public sealed record ParameterValue(string Name, string Type, string Value, bool Required);

/// <summary>A parameter whose value can't be used: not of its type, or not fitting where its placeholder is.
/// <see cref="Message"/> is shown to the user.</summary>
public sealed record ParameterError(string Name, string Message);

/// <summary>The query with its parameters substituted, or why it couldn't be: <see cref="Missing"/> names the first required
/// parameter without a value, <see cref="Error"/> a value that can't be used. <see cref="MapBack"/> maps a 1-based line and
/// column in <see cref="Text"/> to the original query (a position inside a value maps to its placeholder).</summary>
public sealed record SubstitutionResult(string? Text, string? Missing, ParameterError? Error, Func<int, int, (int Line, int Column)> MapBack);

/// <summary>
/// Query parameters: <c>{name}</c> placeholders replaced by KQL literals. A value never changes the query's structure:
/// <list type="bullet">
/// <item>Placeholders are found with Kusto's own lexer: a <c>{</c>, a name and a <c>}</c> token with nothing between them, so
/// nothing inside a literal token (strings in every form, <c>datetime(…)</c> and the other raw literals) or a comment counts.</item>
/// <item>Each value is checked against its type and written as a literal (a string with every quote, backslash and control
/// character escaped; a number written invariantly; a timespan or date that matches a strict pattern; a list of such literals),
/// with a space between it and a neighbour it could otherwise run into.</item>
/// <item>The result is lexed again, and each value has to be exactly the literal tokens it was written as; otherwise the value
/// "doesn't fit where the placeholder is".</item>
/// </list>
/// The text a value adds is never searched for placeholders again.
/// </summary>
public static partial class ParameterSubstitution
{
    [GeneratedRegex(@"^[A-Za-z_][A-Za-z0-9_]*\z", RegexOptions.CultureInvariant)]
    private static partial Regex Name();

    [GeneratedRegex(@"^[0-9]+(\.[0-9]+)?(d|h|m|s|ms)\z", RegexOptions.CultureInvariant)]
    private static partial Regex Timespan();

    /// <summary>An ISO 8601 date, optionally with a time (minutes or more), a fraction of up to 7 digits and a zone.</summary>
    [GeneratedRegex(@"^[0-9]{4}-[0-9]{2}-[0-9]{2}(T[0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]{1,7})?)?(Z|[+-][0-9]{2}:[0-9]{2})?)?\z",
        RegexOptions.CultureInvariant)]
    private static partial Regex IsoDate();

    /// <summary>Characters a literal may touch without a space: none of them joins a literal into a longer token.</summary>
    private const string SafeNeighbours = "()[]{},;:=<>!|+-*/%^&?";

    /// <summary>The tokens a value may be written as.</summary>
    private static readonly HashSet<SyntaxKind> LiteralTokens =
    [
        SyntaxKind.StringLiteralToken, SyntaxKind.LongLiteralToken, SyntaxKind.RealLiteralToken, SyntaxKind.TimespanLiteralToken,
        SyntaxKind.DateTimeLiteralToken,
    ];

    private static readonly HashSet<SyntaxKind> InOperators =
        [SyntaxKind.InKeyword, SyntaxKind.InCsKeyword, SyntaxKind.NotInKeyword, SyntaxKind.NotInCsKeyword];

    /// <summary>Placeholder names in order of first use.</summary>
    public static IReadOnlyList<string> Find(string kql)
        => Placeholders(Lex(kql)).Select(p => p.Name).Distinct(StringComparer.Ordinal).ToList();

    public static SubstitutionResult Apply(string kql, IReadOnlyList<ParameterValue> values)
    {
        var byName = new Dictionary<string, ParameterValue>(StringComparer.Ordinal);
        foreach (var value in values)
            byName.TryAdd(value.Name, value);
        var tokens = Lex(kql);
        var placeholders = Placeholders(tokens).Where(p => byName.ContainsKey(p.Name)).ToList();

        static (int, int) None(int line, int column) => (line, column);
        SubstitutionResult Failed(string name, string message) => new(null, null, new ParameterError(name, message), None);

        if (placeholders.Select(p => byName[p.Name]).FirstOrDefault(v => v.Required && string.IsNullOrWhiteSpace(v.Value)) is { } missing)
            return new SubstitutionResult(null, missing.Name, null, None);
        // A placeholder inside a raw literal (datetime({start})) is part of that token, not a placeholder: say so rather than run
        // the text as written. One inside a string is the string's own text.
        if (InsideRawLiteral(tokens, byName.Keys) is { } inside)
            return Failed(inside, DoesNotFit(inside));

        var text = new StringBuilder(kql.Length);
        var segments = new List<Segment>();
        var copied = 0;
        foreach (var placeholder in placeholders)
        {
            var value = byName[placeholder.Name];
            var (literal, shape, error) = Literal(tokens, placeholder, value);
            if (error is not null)
                return Failed(value.Name, error);

            text.Append(kql, copied, placeholder.Start - copied);
            // The character before is the text as substituted so far: it may be the previous value's literal.
            var before = text.Length > 0 && !Safe(text[^1]) ? " " : "";
            var end = placeholder.Start + placeholder.Length;
            var after = end < kql.Length && !Safe(kql[end]) ? " " : "";
            segments.Add(new Segment(value.Name, placeholder.Start, placeholder.Length, text.Length, before.Length + literal.Length + after.Length,
                text.Length + before.Length, literal.Length, shape));
            text.Append(before).Append(literal).Append(after);
            copied = end;
        }
        text.Append(kql, copied, kql.Length - copied);
        var substituted = text.ToString();

        if (segments.Count > 0)
        {
            var result = Lex(substituted);
            if (segments.FirstOrDefault(s => !Fits(result, s)) is { } misfit)
                return Failed(misfit.Name, DoesNotFit(misfit.Name));
        }
        return new SubstitutionResult(substituted, null, null, (line, column) => MapBack(kql, substituted, segments, line, column));
    }

    private static string DoesNotFit(string name) => $"{name}: the value doesn't fit where the placeholder is.";

    private static bool Safe(char neighbour) => char.IsWhiteSpace(neighbour) || SafeNeighbours.Contains(neighbour, StringComparison.Ordinal);

    /// <summary>A token as Kusto lexes it, with where its text (after its trivia) starts.</summary>
    private sealed record Token(SyntaxKind Kind, string Trivia, string Text, int Start)
    {
        public int End => Start + Text.Length;
    }

    /// <summary>A placeholder at <see cref="Start"/> in the original text; <see cref="Open"/> is the index of its <c>{</c> token.</summary>
    private sealed record Placeholder(string Name, int Start, int Length, int Open);

    /// <summary>How a value was written: one literal, or a list of <see cref="Items"/> literals in one of the list forms.</summary>
    internal enum Form
    {
        Scalar,
        Bare,
        Tuple,
        Dynamic,
        TupleOfDynamic,
    }

    internal sealed record Shape(Form Form, int Items);

    /// <summary>A placeholder's span in the original text, the span that replaced it (with any padding), and the literal's own
    /// span within it.</summary>
    internal sealed record Segment(string Name, int Start, int Length, int NewStart, int NewLength, int LiteralStart, int LiteralLength,
        Shape Shape);

    private static List<Token> Lex(string text)
    {
        var tokens = new List<Token>();
        var position = 0;
        foreach (var token in TokenParser.ParseTokens(text, ParseOptions.Default))
        {
            tokens.Add(new Token(token.Kind, token.Trivia, token.Text, position + token.Trivia.Length));
            position += token.Length;
        }
        return tokens;
    }

    /// <summary>The placeholders: a <c>{</c> token, a name token (an identifier, or a keyword spelled as one) and a <c>}</c>
    /// token, with no trivia between them.</summary>
    private static IEnumerable<Placeholder> Placeholders(List<Token> tokens)
    {
        for (var i = 0; i + 2 < tokens.Count; i++)
        {
            if (tokens[i].Kind == SyntaxKind.OpenBraceToken && tokens[i + 1].Trivia.Length == 0 && Name().IsMatch(tokens[i + 1].Text)
                && tokens[i + 2].Kind == SyntaxKind.CloseBraceToken && tokens[i + 2].Trivia.Length == 0)
            {
                yield return new Placeholder(tokens[i + 1].Text, tokens[i].Start, tokens[i + 2].End - tokens[i].Start, i);
                i += 2;
            }
        }
    }

    /// <summary>The first of <paramref name="names"/> written as a placeholder inside a literal token other than a string.</summary>
    private static string? InsideRawLiteral(List<Token> tokens, IEnumerable<string> names)
    {
        var raw = tokens.Where(t => t.Kind != SyntaxKind.StringLiteralToken && t.Kind.ToString().EndsWith("LiteralToken", StringComparison.Ordinal))
            .ToList();
        return names.FirstOrDefault(n => raw.Exists(t => t.Text.Contains("{" + n + "}", StringComparison.Ordinal)));
    }

    /// <summary>Whether <paramref name="substituted"/> lexes, at <paramref name="segment"/>, into exactly the tokens its value was
    /// written as (the check <see cref="Apply"/> makes after substituting).</summary>
    internal static bool Fits(string substituted, Segment segment) => Fits(Lex(substituted), segment);

    /// <summary>Whether the substituted text lexes, at <paramref name="segment"/>, into exactly the tokens its value was written
    /// as: one literal, or a list form made only of literals (a number may have a leading minus) and commas.</summary>
    private static bool Fits(List<Token> tokens, Segment segment)
    {
        var start = segment.LiteralStart;
        var end = start + segment.LiteralLength;
        var first = tokens.FindIndex(t => t.Start >= start && t.Text.Length > 0);
        if (first < 0 || tokens[first].Start != start)
            return false;
        var span = tokens.Skip(first).TakeWhile(t => t.Start < end).ToList();
        if (span.Count == 0 || span[^1].End != end)
            return false;

        var i = 0;
        bool Next(SyntaxKind kind) => i < span.Count && span[i++].Kind == kind;
        bool Item()
        {
            if (i < span.Count && span[i].Kind == SyntaxKind.MinusToken && segment.Shape.Form != Form.Scalar)
            {
                i++;
                if (i >= span.Count || span[i].Trivia.Length > 0 || span[i].Kind is not (SyntaxKind.LongLiteralToken or SyntaxKind.RealLiteralToken))
                    return false;
            }
            return i < span.Count && LiteralTokens.Contains(span[i++].Kind);
        }
        bool Items(int count)
        {
            for (var n = 0; n < count; n++)
            {
                if ((n > 0 && !Next(SyntaxKind.CommaToken)) || !Item())
                    return false;
            }
            return true;
        }
        bool Dynamic(int count) => Next(SyntaxKind.DynamicKeyword) && Next(SyntaxKind.OpenParenToken) && Next(SyntaxKind.OpenBracketToken)
            && Items(count) && Next(SyntaxKind.CloseBracketToken) && Next(SyntaxKind.CloseParenToken);

        var items = segment.Shape.Items;
        var matched = segment.Shape.Form switch
        {
            Form.Scalar => Item(),
            Form.Bare => Items(items),
            Form.Tuple => Next(SyntaxKind.OpenParenToken) && Items(items) && Next(SyntaxKind.CloseParenToken),
            Form.Dynamic => Dynamic(items),
            Form.TupleOfDynamic => Next(SyntaxKind.OpenParenToken) && Dynamic(0) && Next(SyntaxKind.CloseParenToken),
            _ => false,
        };
        return matched && i == span.Count;
    }

    /// <summary>The literal for <paramref name="value"/> at <paramref name="placeholder"/> and how it is shaped, or the type's rule
    /// when the value isn't of its type.</summary>
    private static (string Literal, Shape Shape, string? Error) Literal(List<Token> tokens, Placeholder placeholder, ParameterValue value)
    {
        var name = value.Name;
        var raw = value.Value ?? "";
        var empty = string.IsNullOrWhiteSpace(raw);
        var scalar = new Shape(Form.Scalar, 1);
        switch (value.Type)
        {
            case "text":
                return (Text(raw), scalar, null);
            case "number":
                if (empty)
                    return ("long(null)", scalar, null);
                return Number(raw) is { } number ? (OneToken(number), scalar, null) : ("", scalar, $"{name}: a number like 30 or 2.5.");
            case "timespan":
                if (empty)
                    return ("timespan(null)", scalar, null);
                return Timespan().IsMatch(raw.Trim()) ? (raw.Trim(), scalar, null) : ("", scalar, $"{name}: a timespan like 7d, 12h or 30m.");
            case "datetime":
                if (empty)
                    return ("datetime(null)", scalar, null);
                return Date(raw.Trim()) is { } date
                    ? (date, scalar, null)
                    : ("", scalar, $"{name}: a date like 2026-10-21 or 2026-10-21T08:30:00Z.");
            case "list":
                var (list, shape) = List(tokens, placeholder, raw);
                return (list, shape, null);
            default:
                return ("", scalar, $"{name}: unknown parameter type {value.Type}.");
        }
    }

    /// <summary>A number as one token: a negative one as <c>long(-7)</c> or <c>real(-2.5)</c>, since <c>-7</c> is a minus and a
    /// literal.</summary>
    private static string OneToken(string number)
    {
        if (!number.StartsWith('-'))
            return number;
        var real = number.Contains('.', StringComparison.Ordinal) || number.Contains('E', StringComparison.Ordinal);
        return (real ? "real(" : "long(") + number + ")";
    }

    /// <summary>A double-quoted string: backslash, quote and every control character escaped, so it can't end early or span
    /// lines.</summary>
    private static string Text(string value)
    {
        var literal = new StringBuilder(value.Length + 2).Append('"');
        foreach (var c in value)
        {
            _ = c switch
            {
                '\\' => literal.Append(@"\\"),
                '"' => literal.Append("\\\""),
                '\n' => literal.Append(@"\n"),
                '\r' => literal.Append(@"\r"),
                '\t' => literal.Append(@"\t"),
                _ when char.IsControl(c) => literal.Append(CultureInfo.InvariantCulture, $"\\u{(int)c:x4}"),
                _ => literal.Append(c),
            };
        }
        return literal.Append('"').ToString();
    }

    /// <summary>A long or a finite double, written invariantly; a double always as a real (with a point or an exponent).</summary>
    private static string? Number(string value)
    {
        var trimmed = value.Trim();
        if (long.TryParse(trimmed, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out var whole))
            return whole.ToString(CultureInfo.InvariantCulture);
        if (!double.TryParse(trimmed, NumberStyles.AllowLeadingSign | NumberStyles.AllowDecimalPoint | NumberStyles.AllowExponent,
                CultureInfo.InvariantCulture, out var real) || !double.IsFinite(real))
            return null;
        var text = real.ToString("R", CultureInfo.InvariantCulture);
        return text.Contains('.', StringComparison.Ordinal) || text.Contains('E', StringComparison.Ordinal) ? text : text + ".0";
    }

    /// <summary>An ISO 8601 date as a UTC <c>datetime(…)</c>; a date or time without a zone is UTC.</summary>
    private static string? Date(string value)
    {
        if (!IsoDate().IsMatch(value)
            || !DateTimeOffset.TryParse(value, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var date))
            return null;
        return "datetime(" + date.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.FFFFFFF'Z'", CultureInfo.InvariantCulture) + ")";
    }

    /// <summary>One value per non-blank line, each trimmed: numbers when every one is a number, otherwise strings. A tuple
    /// after an <c>in</c> operator (bare when the user wrote its parenthesis), otherwise a dynamic array.</summary>
    private static (string Literal, Shape Shape) List(List<Token> tokens, Placeholder placeholder, string value)
    {
        var lines = value.Split('\n').Select(l => l.Trim()).Where(l => l.Length > 0).ToList();
        var numbers = lines.Select(Number).ToList();
        var items = lines.Count > 0 && numbers.All(n => n is not null) ? numbers.Cast<string>().ToList() : lines.Select(Text).ToList();
        var tuple = AfterIn(tokens, placeholder.Open);
        if (items.Count == 0)
            return tuple == false ? ("(dynamic([]))", new Shape(Form.TupleOfDynamic, 0)) : ("dynamic([])", new Shape(Form.Dynamic, 0));
        var joined = string.Join(", ", items);
        return tuple switch
        {
            null => ($"dynamic([{joined}])", new Shape(Form.Dynamic, items.Count)),
            true => (joined, new Shape(Form.Bare, items.Count)),
            false => ($"({joined})", new Shape(Form.Tuple, items.Count)),
        };
    }

    /// <summary>Whether the token before the placeholder's <c>{</c> (token <paramref name="open"/>) is an <c>in</c> operator:
    /// null when it isn't, true when the user wrote an opening parenthesis between them, false when not.</summary>
    private static bool? AfterIn(List<Token> tokens, int open)
    {
        var before = open - 1;
        var parenthesis = before >= 0 && tokens[before].Kind == SyntaxKind.OpenParenToken;
        if (parenthesis)
            before--;
        return before >= 0 && InOperators.Contains(tokens[before].Kind) ? parenthesis : null;
    }

    /// <summary>A position in the substituted text, as a position in the original: after a literal it moves back by what the
    /// literal added, inside one it is the placeholder's start.</summary>
    private static (int Line, int Column) MapBack(string original, string substituted, List<Segment> segments, int line, int column)
    {
        var offset = Offset(substituted, line, column);
        var mapped = offset;
        foreach (var segment in segments)
        {
            if (offset < segment.NewStart)
                break;
            mapped = offset < segment.NewStart + segment.NewLength
                ? segment.Start
                : segment.Start + segment.Length + (offset - segment.NewStart - segment.NewLength);
        }
        return Position(original, mapped);
    }

    /// <summary>The character offset of a 1-based line and column, clamped to the text.</summary>
    private static int Offset(string text, int line, int column)
    {
        var lineStart = 0;
        for (var current = 1; current < line; current++)
        {
            var newline = text.IndexOf('\n', lineStart);
            if (newline < 0)
                return text.Length;
            lineStart = newline + 1;
        }
        return Math.Clamp(lineStart + column - 1, lineStart, text.Length);
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
