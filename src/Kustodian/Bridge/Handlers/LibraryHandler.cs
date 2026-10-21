using System.Text.Json;
using System.Text.Json.Nodes;
using Kustodian.Library;

namespace Kustodian.Messaging.Handlers;

/// <summary><c>library.list</c>, <c>library.save</c> and <c>library.delete</c> for the saved queries, and <c>recent.list</c> and
/// <c>recent.clear</c> for the recent runs. <c>library.save</c> fills fields missing from (or null in) its <c>query</c> with
/// their defaults, as a file read does; a query that isn't allowed (name, folder, text, id) is a <c>bad_request</c> whose
/// message says why.</summary>
public sealed class LibraryHandler(LibraryService library, RecentService recent)
{
    public void Register(Bridge bridge)
    {
        bridge.Register("library.list", async (_, ct) => await library.ListAsync(ct));
        bridge.Register("library.save", async (p, ct) => await Rejected(() => library.SaveAsync(Wanted(p), ct)));
        bridge.Register("library.delete", async (p, ct) =>
        {
            await Rejected(async () =>
            {
                await library.DeleteAsync(BridgeJson.Params<DeleteParams>(p).Id ?? "", ct);
                return (object?)null;
            });
            return null;
        });
        bridge.Register("recent.list", async (_, ct) => new RecentAnswer(await recent.ListAsync(ct)));
        bridge.Register("recent.clear", async (_, ct) =>
        {
            await recent.ClearAsync(ct);
            return null;
        });
    }

    private static async Task<object?> Rejected<T>(Func<Task<T>> action)
    {
        try
        {
            return await action();
        }
        catch (LibraryRejectedException ex)
        {
            throw new BridgeException(BridgeErrorCodes.BadRequest, ex.Message);
        }
    }

    /// <summary>The <c>query</c> of a <c>library.save</c>, with missing fields taken from the defaults.</summary>
    private static SavedQueryInput Wanted(JsonElement p)
    {
        if (p.ValueKind != JsonValueKind.Object || !p.TryGetProperty("query", out var element) || element.ValueKind != JsonValueKind.Object)
        {
            throw new BridgeException(BridgeErrorCodes.BadRequest, "The request has no query.");
        }

        return LibraryService.ReadInput(JsonObject.Create(element), BridgeJson.Options)
            ?? throw new BridgeException(BridgeErrorCodes.BadRequest, "The request's params are not valid.");
    }

    private sealed record DeleteParams(string? Id);

    private sealed record RecentAnswer(IReadOnlyList<RecentRun> Runs);
}
