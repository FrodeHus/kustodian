using System.Buffers.Binary;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Kustodian.Graph.Engine;

/// <summary>A column by name and Kusto type name (<c>string</c>, <c>long</c>, <c>datetime</c>, <c>dynamic</c>, …).</summary>
public sealed record EngineColumn(string Name, string Type);

/// <summary>A fetched collection as the engine loads it: every column of the schema's table, and the objects as Graph
/// returned them.</summary>
public sealed record EngineTable(string Name, IReadOnlyList<EngineColumn> Columns, IReadOnlyList<JsonObject> Rows);

/// <summary>One query for the engine worker: the KQL unchanged, the run's <c>now()</c> (the instant the planner pushed
/// filters with), the tables it may read and nothing else, and the most rows to send back.</summary>
public sealed record EngineRequest(string Kql, DateTimeOffset Now, IReadOnlyList<EngineTable> Tables, int MaxRows);

/// <summary>The engine's answer: the result's columns and rows (cut to <c>MaxRows</c>; <paramref name="Total"/> counts them
/// all), the number of fetched values that didn't convert to their column's type, or an error, or a refusal (the query
/// reaches outside the tables it was sent).</summary>
public sealed record EngineResponse(
    IReadOnlyList<EngineColumn>? Columns,
    IReadOnlyList<JsonElement[]>? Rows,
    int Total,
    int DroppedValues,
    string? Error,
    string? Refusal);

/// <summary>A frame longer than the reader's limit: well formed, just too large (unlike a malformed frame's
/// <see cref="InvalidDataException"/>).</summary>
public sealed class EngineFrameTooLargeException(string message) : IOException(message);

/// <summary>How the worker says why it exited.</summary>
public static class EngineExitCodes
{
    /// <summary>The query ran its GC heap past <c>DOTNET_GCHeapHardLimit</c>: the query's doing, not a crash.</summary>
    public const int OutOfMemory = 3;
}

/// <summary>The worker's wire format: each message is a 4-byte big-endian length, then that many bytes of UTF-8 JSON
/// (<see cref="JsonSerializerDefaults.Web"/>).</summary>
public static class EngineFrames
{
    private static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web);

    public static async Task WriteAsync<T>(Stream stream, T message, CancellationToken ct)
    {
        var body = JsonSerializer.SerializeToUtf8Bytes(message, Options);
        var header = new byte[4];
        BinaryPrimitives.WriteInt32BigEndian(header, body.Length);
        await stream.WriteAsync(header, ct);
        await stream.WriteAsync(body, ct);
        await stream.FlushAsync(ct);
    }

    /// <summary>The next message, or null at the end of the stream (before a frame starts). A frame longer than
    /// <paramref name="maxBytes"/> throws <see cref="EngineFrameTooLargeException"/>; one cut short, not JSON, or JSON
    /// <c>null</c> throws <see cref="InvalidDataException"/>.</summary>
    public static async Task<T?> ReadAsync<T>(Stream stream, int maxBytes, CancellationToken ct)
    {
        var header = new byte[4];
        var read = await ReadFullyAsync(stream, header, ct);
        if (read == 0)
            return default;
        if (read < header.Length)
            throw new InvalidDataException("The frame header was cut short.");

        var length = BinaryPrimitives.ReadInt32BigEndian(header);
        if (length < 0)
            throw new InvalidDataException($"The frame length {length} is negative.");
        if (length > maxBytes)
            throw new EngineFrameTooLargeException($"The frame is {length} bytes, over the limit of {maxBytes}.");

        var body = new byte[length];
        if (await ReadFullyAsync(stream, body, ct) < length)
            throw new InvalidDataException("The frame was cut short.");
        T? message;
        try
        {
            message = JsonSerializer.Deserialize<T>(body, Options);
        }
        catch (JsonException e)
        {
            throw new InvalidDataException($"The frame isn't valid JSON: {e.Message}", e);
        }
        // Null means the end of the stream to the caller; a frame holding JSON null is not that.
        return message ?? throw new InvalidDataException("The frame holds JSON null, not a message.");
    }

    private static async Task<int> ReadFullyAsync(Stream stream, byte[] buffer, CancellationToken ct)
    {
        var total = 0;
        while (total < buffer.Length)
        {
            var read = await stream.ReadAsync(buffer.AsMemory(total), ct);
            if (read == 0)
                break;
            total += read;
        }
        return total;
    }
}
