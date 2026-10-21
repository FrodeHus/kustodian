using System.Globalization;
using System.Text;
using System.Text.Json.Nodes;

namespace Kustodian.Engine.Tests;

/// <summary>Graph's <c>$filter</c>, for the operators <c>GraphFilterTranslator</c> emits: <c>eq ne lt le gt ge in</c>,
/// <c>startswith(c,'x')</c>, <c>and</c>, <c>or</c>, parentheses; string, number, bool, datetime and null literals. String
/// <c>eq</c>, <c>in</c> and <c>startswith</c> ignore case on directory objects, as Graph's do. OData null rules: <c>null eq
/// null</c> and <c>null ne x</c> are true, an ordering comparison with null is false.</summary>
internal static class ODataMatcher
{
    public static bool Matches(string filter, JsonObject row, bool directoryObject)
    {
        var parser = new Parser(Tokenize(filter), row, directoryObject);
        var result = parser.Or();
        if (!parser.AtEnd)
            throw new FormatException($"Unexpected text in $filter: {filter}");
        return result;
    }

    private sealed class Parser(List<string> tokens, JsonObject row, bool directoryObject)
    {
        private int _position;

        public bool AtEnd => _position == tokens.Count;

        private string Peek => _position < tokens.Count ? tokens[_position] : "";

        private string Next() => tokens[_position++];

        private void Expect(string token)
        {
            if (Next() != token)
                throw new FormatException($"Expected {token}");
        }

        public bool Or()
        {
            var value = And();
            while (Peek == "or")
            {
                Next();
                value |= And();
            }
            return value;
        }

        private bool And()
        {
            var value = Primary();
            while (Peek == "and")
            {
                Next();
                value &= Primary();
            }
            return value;
        }

        private bool Primary()
        {
            if (Peek == "(")
            {
                Next();
                var inner = Or();
                Expect(")");
                return inner;
            }
            if (Peek == "startswith")
            {
                Next();
                Expect("(");
                var column = Next();
                Expect(",");
                var prefix = Literal(Next());
                Expect(")");
                return row[column] is JsonValue v && v.TryGetValue<string>(out var s) && prefix is string p
                    && s.StartsWith(p, directoryObject ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal);
            }

            var name = Next();
            var op = Next();
            if (op == "in")
            {
                Expect("(");
                var any = false;
                do
                {
                    any |= Compare(row[name], "eq", Literal(Next()));
                }
                while (Peek == "," && Next() == ",");
                Expect(")");
                return any;
            }
            return Compare(row[name], op, Literal(Next()));
        }

        private bool Compare(JsonNode? node, string op, object? literal)
        {
            if (literal is null || node is null)
            {
                var bothNull = literal is null && node is null;
                return op switch
                {
                    "eq" => bothNull,
                    "ne" => !bothNull,
                    _ => false,
                };
            }

            var value = (JsonValue)node;
            int order;
            switch (literal)
            {
                case string text:
                    order = string.Compare(value.GetValue<string>(), text, directoryObject ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal);
                    break;
                case DateTime instant:
                    order = DateTime.Parse(value.GetValue<string>(), CultureInfo.InvariantCulture,
                        DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal).CompareTo(instant);
                    break;
                case double number:
                    order = double.Parse(value.ToJsonString(), NumberStyles.Float, CultureInfo.InvariantCulture).CompareTo(number);
                    break;
                case bool flag:
                    if (op is not ("eq" or "ne"))
                        throw new FormatException("Ordering on a bool");
                    order = value.GetValue<bool>() == flag ? 0 : 1;
                    break;
                default:
                    throw new FormatException($"Literal {literal}");
            }
            return op switch
            {
                "eq" => order == 0,
                "ne" => order != 0,
                "lt" => order < 0,
                "le" => order <= 0,
                "gt" => order > 0,
                "ge" => order >= 0,
                _ => throw new FormatException($"Operator {op}"),
            };
        }

        private static object? Literal(string token)
        {
            if (token.StartsWith('\''))
                return token[1..^1].Replace("''", "'", StringComparison.Ordinal);
            switch (token)
            {
                case "null":
                    return null;
                case "true":
                    return true;
                case "false":
                    return false;
            }
            if (token.EndsWith('Z') && token.Contains('T', StringComparison.Ordinal))
                return DateTime.ParseExact(token, "yyyy-MM-dd'T'HH:mm:ss'Z'", CultureInfo.InvariantCulture,
                    DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal);
            return double.Parse(token, NumberStyles.Float, CultureInfo.InvariantCulture);
        }
    }

    private static List<string> Tokenize(string filter)
    {
        var tokens = new List<string>();
        for (var i = 0; i < filter.Length;)
        {
            var c = filter[i];
            if (c == ' ')
            {
                i++;
            }
            else if (c is '(' or ')' or ',')
            {
                tokens.Add(c.ToString());
                i++;
            }
            else if (c == '\'')
            {
                var text = new StringBuilder("'");
                i++;
                while (true)
                {
                    if (filter[i] == '\'' && i + 1 < filter.Length && filter[i + 1] == '\'')
                    {
                        text.Append("''");
                        i += 2;
                    }
                    else if (filter[i] == '\'')
                    {
                        i++;
                        break;
                    }
                    else
                    {
                        text.Append(filter[i++]);
                    }
                }
                tokens.Add(text.Append('\'').ToString());
            }
            else
            {
                var start = i;
                while (i < filter.Length && filter[i] is not (' ' or '(' or ')' or ','))
                    i++;
                tokens.Add(filter[start..i]);
            }
        }
        return tokens;
    }
}
