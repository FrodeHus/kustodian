using System.Text.Json;
using Kustodian.Storage;

namespace Kustodian.Messaging.Handlers;

/// <summary>The saved queries and workbooks pinned to the top of the Saved panel, by id, in the order they were pinned.</summary>
public sealed record Pins(IReadOnlyList<string> Queries, IReadOnlyList<string> Workbooks)
{
    public static Pins Empty { get; } = new([], []);
}

/// <summary><c>pins.get</c> answers the <see cref="Pins"/> in <c>pins.json</c> (none when it is missing or corrupt);
/// <c>pins.set</c> takes <c>{pins}</c>, stores it and answers what it stored. Ids are kept apart from the queries and workbooks
/// so pinning doesn't touch their files; an id whose item is gone is ignored by the panel. More than <see cref="MaxPins"/> ids
/// in a list, or an id over <see cref="MaxIdLength"/> characters, is a <c>bad_request</c>.</summary>
public sealed class PinHandler(JsonFileStore store)
{
    public const string FileName = "pins.json";
    public const int MaxPins = 200;
    public const int MaxIdLength = 200;

    public void Register(Bridge bridge)
    {
        bridge.Register("pins.get", async (_, ct) => (await store.ReadAsync(FileName, Pins.Empty, ct)).Value);
        bridge.Register("pins.set", async (p, ct) =>
        {
            var pins = Wanted(p);
            await store.WriteAsync(FileName, pins, ct);
            return pins;
        });
    }

    private static Pins Wanted(JsonElement p)
    {
        if (p.ValueKind != JsonValueKind.Object || !p.TryGetProperty("pins", out var element) || element.ValueKind != JsonValueKind.Object)
        {
            throw new BridgeException(BridgeErrorCodes.BadRequest, "The request has no pins.");
        }

        return new Pins(Ids(element, "queries"), Ids(element, "workbooks"));
    }

    private static string[] Ids(JsonElement pins, string name)
    {
        if (!pins.TryGetProperty(name, out var list))
        {
            return [];
        }

        if (list.ValueKind != JsonValueKind.Array || list.EnumerateArray().Any(i => i.ValueKind != JsonValueKind.String))
        {
            throw new BridgeException(BridgeErrorCodes.BadRequest, $"The pinned {name} must be a list of ids.");
        }

        var ids = list.EnumerateArray().Select(i => i.GetString()!).Where(i => i.Length > 0).Distinct().ToArray();
        if (ids.Length > MaxPins || ids.Any(i => i.Length > MaxIdLength))
        {
            throw new BridgeException(BridgeErrorCodes.BadRequest, $"At most {MaxPins} {name} can be pinned.");
        }

        return ids;
    }
}
