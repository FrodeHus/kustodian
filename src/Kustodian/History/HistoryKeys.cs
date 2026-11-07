using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Kustodian.History;

public sealed record HistoryParameter(string Name, string Value);

/// <summary>What a run asked: the source, the resolved query text, the source options and the parameter values.</summary>
public sealed record HistoryQuery(string Source, string Text, JsonElement? Options, IReadOnlyList<HistoryParameter> Parameters);

public enum HistoryMode { Values, Rows }

public enum HistoryInterval { Run, Day, Week }

public sealed record HistorySetting(HistoryMode Mode, HistoryInterval Interval, int RetentionDays, IReadOnlyList<string> Keys);

/// <summary>The hashes history is filed under: lowercase hex SHA-256 of canonical JSON, never the query itself.</summary>
public static class HistoryKeys
{
    private sealed record QueryPayload(string Source, string Text, string? Options, string Mode, IReadOnlyList<string> Keys);

    private sealed record SeriesPayload(QueryPayload Query, IReadOnlyList<HistoryParameter> Parameters);

    /// <summary>Source, text, options, mode and keys: what makes two series comparable at all.</summary>
    public static string QueryKey(HistoryQuery q, HistorySetting s) => Hash(Payload(q, s));

    /// <summary>The query key plus the parameters sorted by name: each parameter combination has its own series.</summary>
    public static string SeriesKey(HistoryQuery q, HistorySetting s) =>
        Hash(new SeriesPayload(Payload(q, s), [.. q.Parameters.OrderBy(p => p.Name, StringComparer.Ordinal)]));

    private static QueryPayload Payload(HistoryQuery q, HistorySetting s) =>
        new(q.Source, q.Text, Canonical(q.Options), s.Mode.ToString(), s.Keys);

    private static string Hash<T>(T payload) =>
        Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(payload))));

    private static string? Canonical(JsonElement? options)
    {
        if (options is not { ValueKind: not (JsonValueKind.Null or JsonValueKind.Undefined) } element)
        {
            return null;
        }

        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream))
        {
            Write(writer, element);
        }

        return Encoding.UTF8.GetString(stream.ToArray());
    }

    private static void Write(Utf8JsonWriter writer, JsonElement element)
    {
        switch (element.ValueKind)
        {
            case JsonValueKind.Object:
                writer.WriteStartObject();
                foreach (var p in element.EnumerateObject().OrderBy(p => p.Name, StringComparer.Ordinal))
                {
                    writer.WritePropertyName(p.Name);
                    Write(writer, p.Value);
                }

                writer.WriteEndObject();
                break;
            case JsonValueKind.Array:
                writer.WriteStartArray();
                foreach (var item in element.EnumerateArray())
                {
                    Write(writer, item);
                }

                writer.WriteEndArray();
                break;
            default:
                element.WriteTo(writer);
                break;
        }
    }
}
