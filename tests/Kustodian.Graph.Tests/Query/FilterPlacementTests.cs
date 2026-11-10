using Kustodian.Graph.Query;
using Kustodian.Graph.Schema;

namespace Kustodian.Graph.Tests;

public sealed class FilterPlacementTests
{
    private const string GraphLeadingKql = "users | where accountEnabled == true | project id, displayName | take 50";

    private static string? Before(string source, string kql, string column) =>
        FilterPlacement.Offset(kql, column, source == "graph" ? GraphSchemaCatalog.Beta : null) is { } offset ? kql[..offset] : null;

    [Theory]
    // EndOfQuery
    [InlineData("hunting", "DeviceEvents | where X == 1", "X", "DeviceEvents | where X == 1")]
    // BeforeTrailingTake
    [InlineData("hunting", "T | project a | take 10", "a", "T | project a")]
    // BeforeTrailingLimitAndRender
    [InlineData("hunting", "T | summarize n=count() by a | limit 5 | render columnchart", "a", "T | summarize n=count() by a")]
    // AfterTop
    [InlineData("hunting", "T | top 5 by a", "a", "T | top 5 by a")]
    // LastStatement
    [InlineData("arg", "let x = 1;\nResources | take 3", "name", "let x = 1;\nResources")]
    // Multiline
    [InlineData("hunting", "T\n| where a > 1\n| take 10\n", "a", "T\n| where a > 1")]
    // GraphLeading
    [InlineData("graph", GraphLeadingKql, "displayName", "users | where accountEnabled == true")]
    // GraphNoLeadingWhere
    [InlineData("graph", "users | project id, displayName | take 50", "displayName", "users")]
    // GraphComputedColumn
    [InlineData("graph", "users | extend n = strlen(displayName) | take 5", "n", "users | extend n = strlen(displayName)")]
    // GraphRenamedColumn
    [InlineData("graph", "users | project-rename name = displayName", "name", "users | project-rename name = displayName")]
    // GraphSelfJoin
    [InlineData("graph", "users | join (users) on id", "id", "users | join (users) on id")]
    // GraphArgMax: summarize picks a row per group from all rows
    [InlineData("graph", "users | summarize arg_max(createdDateTime, *) by companyName", "displayName",
        "users | summarize arg_max(createdDateTime, *) by companyName")]
    // GraphLeftOuterJoin: the column comes from inside the join
    [InlineData("graph", "groups | join kind=leftouter (users) on $left.id == $right.id", "userPrincipalName",
        "groups | join kind=leftouter (users) on $left.id == $right.id")]
    // GraphTop: top picks its rows from all rows
    [InlineData("graph", "users | top 5 by createdDateTime", "displayName", "users | top 5 by createdDateTime")]
    // NotAQuery
    [InlineData("hunting", ".show tables", "x", null)]
    public void Offset_is_after_the_expected_text(string source, string kql, string column, string? expected)
    {
        Assert.Equal(expected, Before(source, kql, column));
    }

    [Fact]
    public void GraphLeadingIsPushedDown()
    {
        var fetch = PlanWithFilter(GraphLeadingKql);

        Assert.Contains("displayName eq 'x'", fetch.Filter);
    }

    [Fact]
    public void GraphLeadingKeepsTop()
    {
        var fetch = PlanWithFilter("users | take 50");

        Assert.Contains("displayName eq 'x'", fetch.Filter);
        Assert.Equal(50, fetch.Top);
    }

    private static GraphFetch PlanWithFilter(string kql)
    {
        var offset = FilterPlacement.Offset(kql, "displayName", GraphSchemaCatalog.Beta);
        Assert.NotNull(offset);
        var filtered = kql.Insert(offset.Value, " | where displayName == \"x\"");
        var plan = GraphQueryPlanner.Plan(GraphSchemaCatalog.Beta, filtered, DateTimeOffset.UnixEpoch);
        Assert.True(plan.CanRun, plan.Error?.Message ?? plan.Refusal);
        return Assert.Single(plan.Fetches);
    }
}
