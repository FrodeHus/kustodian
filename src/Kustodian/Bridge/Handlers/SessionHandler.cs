using System.Text.Json;
using System.Text.Json.Nodes;
using Kustodian.Sessions;

namespace Kustodian.Messaging.Handlers;

/// <summary><c>session.get</c> answers <c>{session, corrupt}</c> (<c>corrupt</c>: the file was moved aside and the session is
/// empty); <c>session.save</c> takes <c>{session}</c> and answers <c>{dropped}</c>, how many tabs went over a cap and were left
/// out. Fields missing from the saved session, its tabs or their parameters take their defaults, as a file read does.</summary>
public sealed class SessionHandler(SessionService sessions)
{
    public void Register(Bridge bridge)
    {
        bridge.Register("session.get", async (_, ct) =>
        {
            var read = await sessions.GetAsync(ct);
            return new GetAnswer(read.Value, read.Corrupt);
        });
        bridge.Register("session.save", async (p, ct) => new SaveAnswer(await sessions.SaveAsync(Wanted(p), ct)));
    }

    private static Session Wanted(JsonElement p)
    {
        if (p.ValueKind != JsonValueKind.Object || !p.TryGetProperty("session", out var element) || element.ValueKind != JsonValueKind.Object)
        {
            throw new BridgeException(BridgeErrorCodes.BadRequest, "The request has no session.");
        }

        return SessionService.ReadInput(JsonObject.Create(element), BridgeJson.Options)
            ?? throw new BridgeException(BridgeErrorCodes.BadRequest, "The request's params are not valid.");
    }

    private sealed record GetAnswer(Session Session, bool Corrupt);

    private sealed record SaveAnswer(int Dropped);
}
