using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;
using Kustodian.History;

namespace Kustodian.Messaging.Handlers;

/// <summary><c>history.record</c>, <c>history.values</c>, <c>history.changes</c>, <c>history.series</c> and <c>history.clear</c>:
/// the bridge to <see cref="HistoryStore"/>. Requests are checked here; a refusal never echoes a row, because history is never
/// logged or reported.</summary>
public sealed partial class HistoryHandler(HistoryStore history)
{
    private static readonly string[] Sources = ["graph", "hunting", "arg", "logs"];
    private static readonly int[] Retentions = [30, 90, 365];

    public void Register(Bridge bridge)
    {
        bridge.Register("history.record", async (p, ct) =>
        {
            var r = BridgeJson.Params<RecordParams>(p);
            var (workbook, widget, query, setting) = Check(r.WorkbookId, r.WidgetId, r.Query, r.Setting);
            var columns = r.Columns ?? throw Bad("The request has no columns.");
            var names = columns.Select(c => c.Name).ToList();
            if (setting.Mode == HistoryMode.Rows)
            {
                if (setting.Keys.Count == 0 || !setting.Keys.SequenceEqual(names.Take(setting.Keys.Count)))
                {
                    throw Bad("Row tracking needs key columns, and they must be the first columns of the result.");
                }
            }
            else if (setting.Keys.Any(k => !names.Contains(k)))
            {
                throw Bad("A key column isn't a column of the result.");
            }

            var rows = r.Rows ?? throw Bad("The request has no rows.");
            if (rows.Any(row => row.Length != columns.Count))
            {
                throw Bad("A row doesn't match the columns.");
            }

            return await history.RecordAsync(new RecordRequest(workbook, widget, query, setting, r.Label ?? "", columns, rows), ct);
        });
        bridge.Register("history.values", async (p, ct) =>
        {
            var r = BridgeJson.Params<QueryParams>(p);
            var (workbook, widget, query, setting) = Check(r.WorkbookId, r.WidgetId, r.Query, r.Setting);
            return await history.ValuesAsync(workbook, widget, query, setting, ct);
        });
        bridge.Register("history.changes", async (p, ct) =>
        {
            var r = BridgeJson.Params<ChangesParams>(p);
            var (workbook, widget, query, setting) = Check(r.WorkbookId, r.WidgetId, r.Query, r.Setting);
            if (r.Since != "previous" && !(r.Since is { } s && Instant().IsMatch(s) && DateTimeOffset.TryParse(s, CultureInfo.InvariantCulture, out _)))
            {
                throw Bad("since must be \"previous\" or a date and time with an offset.");
            }

            return await history.ChangesAsync(workbook, widget, query, setting, r.Since, ct);
        });
        bridge.Register("history.series", async (p, ct) =>
        {
            var r = BridgeJson.Params<IdsParams>(p);
            var (workbook, widget) = Ids(r.WorkbookId, r.WidgetId);
            return await history.SeriesAsync(workbook, widget, ct);
        });
        bridge.Register("history.clear", async (p, ct) =>
        {
            var r = BridgeJson.Params<IdsParams>(p);
            var (workbook, widget) = Ids(r.WorkbookId, r.WidgetId);
            await history.ClearAsync(workbook, widget, ct);
            return BridgeNull.Value;
        });
    }

    private static BridgeException Bad(string message) => new(BridgeErrorCodes.BadRequest, message);

    /// <summary>The workbook id as WorkbookService files it (lowercase GUID), and a widget id of 1 to 64 of <c>A-Za-z0-9_-</c>.</summary>
    private static (string Workbook, string Widget) Ids(string? workbookId, string? widgetId)
    {
        if (!Guid.TryParseExact(workbookId, "D", out var guid))
        {
            throw Bad("The workbook id isn't valid.");
        }

        return widgetId is { } w && WidgetId().IsMatch(w) ? (guid.ToString("D"), w) : throw Bad("The widget id isn't valid.");
    }

    private static (string Workbook, string Widget, HistoryQuery Query, HistorySetting Setting) Check(string? workbookId,
        string? widgetId, HistoryQuery? query, HistorySetting? setting)
    {
        var (workbook, widget) = Ids(workbookId, widgetId);
        if (query is null || !Sources.Contains(query.Source) || query.Text is null || query.Parameters is null)
        {
            throw Bad("The query isn't valid.");
        }

        if (setting is null || !Enum.IsDefined(setting.Mode) || !Enum.IsDefined(setting.Interval) || setting.Keys is null
            || !Retentions.Contains(setting.RetentionDays))
        {
            throw Bad("The history setting isn't valid.");
        }

        return (workbook, widget, query, setting);
    }

    [GeneratedRegex("^[A-Za-z0-9_-]{1,64}$")]
    private static partial Regex WidgetId();

    [GeneratedRegex(@"(Z|[+-]\d\d:\d\d)$", RegexOptions.IgnoreCase)]
    private static partial Regex Instant();

    private sealed record RecordParams(string? WorkbookId, string? WidgetId, HistoryQuery? Query, HistorySetting? Setting, string? Label,
        List<HistoryColumn>? Columns, List<JsonElement[]>? Rows);

    private sealed record QueryParams(string? WorkbookId, string? WidgetId, HistoryQuery? Query, HistorySetting? Setting);

    private sealed record ChangesParams(string? WorkbookId, string? WidgetId, HistoryQuery? Query, HistorySetting? Setting, string? Since);

    private sealed record IdsParams(string? WorkbookId, string? WidgetId);
}
