using System.Text.Json;
using System.Text.Json.Nodes;
using Kustodian.Workbooks;

namespace Kustodian.Messaging.Handlers;

/// <summary><c>workbook.list</c>, <c>workbook.get</c>, <c>workbook.save</c>, <c>workbook.check</c> (is an imported workbook allowed, nothing
/// written), <c>workbook.delete</c>, and <c>workbook.values.get</c> / <c>workbook.values.save</c> for the values last used in a workbook. A workbook is an opaque
/// object to the host; one that isn't allowed (or an id that isn't valid) is a <c>bad_request</c> whose message says why.</summary>
public sealed class WorkbookHandler(WorkbookService workbooks)
{
    public void Register(Bridge bridge)
    {
        bridge.Register("workbook.list", async (_, ct) => await workbooks.ListAsync(ct));
        bridge.Register("workbook.get", async (p, ct) =>
            await Rejected(async () => new WorkbookAnswer(await workbooks.GetAsync(Id(p), ct))));
        bridge.Register("workbook.save", async (p, ct) =>
            await Rejected(async () => new WorkbookAnswer(await workbooks.SaveAsync(Wanted(p), ct))));
        bridge.Register("workbook.check", (p, _) =>
        {
            var problem = WorkbookService.Check(Wanted(p));
            return problem is null ? Task.FromResult<object?>(BridgeNull.Value) : throw new BridgeException(BridgeErrorCodes.BadRequest, problem);
        });
        bridge.Register("workbook.delete", async (p, ct) =>
        {
            await Rejected(async () =>
            {
                await workbooks.DeleteAsync(Id(p), ct);
                return (object?)null;
            });
            return null;
        });
        bridge.Register("workbook.values.get", async (p, ct) =>
            await Rejected(async () => new ValuesAnswer(await workbooks.GetValuesAsync(Id(p), ct))));
        bridge.Register("workbook.values.save", async (p, ct) =>
        {
            await Rejected(async () =>
            {
                var values = BridgeJson.Params<ValuesParams>(p).Values
                    ?? throw new BridgeException(BridgeErrorCodes.BadRequest, "The request has no values.");
                await workbooks.SaveValuesAsync(Id(p), values, ct);
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
        catch (WorkbookRejectedException ex)
        {
            throw new BridgeException(BridgeErrorCodes.BadRequest, ex.Message);
        }
    }

    private static string Id(JsonElement p) => BridgeJson.Params<IdParams>(p).Id ?? "";

    private static JsonObject Wanted(JsonElement p)
    {
        if (p.ValueKind != JsonValueKind.Object || !p.TryGetProperty("workbook", out var element) || element.ValueKind != JsonValueKind.Object)
        {
            throw new BridgeException(BridgeErrorCodes.BadRequest, "The request has no workbook.");
        }

        return JsonObject.Create(element)!;
    }

    private sealed record IdParams(string? Id);

    private sealed record ValuesParams(JsonObject? Values);

    private sealed record WorkbookAnswer(JsonObject? Workbook);

    private sealed record ValuesAnswer(JsonObject Values);
}
