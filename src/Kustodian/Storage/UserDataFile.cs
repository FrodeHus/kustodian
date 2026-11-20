using System.Text.Json;
using System.Text.Json.Nodes;

namespace Kustodian.Storage;

/// <summary>
/// One user data file under the store's root, owned by one service: reads and writes go through one gate, so they never
/// overlap. A missing file reads as <paramref name="defaults"/>. Fields missing from the file (or null in it) load with their
/// defaults, at every level (<see cref="JsonDefaults.Fill"/>), before <paramref name="isValid"/> sees the value. Content that
/// doesn't parse, isn't an object, has a value of the wrong type, or that <paramref name="isValid"/> refuses, is moved aside
/// and read as the defaults too, marked corrupt. Arrays of objects are kept whole by <see cref="JsonDefaults.Fill"/>;
/// <paramref name="fillElements"/>, when given, fills their elements from per-element defaults (<see cref="JsonDefaults.FillElements"/>)
/// on the filled object, before it is deserialized. Writes are atomic
/// (<see cref="JsonFileStore.WriteAsync{T}"/>).
/// </summary>
public sealed class UserDataFile<T>(JsonFileStore store, string relativePath, Func<T> defaults, Func<T, bool> isValid,
    Func<JsonObject, JsonObject>? fillElements = null)
    where T : class
{
    private readonly SemaphoreSlim _gate = new(1, 1);
    private JsonNode? _fallback;

    public async Task<StoreRead<T>> ReadAsync(CancellationToken ct = default)
    {
        await _gate.WaitAsync(ct);
        try
        {
            var read = await store.ReadAsync<JsonNode?>(relativePath, null, ct);
            if (read.Corrupt)
            {
                return new StoreRead<T>(defaults(), true);
            }

            if (read.Value is null)
            {
                return new StoreRead<T>(defaults(), false);
            }

            if (Complete(read.Value) is not { } value || !isValid(value))
            {
                store.MoveAside(relativePath);
                return new StoreRead<T>(defaults(), true);
            }

            return new StoreRead<T>(value, false);
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>The file's object with the defaults filled in, as <typeparamref name="T"/>; null when it isn't an object or a
    /// value has the wrong type.</summary>
    private T? Complete(JsonNode node)
    {
        if (node is not JsonObject value)
        {
            return null;
        }

        try
        {
            // Read under the gate, and read-only: JsonDefaults.Fill clones what it takes from it.
            _fallback ??= JsonSerializer.SerializeToNode(defaults(), JsonFileStore.Options);
            var filled = _fallback is JsonObject fallback
                ? JsonDefaults.Fill(value, fallback)
                : value;
            return (fillElements is null ? filled : fillElements(filled)).Deserialize<T>(JsonFileStore.Options);
        }
        catch (JsonException)
        {
            return null;
        }
    }

    public async Task WriteAsync(T value, CancellationToken ct = default)
    {
        await _gate.WaitAsync(ct);
        try
        {
            await store.WriteAsync(relativePath, value, ct);
        }
        finally
        {
            _gate.Release();
        }
    }
}
