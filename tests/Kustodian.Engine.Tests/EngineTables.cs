using System.Text.Json.Nodes;
using Kustodian.Graph.Engine;
using Kustodian.Graph.Schema;

namespace Kustodian.Engine.Tests;

/// <summary>Engine tables built the way the app builds them: the schema's columns, rows as Graph returned them.</summary>
internal static class EngineTables
{
    public static EngineTable FromFixture(string table) =>
        Of(GraphSchemaCatalog.Beta.Find(table)!, ReadFixture(table));

    public static EngineTable Of(GraphTable table, IReadOnlyList<JsonObject> rows) =>
        new(table.Name, table.Columns.Select(c => new EngineColumn(c.Name, c.Type)).ToList(), rows);

    public static IReadOnlyList<JsonObject> ReadFixture(string table)
    {
        var path = Path.Combine(AppContext.BaseDirectory, "Fixtures", table + ".json");
        return JsonNode.Parse(File.ReadAllText(path))!["value"]!.AsArray().OfType<JsonObject>().ToList();
    }
}
