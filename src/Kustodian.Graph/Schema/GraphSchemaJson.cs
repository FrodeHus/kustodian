using System.Text.Encodings.Web;
using System.Text.Json;

namespace Kustodian.Graph.Schema;

/// <summary>The committed file format (spec §4.3). Written by hand with a fixed property order so a regeneration without
/// upstream changes produces no diff: tables sorted by name, columns and fields in CSDL order, <c>\n</c> line ends,
/// 2-space indent, a table's <c>directoryObject</c> omitted when false, <c>permissions</c> and a column's <c>knownPermission</c> omitted when empty, <c>filter</c> omitted when empty, a column's
/// <c>listable</c> omitted when true, <c>collection</c> omitted when false and <c>complexType</c> omitted when null.</summary>
public static class GraphSchemaJson
{
    public static string Write(GraphSchema schema)
    {
        using var stream = new MemoryStream();
        var options = new JsonWriterOptions
        {
            Indented = true,
            IndentSize = 2,
            NewLine = "\n",
            Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        };
        using (var w = new Utf8JsonWriter(stream, options))
        {
            w.WriteStartObject();
            w.WriteString("source", schema.Source);
            w.WriteString("generatedAt", schema.GeneratedAt);

            w.WriteStartArray("tables");
            foreach (var table in schema.Tables.OrderBy(t => t.Name, StringComparer.Ordinal))
            {
                w.WriteStartObject();
                w.WriteString("name", table.Name);
                w.WriteString("path", table.Path);
                w.WriteString("entityType", table.EntityType);
                w.WriteString("description", table.Description);
                w.WriteString("docsUrl", table.DocsUrl);
                if (table.DirectoryObject)
                    w.WriteBoolean("directoryObject", true);
                if (table.Permissions.Count > 0)
                {
                    w.WriteStartArray("permissions");
                    foreach (var permission in table.Permissions)
                        w.WriteStringValue(permission);
                    w.WriteEndArray();
                }

                w.WriteStartArray("columns");
                foreach (var column in table.Columns)
                    WriteColumn(w, column);
                w.WriteEndArray();
                w.WriteEndObject();
            }

            w.WriteEndArray();

            w.WriteStartObject("complexTypes");
            foreach (var (name, fields) in schema.ComplexTypes.OrderBy(p => p.Key, StringComparer.Ordinal))
            {
                w.WriteStartArray(name);
                foreach (var field in fields)
                    WriteField(w, field);
                w.WriteEndArray();
            }

            w.WriteEndObject();
            w.WriteEndObject();
        }

        return System.Text.Encoding.UTF8.GetString(stream.ToArray()) + "\n";
    }

    /// <summary>Whether two schemas write the same file once Source and GeneratedAt are neutralised, so every persisted
    /// field counts.</summary>
    public static bool SameContent(GraphSchema a, GraphSchema b) => Neutral(a) == Neutral(b);

    private static string Neutral(GraphSchema s) => Write(s with { Source = "", GeneratedAt = DateTimeOffset.UnixEpoch });

    private static void WriteColumn(Utf8JsonWriter w, GraphColumn column)
    {
        w.WriteStartObject();
        w.WriteString("name", column.Name);
        w.WriteString("type", column.Type);
        w.WriteString("description", column.Description);
        if (column.Filter.Count > 0)
        {
            w.WriteStartArray("filter");
            foreach (var op in column.Filter)
                w.WriteStringValue(op);
            w.WriteEndArray();
        }

        w.WriteBoolean("selectOnly", column.SelectOnly);
        if (!column.Listable)
            w.WriteBoolean("listable", false);
        if (column.Collection)
            w.WriteBoolean("collection", true);
        if (column.ComplexType is not null)
            w.WriteString("complexType", column.ComplexType);
        if (column.KnownPermission is not null)
            w.WriteString("knownPermission", column.KnownPermission);
        w.WriteEndObject();
    }

    private static void WriteField(Utf8JsonWriter w, GraphField field)
    {
        w.WriteStartObject();
        w.WriteString("name", field.Name);
        w.WriteString("type", field.Type);
        w.WriteBoolean("collection", field.Collection);
        if (field.ComplexType is not null)
            w.WriteString("complexType", field.ComplexType);
        w.WriteString("description", field.Description);
        w.WriteEndObject();
    }

    public static GraphSchema Read(Stream stream)
    {
        using var doc = JsonDocument.Parse(stream);
        var root = doc.RootElement;

        var tables = root.GetProperty("tables").EnumerateArray().Select(ReadTable).ToList();
        var complexTypes = new Dictionary<string, IReadOnlyList<GraphField>>(StringComparer.Ordinal);
        foreach (var property in root.GetProperty("complexTypes").EnumerateObject())
            complexTypes[property.Name] = property.Value.EnumerateArray().Select(ReadField).ToList();

        return new GraphSchema(
            root.GetProperty("source").GetString()!,
            root.GetProperty("generatedAt").GetDateTimeOffset(),
            tables,
            complexTypes);
    }

    private static GraphTable ReadTable(JsonElement e) => new(
        e.GetProperty("name").GetString()!,
        e.GetProperty("path").GetString()!,
        e.GetProperty("entityType").GetString()!,
        e.GetProperty("description").GetString()!,
        e.GetProperty("docsUrl").GetString()!,
        e.GetProperty("columns").EnumerateArray().Select(ReadColumn).ToList(),
        e.TryGetProperty("directoryObject", out var directoryObject) && directoryObject.GetBoolean())
    {
        Permissions = e.TryGetProperty("permissions", out var permissions)
            ? permissions.EnumerateArray().Select(x => x.GetString()!).ToList()
            : [],
    };

    private static GraphColumn ReadColumn(JsonElement e) => new(
        e.GetProperty("name").GetString()!,
        e.GetProperty("type").GetString()!,
        e.GetProperty("description").GetString()!,
        e.TryGetProperty("filter", out var filter) ? filter.EnumerateArray().Select(x => x.GetString()!).ToList() : [],
        e.GetProperty("selectOnly").GetBoolean(),
        e.TryGetProperty("complexType", out var complex) ? complex.GetString() : null,
        e.TryGetProperty("collection", out var collection) && collection.GetBoolean(),
        !e.TryGetProperty("listable", out var listable) || listable.GetBoolean())
    {
        KnownPermission = e.TryGetProperty("knownPermission", out var known) ? known.GetString() : null,
    };

    private static GraphField ReadField(JsonElement e) => new(
        e.GetProperty("name").GetString()!,
        e.GetProperty("type").GetString()!,
        e.GetProperty("collection").GetBoolean(),
        e.TryGetProperty("complexType", out var complex) ? complex.GetString() : null,
        e.GetProperty("description").GetString()!);
}
