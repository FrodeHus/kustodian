using System.Text.Json;
using System.Text.Json.Nodes;
using Kustodian.Snippets;

namespace Kustodian.Messaging.Handlers;

/// <summary><c>snippets.list</c> answers <c>{snippets}</c>, the built-in ones first; <c>snippets.save</c> takes <c>{snippet}</c>
/// and answers the stored snippet; <c>snippets.delete</c> takes <c>{id}</c>. Fields missing from the saved snippet or its
/// parameters take their defaults. A snippet that isn't allowed, and deleting or changing a built-in one, are a
/// <c>bad_request</c> whose message says why.</summary>
public sealed class SnippetHandler(SnippetService snippets)
{
    public void Register(Bridge bridge)
    {
        bridge.Register("snippets.list", async (_, ct) => new ListAnswer(await snippets.ListAsync(ct)));
        bridge.Register("snippets.save", async (p, ct) => await Rejected(() => snippets.SaveAsync(Wanted(p), ct)));
        bridge.Register("snippets.delete", async (p, ct) =>
        {
            await Rejected(async () =>
            {
                await snippets.DeleteAsync(BridgeJson.Params<DeleteParams>(p).Id ?? "", ct);
                return (object?)null;
            });
            return null;
        });
    }

    private static async Task<object?> Rejected<T>(Func<Task<T>> action)
    {
        try
        {
            return await action();
        }
        catch (SnippetRejectedException ex)
        {
            throw new BridgeException(BridgeErrorCodes.BadRequest, ex.Message);
        }
    }

    private static SnippetInput Wanted(JsonElement p)
    {
        if (p.ValueKind != JsonValueKind.Object || !p.TryGetProperty("snippet", out var element) || element.ValueKind != JsonValueKind.Object)
        {
            throw new BridgeException(BridgeErrorCodes.BadRequest, "The request has no snippet.");
        }

        return SnippetService.ReadInput(JsonObject.Create(element), BridgeJson.Options)
            ?? throw new BridgeException(BridgeErrorCodes.BadRequest, "The request's params are not valid.");
    }

    private sealed record DeleteParams(string? Id);

    private sealed record ListAnswer(IReadOnlyList<Snippet> Snippets);
}
