using System.Text.Json;
using Kustodian.History;

namespace Kustodian.Tests.History;

public sealed class HistoryKeysTests
{
    private static readonly HistorySetting Setting = new(HistoryMode.Rows, HistoryInterval.Day, 30, ["id"]);

    private static HistoryQuery Query(string options = "{\"a\":1,\"b\":2}", params HistoryParameter[] parameters) =>
        new("graph", "Resources | take 5", JsonDocument.Parse(options).RootElement, parameters);

    [Fact]
    public void Parameter_order_does_not_change_the_series_key_but_a_value_does()
    {
        var a = new HistoryParameter("Severity", "High");
        var b = new HistoryParameter("Env", "Prod");

        Assert.Equal(
            HistoryKeys.SeriesKey(Query(parameters: [a, b]), Setting),
            HistoryKeys.SeriesKey(Query(parameters: [b, a]), Setting));
        Assert.NotEqual(
            HistoryKeys.SeriesKey(Query(parameters: [a, b]), Setting),
            HistoryKeys.SeriesKey(Query(parameters: [a with { Value = "Low" }, b]), Setting));
    }

    [Fact]
    public void A_parameter_type_changes_the_series_key_only()
    {
        var text = new HistoryParameter("Top", "5", "text");
        var number = text with { Type = "number" };

        Assert.NotEqual(HistoryKeys.SeriesKey(Query(parameters: [text]), Setting), HistoryKeys.SeriesKey(Query(parameters: [number]), Setting));
        Assert.Equal(HistoryKeys.QueryKey(Query(parameters: [text]), Setting), HistoryKeys.QueryKey(Query(parameters: [number]), Setting));
    }

    [Fact]
    public void Query_key_ignores_parameters_but_not_keys_or_mode()
    {
        var plain = HistoryKeys.QueryKey(Query(), Setting);

        Assert.Equal(plain, HistoryKeys.QueryKey(Query(parameters: [new HistoryParameter("x", "1")]), Setting));
        Assert.NotEqual(plain, HistoryKeys.QueryKey(Query(), Setting with { Keys = ["id", "cve"] }));
        Assert.NotEqual(plain, HistoryKeys.QueryKey(Query(), Setting with { Mode = HistoryMode.Values }));
    }

    [Fact]
    public void Option_property_order_does_not_change_the_key()
    {
        Assert.Equal(
            HistoryKeys.QueryKey(Query("{\"a\":1,\"b\":2}"), Setting),
            HistoryKeys.QueryKey(Query("{\"b\":2,\"a\":1}"), Setting));
    }
}
