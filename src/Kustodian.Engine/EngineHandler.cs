using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using Kustodian.Graph.Engine;
using Kustodian.Graph.Query;
using Kusto.Language.Symbols;
using KustoLoco.Core;

namespace Kustodian.Engine;

/// <summary>Runs one <see cref="EngineRequest"/> with KustoLoco over the tables it carries and nothing else. Pure: no I/O,
/// so it is tested in process.</summary>
public static class EngineHandler
{
    public const string UnsupportedPrefix = "Not supported here: ";

    /// <summary>The runtime's message for an <see cref="OutOfMemoryException"/>, which is all KustoLoco passes on.</summary>
    internal const string OutOfMemoryMessage = "Exception of type 'System.OutOfMemoryException' was thrown.";

    public static EngineResponse Handle(EngineRequest request)
    {
        ArgumentNullException.ThrowIfNull(request);
        // Kusto.Language reads real and timespan literals in the current culture (1.5 is 0 where the decimal separator is a
        // comma). The worker process runs invariant; this keeps an in-process call right too.
        var (culture, uiCulture) = (CultureInfo.CurrentCulture, CultureInfo.CurrentUICulture);
        CultureInfo.CurrentCulture = CultureInfo.InvariantCulture;
        CultureInfo.CurrentUICulture = CultureInfo.InvariantCulture;
        try
        {
            return HandleInvariant(request);
        }
        finally
        {
            CultureInfo.CurrentCulture = culture;
            CultureInfo.CurrentUICulture = uiCulture;
        }
    }

    private static EngineResponse HandleInvariant(EngineRequest request)
    {
        // The app's planner refused these before anything was fetched; the worker checks again with the same rule.
        if (GraphQueryPlanner.RefusalOf(request.Kql) is { } refusal)
            return new EngineResponse(null, null, 0, 0, null, refusal);

        string kql;
        try
        {
            kql = QueryClock.Rewrite(request.Kql, request.Now.UtcDateTime);
        }
        catch (FormatException e)
        {
            return new EngineResponse(null, null, 0, 0, e.Message, null);
        }

        var context = NewContext();
        var dropped = 0;
        foreach (var table in request.Tables)
            context.AddTable(TableLoader.Load(table, ref dropped));

        var result = context.RunQueryWithoutDemandBasedTableLoading(kql);
        // KustoLoco reports an exception as its message and nothing else, the GC heap limit's too. That one is the query's
        // memory, not something unsupported: the worker exits on it (Program.cs) and the pool says so. Only the whole
        // message counts, so a query error that merely names OutOfMemoryException (it starts "Query error(s):") doesn't.
        if (string.Equals(result.Error?.Trim(), OutOfMemoryMessage, StringComparison.Ordinal))
            throw new QueryOutOfMemoryException(result.Error!);
        if (!string.IsNullOrEmpty(result.Error))
            return new EngineResponse(null, null, 0, dropped, UnsupportedPrefix + result.Error, null);

        var columns = result.Table.Type.Columns.Select(c => new EngineColumn(c.Name, TypeName(c.Type))).ToList();
        var rows = result.EnumerateRows(Math.Max(0, request.MaxRows))
            .Select(row => row.Select(value => Cut(value, Cell(value))).ToArray())
            .ToList();
        return new EngineResponse(columns, rows, result.RowCount, dropped, null, null);
    }

    /// <summary>A fresh context per request, for only the tables sent. No table loader (the default loads nothing; queries
    /// run without demand loading anyway), and an external data resolver that refuses: KustoLoco's default fetches over
    /// HTTP.</summary>
    internal static KustoQueryContext NewContext() => new KustoQueryContext().SetExternalDataResolver(NoExternalData.Instance);

    private static string TypeName(TypeSymbol type) => type is DynamicSymbol ? "dynamic" : type.Name;

    private static readonly JsonElement Null = JsonSerializer.SerializeToElement<object?>(null);

    /// <summary>The app keeps 1,000 characters of a cell, so no more are sent: the answer stays small.</summary>
    public const int MaxCellLength = 1000;

    /// <summary>A cell cut to <see cref="MaxCellLength"/> characters, ending in "…": a string, or a dynamic value as its JSON
    /// text. A make-series array (numbers, nulls and datetimes only) is kept whole, since the app unrolls it to one row per
    /// point.</summary>
    private static JsonElement Cut(object? value, JsonElement cell)
    {
        if (cell.ValueKind == JsonValueKind.String)
        {
            var text = cell.GetString()!;
            return text.Length > MaxCellLength ? JsonSerializer.SerializeToElement(Shorten(text)) : cell;
        }
        if (cell.ValueKind is not (JsonValueKind.Object or JsonValueKind.Array) || value is JsonArray series && IsSeries(series))
            return cell;
        var json = cell.GetRawText();
        return json.Length > MaxCellLength ? JsonSerializer.SerializeToElement(Shorten(json)) : cell;
    }

    private static string Shorten(string text)
    {
        var keep = MaxCellLength - 1;
        if (char.IsHighSurrogate(text[keep - 1]))
            keep--;   // never half a surrogate pair
        return text[..keep] + "…";
    }

    private static bool IsSeries(JsonArray array) => array.All(e => e switch
    {
        null => true,
        JsonValue v when v.GetValueKind() == JsonValueKind.Number => true,
        JsonValue v when v.TryGetValue<DateTime>(out _) => true,
        JsonValue v when v.TryGetValue<string>(out var s) && s.Length <= 40
            && DateTime.TryParse(s, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out _) => true,
        _ => false,
    });

    /// <summary>A result value as JSON: datetimes ISO 8601 in UTC, timespans <c>d.hh:mm:ss</c>, dynamic values as their
    /// JSON, non-finite reals as text.</summary>
    private static JsonElement Cell(object? value) => value switch
    {
        null => Null,
        DateTime d => JsonSerializer.SerializeToElement(
            (d.Kind == DateTimeKind.Local ? d.ToUniversalTime() : DateTime.SpecifyKind(d, DateTimeKind.Utc))
                .ToString("O", CultureInfo.InvariantCulture)),
        TimeSpan t => JsonSerializer.SerializeToElement(t.ToString("c", CultureInfo.InvariantCulture)),
        Guid g => JsonSerializer.SerializeToElement(g.ToString("D")),
        double r when !double.IsFinite(r) => JsonSerializer.SerializeToElement(r.ToString(CultureInfo.InvariantCulture)),
        JsonNode node => JsonSerializer.SerializeToElement(node),
        string or bool or int or long or double or decimal => JsonSerializer.SerializeToElement(value, value.GetType()),
        _ => JsonSerializer.SerializeToElement(Convert.ToString(value, CultureInfo.InvariantCulture)),
    };
}

/// <summary>The query ran out of memory inside KustoLoco, which reported it as error text.</summary>
public sealed class QueryOutOfMemoryException(string message) : Exception(message);

/// <summary>Refuses <c>externaldata</c>. The planner and <see cref="EngineHandler"/> refuse it before KustoLoco runs; this
/// replaces KustoLoco's default resolver, which fetches over HTTP, so nothing can reach the network if a refusal is ever
/// missed.</summary>
internal sealed class NoExternalData : IExternalDataResolver
{
    public static readonly NoExternalData Instance = new();

    public IReadOnlyList<IReadOnlyList<string>> ResolveRows(string uri, string format) =>
        throw new InvalidOperationException("externaldata isn't available in Graph query.");
}
