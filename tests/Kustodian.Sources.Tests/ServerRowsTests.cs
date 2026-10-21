using System.Text.Json;
using Kustodian.Graph.Engine;

namespace Kustodian.Sources.Tests;

public class ServerRowsTests
{
    [Fact]
    public void Shape_maps_object_rows_to_positional_by_declared_columns()
    {
        var rows = Rows("""
            [
              {"Name": "a", "Count": 1, "Timestamp": "2026-10-01T00:00:00Z"},
              {"Count": 2, "Extra": "ignored"}
            ]
            """);
        EngineColumn[] declared = [new("Timestamp", "DateTime"), new("Count", "Int64"), new("Name", "String")];

        var (columns, shaped) = ServerRows.Shape(rows, declared);

        Assert.Equal([new("Timestamp", "datetime"), new("Count", "long"), new("Name", "string")], columns);
        Assert.Equal(2, shaped.Count);
        Assert.Equal(["\"2026-10-01T00:00:00Z\"", "1", "\"a\""], shaped[0].Select(v => v.GetRawText()));
        Assert.Equal([JsonValueKind.Null, JsonValueKind.Number, JsonValueKind.Null], shaped[1].Select(v => v.ValueKind));
    }

    [Fact]
    public void Shape_infers_columns_in_first_appearance_order()
    {
        var rows = Rows("""
            [
              {"id": 1, "name": "x"},
              {"name": "y", "props": {"a": 1}, "when": "2026-10-01T08:00:00+02:00", "ok": true, "score": 1.5, "tags": ["t"],
               "local": "2026-10-01T08:00:00"},
              {"id": 2.5, "score": 2}
            ]
            """);

        var (columns, shaped) = ServerRows.Shape(rows, null);

        Assert.Equal(
            [new("id", "real"), new("name", "string"), new("props", "dynamic"), new("when", "datetime"), new("ok", "bool"),
             new("score", "real"), new("tags", "dynamic"), new("local", "string")],
            columns);
        Assert.Equal(3, shaped.Count);
        Assert.All(shaped, row => Assert.Equal(columns.Count, row.Length));
        Assert.Equal(["1", "\"x\"", "null", "null", "null", "null", "null", "null"], shaped[0].Select(v => v.GetRawText()));
        Assert.Equal("""{"a": 1}""", shaped[1][2].GetRawText());
    }

    [Fact]
    public void Shape_infers_long_for_whole_numbers_and_string_for_mixed_or_empty_columns()
    {
        var rows = Rows("""[{"n": 1, "mixed": 1, "empty": null}, {"n": 2, "mixed": "two", "empty": null}]""");

        var (columns, _) = ServerRows.Shape(rows, null);

        Assert.Equal([new("n", "long"), new("mixed", "string"), new("empty", "string")], columns);
    }

    [Fact]
    public void Shape_with_no_rows_and_no_declared_columns_is_empty()
    {
        var (columns, shaped) = ServerRows.Shape([], null);

        Assert.Empty(columns);
        Assert.Empty(shaped);
    }

    [Theory]
    [InlineData("Int64", "long")]
    [InlineData("int32", "int")]
    [InlineData("Double", "real")]
    [InlineData("single", "real")]
    [InlineData("Boolean", "bool")]
    [InlineData("object", "dynamic")]
    [InlineData("array", "dynamic")]
    [InlineData("integer", "long")]
    [InlineData("number", "real")]
    [InlineData("", "string")]
    [InlineData("DateTime", "datetime")]
    [InlineData("String", "string")]
    public void NormalizeType_maps_server_types_to_engine_types(string type, string expected) =>
        Assert.Equal(expected, ServerRows.NormalizeType(type));

    private static JsonElement[] Rows(string json)
    {
        using var doc = JsonDocument.Parse(json);
        return doc.RootElement.EnumerateArray().Select(e => e.Clone()).ToArray();
    }
}
