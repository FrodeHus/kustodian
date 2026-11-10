using Kustodian.Graph.Run;

namespace Kustodian.Graph.Tests.Run;

public class QueryOptionsTests
{
    private static QueryWorkspace Ws(string id = "00000000-0000-0000-0000-000000000001") =>
        new(id, "contoso-sentinel", "/subscriptions/…/workspaces/contoso-sentinel");

    [Fact] public void No_workspaces_is_fine() => Assert.Null(QueryOptions.Problem(new("P30D", null)));
    [Fact] public void One_workspace_is_fine() => Assert.Null(QueryOptions.Problem(new("P90D", null, [Ws()])));
    [Fact] public void Two_workspaces_are_refused() => Assert.Equal("Pick one workspace.", QueryOptions.Problem(new(null, null, [Ws(), Ws()])));
    [Fact] public void A_customer_id_must_be_a_guid() => Assert.Equal("not-a-guid is not a workspace id.", QueryOptions.Problem(new(null, null, [Ws("not-a-guid")])));
    [Fact] public void A_null_entry_is_refused() => Assert.Equal("The workspace is missing.", QueryOptions.Problem(new(null, null, [null!])));
    [Fact] public void Over_30_days_without_a_workspace_is_refused() => Assert.Equal("The timespan can cover at most 30 days.", QueryOptions.Problem(new("P31D", null)));

    [Fact]
    public void Up_to_730_days_with_a_workspace()
    {
        Assert.Null(QueryOptions.Problem(new("P730D", null, [Ws()])));
        Assert.Equal("The timespan can cover at most 730 days.", QueryOptions.Problem(new("P731D", null, [Ws()])));
    }

    [Fact] public void Empty_list_counts_as_none() => Assert.Equal("The timespan can cover at most 30 days.", QueryOptions.Problem(new("P31D", null, [])));
}
