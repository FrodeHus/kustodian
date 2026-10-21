using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;
using Kustodian.Graph.Engine;

namespace Kustodian.Sources;

/// <summary>Turns rows a server sends as JSON objects (advanced hunting's <c>results</c>, Resource Graph's <c>objectArray</c>)
/// into the positional rows a <see cref="Graph.Run.RunResult"/> carries.</summary>
public static partial class ServerRows
{
    private static readonly JsonElement Null = JsonDocument.Parse("null").RootElement.Clone();

    /// <summary>The columns and the rows, one value per column in column order, null where a row has no such key (or isn't an
    /// object). <paramref name="declared"/> columns, when there are any, are the columns (their types normalized,
    /// <see cref="NormalizeType"/>), and keys they don't name are dropped. Otherwise the columns are every key in the order it
    /// first appears, each typed from its values: <c>long</c>, <c>real</c> (whole and fractional numbers together too),
    /// <c>bool</c>, <c>datetime</c> for ISO 8601 strings with a zone, <c>dynamic</c> for objects and arrays, and <c>string</c>
    /// for strings, mixed values, and columns with only nulls.</summary>
    public static (IReadOnlyList<EngineColumn> Columns, IReadOnlyList<JsonElement[]> Rows) Shape(IEnumerable<JsonElement> objectRows,
        IReadOnlyList<EngineColumn>? declared)
    {
        var source = objectRows as IReadOnlyCollection<JsonElement> ?? objectRows.ToList();
        var columns = declared is { Count: > 0 }
            ? declared.Select(c => c with { Type = NormalizeType(c.Type) }).ToList()
            : Infer(source);
        var index = new Dictionary<string, int>(StringComparer.Ordinal);
        for (var i = 0; i < columns.Count; i++)
        {
            index.TryAdd(columns[i].Name, i);
        }

        var rows = new List<JsonElement[]>(source.Count);
        foreach (var row in source)
        {
            var values = new JsonElement[columns.Count];
            Array.Fill(values, Null);
            if (row.ValueKind == JsonValueKind.Object)
            {
                foreach (var property in row.EnumerateObject())
                {
                    if (index.TryGetValue(property.Name, out var i))
                    {
                        values[i] = property.Value.Clone();
                    }
                }
            }

            rows.Add(values);
        }

        return (columns, rows);
    }

    /// <summary>A server's type name as the engine names it: <c>int64</c> and <c>integer</c> are <c>long</c>, <c>int32</c> is
    /// <c>int</c>, <c>double</c>, <c>single</c> and <c>number</c> are <c>real</c>, <c>boolean</c> is <c>bool</c>, <c>object</c>
    /// and <c>array</c> are <c>dynamic</c>, and an empty name is <c>string</c>. Others are lower-cased.</summary>
    public static string NormalizeType(string type) => type.Trim().ToLowerInvariant() switch
    {
        "" => "string",
        "int64" or "integer" => "long",
        "int32" => "int",
        "double" or "single" or "number" => "real",
        "boolean" => "bool",
        "object" or "array" => "dynamic",
        var other => other,
    };

    private static List<EngineColumn> Infer(IEnumerable<JsonElement> rows)
    {
        var order = new List<string>();
        var types = new Dictionary<string, string?>(StringComparer.Ordinal);
        foreach (var row in rows)
        {
            if (row.ValueKind != JsonValueKind.Object)
            {
                continue;
            }

            foreach (var property in row.EnumerateObject())
            {
                if (!types.TryGetValue(property.Name, out var current))
                {
                    order.Add(property.Name);
                    current = null;
                }

                types[property.Name] = Combine(current, TypeOf(property.Value));
            }
        }

        return order.Select(name => new EngineColumn(name, types[name] ?? "string")).ToList();
    }

    /// <summary>The type of a column that held <paramref name="current"/> (null: only nulls so far) and now a value of type
    /// <paramref name="next"/> (null for a null).</summary>
    private static string? Combine(string? current, string? next) => (current, next) switch
    {
        (null, _) => next,
        (_, null) => current,
        _ when current == next => current,
        ("long", "real") or ("real", "long") => "real",
        _ => "string",
    };

    private static string? TypeOf(JsonElement value) => value.ValueKind switch
    {
        JsonValueKind.Null or JsonValueKind.Undefined => null,
        JsonValueKind.Number => value.TryGetInt64(out _) ? "long" : "real",
        JsonValueKind.True or JsonValueKind.False => "bool",
        JsonValueKind.Object or JsonValueKind.Array => "dynamic",
        JsonValueKind.String when IsZonedDateTime(value.GetString()!) => "datetime",
        _ => "string",
    };

    private static bool IsZonedDateTime(string text) =>
        ZonedDateTime().IsMatch(text)
        && DateTimeOffset.TryParse(text, CultureInfo.InvariantCulture, DateTimeStyles.None, out _);

    [GeneratedRegex(@"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(?::[0-9]{2}(?:\.[0-9]{1,9})?)?(?:Z|[+-][0-9]{2}:[0-9]{2})\z",
        RegexOptions.CultureInvariant | RegexOptions.IgnoreCase)]
    private static partial Regex ZonedDateTime();
}
