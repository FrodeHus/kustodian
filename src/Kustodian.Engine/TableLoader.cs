using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Xml;
using Kustodian.Graph.Engine;
using Kusto.Language.Symbols;
using KustoLoco.Core;
using KustoLoco.Core.Util;

namespace Kustodian.Engine;

/// <summary>Builds the KustoLoco table for a fetched collection: every column the request names, filled where the objects
/// have it, each value converted to its column's Kusto type (complex values stay JSON). A value that doesn't convert is
/// null and counted.</summary>
internal static class TableLoader
{
    public static TableBuilder Load(EngineTable table, ref int dropped)
    {
        var builder = TableBuilder.CreateEmpty(table.Name, table.Rows.Count);
        foreach (var column in table.Columns)
        {
            var type = ScalarTypes.GetSymbol(column.Type) ?? ScalarTypes.Dynamic;
            var kustoType = type is DynamicSymbol ? "dynamic" : type.Name;
            var values = ColumnHelpers.CreateBuilder(type, column.Name);
            foreach (var row in table.Rows)
            {
                // A JSON null reads as a null node: null in the table, and not a dropped value.
                var node = row[column.Name];
                var value = Convert(node, kustoType);
                if (value is null && node is not null)
                    dropped++;
                values.Add(value);
            }
            builder = builder.WithColumn(column.Name, values.ToColumn());
        }
        return builder;
    }

    private static object? Convert(JsonNode? node, string kustoType)
    {
        if (node is null)
            return null;
        if (kustoType == "dynamic")
            return node.DeepClone();
        if (kustoType == "string")
            return node is JsonValue v && v.TryGetValue<string>(out var s) ? s : node.ToJsonString();
        if (node is not JsonValue value)
            return null;

        // Objects read from a frame hold JSON elements; ones built in code hold CLR values, which go through JSON once.
        var element = value.TryGetValue<JsonElement>(out var e) ? e : JsonSerializer.SerializeToElement(value);
        var text = element.ValueKind == JsonValueKind.String ? element.GetString()! : "";
        // Numbers may come as strings (OData's IEEE754Compatible form for 64-bit and decimal values).
        return (kustoType, element.ValueKind) switch
        {
            ("bool", JsonValueKind.True) => true,
            ("bool", JsonValueKind.False) => false,
            ("int", JsonValueKind.Number) => element.TryGetInt32(out var i) ? i : null,
            ("long", JsonValueKind.Number) => element.TryGetInt64(out var l) ? l : null,
            ("real", JsonValueKind.Number) => element.TryGetDouble(out var r) ? r : null,
            ("decimal", JsonValueKind.Number) => element.TryGetDecimal(out var m) ? m : null,
            ("int", JsonValueKind.String) => int.TryParse(text, NumberStyles.Integer, CultureInfo.InvariantCulture, out var i) ? i : null,
            ("long", JsonValueKind.String) => long.TryParse(text, NumberStyles.Integer, CultureInfo.InvariantCulture, out var l) ? l : null,
            ("real", JsonValueKind.String) => ParseReal(text),
            ("decimal", JsonValueKind.String) => decimal.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out var m) ? m : null,
            ("datetime", JsonValueKind.String) => DateTime.TryParse(text, CultureInfo.InvariantCulture,
                DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal, out var d) ? d : null,
            ("timespan", JsonValueKind.String) => ParseTimeSpan(text),
            ("guid", JsonValueKind.String) => Guid.TryParse(text, CultureInfo.InvariantCulture, out var g) ? g : null,
            _ => null,
        };
    }

    /// <summary>An XML duration (<c>P1DT2H</c>), or null; XmlConvert has no Try form.</summary>
    private static TimeSpan? ParseTimeSpan(string text)
    {
        try
        {
            return XmlConvert.ToTimeSpan(text);
        }
        catch (Exception ex) when (ex is FormatException or OverflowException)
        {
            return null;
        }
    }

    /// <summary>A real sent as text: a number, or OData's <c>NaN</c>, <c>INF</c> and <c>-INF</c>.</summary>
    private static double? ParseReal(string text) => text switch
    {
        "NaN" => double.NaN,
        "INF" => double.PositiveInfinity,
        "-INF" => double.NegativeInfinity,
        _ => double.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out var r) ? r : null,
    };
}
