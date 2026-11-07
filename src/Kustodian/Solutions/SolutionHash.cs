using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Kustodian.Library;
using Kustodian.Storage;

namespace Kustodian.Solutions;

/// <summary>SHA-256 hashes of canonical JSON, so an item's content is compared without its identity or timestamps.</summary>
public static class SolutionHash
{
    private static readonly string[] WorkbookIgnored = ["id", "name", "folder", "modifiedAt", "createdAt", "origin"];
    private static readonly string[] LinkedCopyFields = ["text", "source", "parameters", "options"];

    /// <summary>Lowercase hex SHA-256.</summary>
    public static string Sha256(ReadOnlySpan<byte> data) => Convert.ToHexStringLower(SHA256.HashData(data));

    /// <summary>Compact JSON with object keys sorted at every depth.</summary>
    public static string Canonical(JsonNode? node)
    {
        var sb = new StringBuilder();
        Write(sb, node);
        return sb.ToString();
    }

    private static void Write(StringBuilder sb, JsonNode? node)
    {
        switch (node)
        {
            case JsonObject o:
                sb.Append('{');
                var first = true;
                foreach (var (key, value) in o.OrderBy(p => p.Key, StringComparer.Ordinal))
                {
                    sb.Append(first ? "" : ",").Append(JsonSerializer.Serialize(key)).Append(':');
                    Write(sb, value);
                    first = false;
                }

                sb.Append('}');
                break;
            case JsonArray a:
                sb.Append('[');
                for (var i = 0; i < a.Count; i++)
                {
                    sb.Append(i == 0 ? "" : ",");
                    Write(sb, a[i]);
                }

                sb.Append(']');
                break;
            default:
                sb.Append(node is null ? "null" : node.ToJsonString());
                break;
        }
    }

    private static string OfCanonical(JsonNode? node) => Sha256(Encoding.UTF8.GetBytes(Canonical(node)));

    /// <summary>Hash of a query's content fields: source, text, parameters and options.</summary>
    public static string Query(SavedQueryInput q)
    {
        var json = JsonSerializer.SerializeToNode(q, JsonFileStore.Options)!.AsObject();
        return OfCanonical(new JsonObject
        {
            ["source"] = json["source"]?.DeepClone(),
            ["text"] = json["text"]?.DeepClone(),
            ["parameters"] = json["parameters"]?.DeepClone(),
            ["options"] = json["options"]?.DeepClone(),
        });
    }

    /// <summary>Hash of a workbook without its identity, timestamps, origin, and the copies and names of the queries it links.</summary>
    public static string Workbook(JsonObject wb)
    {
        var copy = (JsonObject)wb.DeepClone();
        foreach (var key in WorkbookIgnored)
        {
            copy.Remove(key);
        }

        if (copy["widgets"] is JsonArray widgets)
        {
            foreach (var query in widgets.OfType<JsonObject>().Select(w => w["query"]).OfType<JsonObject>()
                         .Where(q => q["saved"] is not null))
            {
                foreach (var key in LinkedCopyFields)
                {
                    query.Remove(key);
                }

                // Renaming the linked query doesn't change the workbook.
                (query["saved"] as JsonObject)?.Remove("name");
            }
        }

        return OfCanonical(copy);
    }
}
