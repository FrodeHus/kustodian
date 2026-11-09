using Kustodian.Graph.Engine;
using Kustodian.Graph.Schema;

namespace Kustodian.Engine.Tests;

/// <summary>Operators that read no column, over no rows: KustoLoco 1.5.0 got these wrong (fixed in 1.5.1).</summary>
public sealed class NoRowsTests
{
    private static EngineResponse Run(string kql) => EngineHandler.Handle(new EngineRequest(kql,
        new DateTimeOffset(2026, 10, 20, 0, 0, 0, TimeSpan.Zero),
        [EngineTables.FromFixture("applications"), EngineTables.Of(GraphSchemaCatalog.Beta.Find("servicePrincipals")!, [])],
        10_000));

    private static string?[] Column(EngineResponse response, int column = 0)
    {
        Assert.True(response.Error is null, response.Error);
        return response.Rows!.Select(row => row[column].ToString()).ToArray();
    }

    [Theory]
    [InlineData("union (applications | summarize n = count() | where n == 0 | project x = 'none'), (print x = 'y')")]
    [InlineData("union (applications | summarize n = count() | where n == 0 | extend x = 'none' | project x), (print x = 'y')")]
    [InlineData("union (applications | where false | project x = 'none'), (print x = 'y')")]
    public void Constants_over_no_rows_add_no_row_to_a_union(string kql) => Assert.Equal(["y"], Column(Run(kql)));

    [Theory]
    [InlineData("applications | where false | project x = 'none'")]
    [InlineData("applications | where false | extend x = 'none' | project x")]
    [InlineData("applications | where 1 == 2 | project displayName")]
    [InlineData("applications | summarize n = count() | where n == 0 | project x = 'none'")]
    [InlineData("applications | where displayName == 'none' | project x = strcat('a', 'b')")]
    [InlineData("let none = 'none'; applications | take 0 | project x = none")]
    [InlineData("servicePrincipals | project x = 'none'")]
    [InlineData("servicePrincipals | where false | project displayName")]
    public void Over_no_rows_give_no_rows(string kql)
    {
        var response = Run(kql);
        Assert.Empty(Column(response));
        Assert.Single(response.Columns!);
    }

    [Fact]
    public void Count_after_where_false_is_zero() =>
        Assert.Equal(["0"], Column(Run("applications | where false | count")));

    [Fact]
    public void Join_with_where_false_keeps_the_left_rows() =>
        Assert.Equal(["6"], Column(Run("applications | join kind=leftouter (applications | where false) on appId | count")));

    [Fact]
    public void Constants_over_rows_give_one_row_each_with_their_names()
    {
        var response = Run("applications | project ['it\\'s'] = 'a', strcat('b', 'c'), n = 1");
        Assert.Equal(["it's", "Column1", "n"], response.Columns!.Select(c => c.Name));
        Assert.Equal(Enumerable.Repeat("a", 6), Column(response));
        Assert.Equal(Enumerable.Repeat("bc", 6), Column(response, 1));
    }

    [Fact]
    public void A_true_condition_keeps_every_row() =>
        Assert.Equal(6, Column(Run("applications | where true | project displayName")).Length);
}
