using Kustodian.App;

namespace Kustodian.Messaging.Handlers;

/// <summary><c>schema.graphStatus</c>: the Graph schema in use and any newer one waiting for a restart
/// (<see cref="GraphSchemaStatus"/>). <c>schema.checkGraph {force?}</c>: asks the repository for a newer schema and downloads it
/// (<see cref="GraphSchemaUpdates.CheckAsync"/>), answering the status after; <c>failed</c> with the reason when it couldn't.</summary>
public sealed class GraphSchemaUpdateHandler(GraphSchemaUpdates updates)
{
    public void Register(Bridge bridge)
    {
        bridge.Register("schema.graphStatus", (_, _) => Task.FromResult<object?>(updates.Status()));
        bridge.Register("schema.checkGraph", async (p, ct) =>
        {
            try
            {
                return await updates.CheckAsync(BridgeJson.Params<CheckParams>(p).Force, ct);
            }
            catch (GraphSchemaUpdateException e)
            {
                throw new BridgeException(BridgeErrorCodes.Failed, e.Message);
            }
        });
    }

    private sealed record CheckParams(bool Force);
}
