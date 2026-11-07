using System.Text.Json;
using Kustodian.Solutions;

namespace Kustodian.Messaging.Handlers;

/// <summary><c>solution.list</c>, <c>solution.get</c>, <c>solution.install</c> and <c>solution.uninstall</c> for the Community
/// Solutions catalog. A refusal from the service, or an id that isn't a solution id, is a <c>bad_request</c> whose message says why.</summary>
public sealed class SolutionHandler(SolutionService solutions)
{
    public void Register(Bridge bridge)
    {
        bridge.Register("solution.list", async (p, ct) =>
            await Rejected(() => solutions.ListAsync(
                p.ValueKind == JsonValueKind.Object && BridgeJson.Params<ListParams>(p).Refresh == true, ct)));
        bridge.Register("solution.get", async (p, ct) =>
            await Rejected(async () =>
            {
                var id = Id(p);
                var (manifest, readme) = await solutions.GetAsync(id, ct);
                var installed = await solutions.InstalledAsync(id, ct);
                var modified = installed is null
                    ? []
                    : (await solutions.ModifiedAsync(id, ct)).Select(i => i.LibraryId).ToList();
                return new DetailsAnswer(manifest, readme, installed, modified);
            }));
        bridge.Register("solution.install", async (p, ct) =>
            await Rejected(() => solutions.InstallAsync(Id(p), new HashSet<string>(BridgeJson.Params<InstallParams>(p).Skip ?? []), ct)));
        bridge.Register("solution.uninstall", async (p, ct) =>
        {
            await Rejected(async () =>
            {
                await solutions.UninstallAsync(Id(p), new HashSet<string>(BridgeJson.Params<UninstallParams>(p).Keep ?? []), ct);
                return (object?)null;
            });
            return BridgeNull.Value;
        });
    }

    private static async Task<object?> Rejected<T>(Func<Task<T>> action)
    {
        try
        {
            return await action();
        }
        catch (SolutionRejectedException ex)
        {
            throw new BridgeException(BridgeErrorCodes.BadRequest, ex.Message);
        }
    }

    private static string Id(JsonElement p) =>
        BridgeJson.Params<IdParams>(p).Id is { } id && SolutionRules.IsId(id)
            ? id
            : throw new BridgeException(BridgeErrorCodes.BadRequest, "That isn't a solution id.");

    private sealed record IdParams(string? Id);

    private sealed record ListParams(bool? Refresh);

    private sealed record InstallParams(string[]? Skip);

    private sealed record UninstallParams(string[]? Keep);

    private sealed record DetailsAnswer(SolutionManifest Manifest, string Readme, InstalledSolution? Installed,
        IReadOnlyList<string> Modified);
}
