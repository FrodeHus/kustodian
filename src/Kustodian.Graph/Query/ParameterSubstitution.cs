using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;

namespace Kustodian.Graph.Query;

/// <summary>A query parameter's value, as the host's saved-query parameter carries it. <see cref="Type"/> is <c>text</c>,
/// <c>number</c>, <c>timespan</c>, <c>datetime</c> or <c>list</c>.</summary>
public sealed record ParameterValue(string Name, string Type, string Value, bool Required);

/// <summary>A parameter whose value can't be read as its type; <see cref="Message"/> is the type's rule, as the user is told it.</summary>
public sealed record ParameterError(string Name, string Message);

/// <summary>The query with its parameters substituted, or why it couldn't be: <see cref="Missing"/> names the first required
/// parameter without a value, <see cref="Error"/> a value that isn't of its type. <see cref="MapBack"/> maps a 1-based line and
/// column in <see cref="Text"/> to the original query (a position inside a value maps to its placeholder).</summary>
public sealed record SubstitutionResult(string? Text, string? Missing, ParameterError? Error, Func<int, int, (int Line, int Column)> MapBack);

/// <summary>
/// Query parameters: <c>{name}</c> placeholders replaced by KQL literals. A value never changes the query's structure: each is
/// checked against its type and written as a literal (a string with every quote, backslash and line break escaped; a number
/// written invariantly; a timespan or date that matches a strict pattern; a list of such literals), with a space between it and
/// a neighbour it could otherwise run into (<c>@</c> or <c>h</c> before a string, <c>d</c> after a number). Placeholders are
/// found outside string literals and <c>//</c> comments only, and the text a value adds is never searched again.
/// </summary>
public static partial class ParameterSubstitution
{
    /// <summary>A placeholder: <c>{name}</c>, the name an identifier.</summary>
    [GeneratedRegex(@"\G\{([A-Za-z_][A-Za-z0-9_]*)\}", RegexOptions.CultureInvariant)]
    private static partial Regex PlaceholderPattern();

    [GeneratedRegex(@"^[0-9]+(\.[0-9]+)?(d|h|m|s|ms)\z", RegexOptions.CultureInvariant)]
    private static partial Regex Timespan();

    /// <summary>An ISO 8601 date, optionally with a time (minutes or more), a fraction of up to 7 digits and a zone.</summary>
    [GeneratedRegex(@"^[0-9]{4}-[0-9]{2}-[0-9]{2}(T[0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]{1,7})?)?(Z|[+-][0-9]{2}:[0-9]{2})?)?\z",
        RegexOptions.CultureInvariant)]
    private static partial Regex IsoDate();

    /// <summary>The operators after which a list is written as a tuple.</summary>
    private static readonly string[] InOperators = ["!in~", "!in", "in~", "in"];

    /// <summary>Characters a literal may touch without a space: none of them joins a literal into a longer token.</summary>
    private const string SafeNeighbours = "()[]{},;:=<>!|+-*/%~^&?";

    /// <summary>Placeholder names in order of first use.</summary>
    public static IReadOnlyList<string> Find(string kql) => Placeholders(kql).Select(p => p.Name).Distinct(StringComparer.Ordinal).ToList();

    public static SubstitutionResult Apply(string kql, IReadOnlyList<ParameterValue> values)
    {
        var byName = new Dictionary<string, ParameterValue>(StringComparer.Ordinal);
        foreach (var value in values)
            byName.TryAdd(value.Name, value);
        var placeholders = Placeholders(kql).Where(p => byName.ContainsKey(p.Name)).ToList();

        static (int, int) None(int line, int column) => (line, column);
        if (placeholders.Select(p => byName[p.Name]).FirstOrDefault(v => v.Required && string.IsNullOrWhiteSpace(v.Value)) is { } missing)
            return new SubstitutionResult(null, missing.Name, null, None);

        var text = new StringBuilder(kql.Length);
        var segments = new List<Segment>();
        var copied = 0;
        foreach (var placeholder in placeholders)
        {
            var value = byName[placeholder.Name];
            var (literal, error) = Literal(kql, placeholder, value);
            if (error is not null)
                return new SubstitutionResult(null, null, new ParameterError(value.Name, error), None);

            text.Append(kql, copied, placeholder.Start - copied);
            // The character before is the text as substituted so far: it may be the previous value's literal.
            if (text.Length > 0 && !Safe(text[^1]))
                literal = " " + literal;
            var end = placeholder.Start + placeholder.Length;
            if (end < kql.Length && !Safe(kql[end]))
                literal += " ";
            segments.Add(new Segment(placeholder.Start, placeholder.Length, text.Length, literal.Length));
            text.Append(literal);
            copied = end;
        }
        text.Append(kql, copied, kql.Length - copied);
        var substituted = text.ToString();
        return new SubstitutionResult(substituted, null, null, (line, column) => MapBack(kql, substituted, segments, line, column));
    }

    private static bool Safe(char neighbour) => char.IsWhiteSpace(neighbour) || SafeNeighbours.Contains(neighbour, StringComparison.Ordinal);

    /// <summary>A placeholder at <see cref="Start"/> in the original text.</summary>
    private sealed record Placeholder(string Name, int Start, int Length);

    /// <summary>A placeholder's span in the original text and the literal's in the substituted text.</summary>
    private sealed record Segment(int Start, int Length, int NewStart, int NewLength);

    /// <summary>The placeholders outside string literals (<c>"…"</c> and <c>'…'</c> with backslash escapes, <c>@"…"</c> and
    /// <c>@'…'</c> with doubled quotes, <c>```…```</c>) and <c>//</c> comments. An unterminated string or comment runs to the end
    /// of the text.</summary>
    private static IEnumerable<Placeholder> Placeholders(string kql)
    {
        var i = 0;
        while (i < kql.Length)
        {
            var c = kql[i];
            if (c == '/' && At(kql, i + 1, '/'))
            {
                i = kql.IndexOf('\n', i) is var newline and >= 0 ? newline + 1 : kql.Length;
            }
            else if (c == '`' && kql.AsSpan(i).StartsWith("```", StringComparison.Ordinal))
            {
                i = kql.IndexOf("```", i + 3, StringComparison.Ordinal) is var close and >= 0 ? close + 3 : kql.Length;
            }
            else if (c == '@' && (At(kql, i + 1, '"') || At(kql, i + 1, '\'')))
            {
                i = VerbatimEnd(kql, i + 1);
            }
            else if (c is '"' or '\'')
            {
                i = QuotedEnd(kql, i);
            }
            else if (c == '{' && PlaceholderPattern().Match(kql, i) is { Success: true } match)
            {
                yield return new Placeholder(match.Groups[1].Value, i, match.Length);
                i += match.Length;
            }
            else
            {
                i++;
            }
        }
    }

    private static bool At(string text, int index, char c) => index < text.Length && text[index] == c;

    /// <summary>The index after a regular string that opens at <paramref name="open"/>. A line break ends it as KQL does.</summary>
    private static int QuotedEnd(string kql, int open)
    {
        var quote = kql[open];
        for (var i = open + 1; i < kql.Length; i++)
        {
            if (kql[i] == '\\')
                i++;
            else if (kql[i] == quote || kql[i] is '\n' or '\r')
                return i + 1;
        }
        return kql.Length;
    }

    /// <summary>The index after a verbatim string whose quote is at <paramref name="open"/>: a doubled quote is part of it.</summary>
    private static int VerbatimEnd(string kql, int open)
    {
        var quote = kql[open];
        for (var i = open + 1; i < kql.Length; i++)
        {
            if (kql[i] != quote)
                continue;
            if (!At(kql, i + 1, quote))
                return i + 1;
            i++;
        }
        return kql.Length;
    }

    /// <summary>The literal for <paramref name="value"/> at <paramref name="placeholder"/>, or the type's rule when the value
    /// isn't of its type.</summary>
    private static (string Literal, string? Error) Literal(string kql, Placeholder placeholder, ParameterValue value)
    {
        var name = value.Name;
        var raw = value.Value ?? "";
        var empty = string.IsNullOrWhiteSpace(raw);
        switch (value.Type)
        {
            case "text":
                return (Text(raw), null);
            case "number":
                if (empty)
                    return ("long(null)", null);
                return Number(raw) is { } number ? (number, null) : ("", $"{name}: a number like 30 or 2.5.");
            case "timespan":
                if (empty)
                    return ("timespan(null)", null);
                return Timespan().IsMatch(raw.Trim()) ? (raw.Trim(), null) : ("", $"{name}: a timespan like 7d, 12h or 30m.");
            case "datetime":
                if (empty)
                    return ("datetime(null)", null);
                return Date(raw.Trim()) is { } date ? (date, null) : ("", $"{name}: a date like 2026-10-21 or 2026-10-21T08:30:00Z.");
            case "list":
                return (List(kql, placeholder, raw), null);
            default:
                return ("", $"{name}: unknown parameter type {value.Type}.");
        }
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
    private static string List(string kql, Placeholder placeholder, string value)
    {
        var lines = value.Split('\n').Select(l => l.Trim()).Where(l => l.Length > 0).ToList();
        var numbers = lines.Select(Number).ToList();
        var items = lines.Count > 0 && numbers.All(n => n is not null) ? numbers.Cast<string>().ToList() : lines.Select(Text).ToList();
        var tuple = AfterIn(kql, placeholder.Start);
        if (items.Count == 0)
            return tuple == false ? "(dynamic([]))" : "dynamic([])";
        var joined = string.Join(", ", items);
        return tuple switch
        {
            null => $"dynamic([{joined}])",
            true => joined,
            false => $"({joined})",
        };
    }

    /// <summary>Whether the text before <paramref name="start"/> ends in an <c>in</c> operator: null when it doesn't, true when
    /// the user wrote the opening parenthesis after it, false when not.</summary>
    private static bool? AfterIn(string kql, int start)
    {
        var i = SkipWhitespaceBack(kql, start);
        var parenthesis = i > 0 && kql[i - 1] == '(';
        if (parenthesis)
            i = SkipWhitespaceBack(kql, i - 1);
        foreach (var op in InOperators)
        {
            var from = i - op.Length;
            if (from >= 0 && string.CompareOrdinal(kql, from, op, 0, op.Length) == 0
                && (op[0] == '!' || from == 0 || !IsNameChar(kql[from - 1])))
                return parenthesis;
        }
        return null;
    }

    private static int SkipWhitespaceBack(string text, int index)
    {
        while (index > 0 && char.IsWhiteSpace(text[index - 1]))
            index--;
        return index;
    }

    private static bool IsNameChar(char c) => char.IsAsciiLetterOrDigit(c) || c == '_';

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
