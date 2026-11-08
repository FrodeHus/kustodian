using Kustodian.Graph.Fetch;
using Kustodian.Graph.Query;
using Kustodian.Graph.Schema;

namespace Kustodian.Graph.Tests;

/// <summary>A single object (<see cref="GraphTable.Single"/>): planned without pushdown, read with one GET.</summary>
public sealed partial class GraphCollectionReaderTests
{
    private const string SecurityDefaults = "policies_identitySecurityDefaultsEnforcementPolicy";

    [Fact]
    public void A_single_object_is_planned_without_filter_top_sort_or_count()
    {
        var plan = GraphQueryPlanner.Plan(GraphSchemaCatalog.Beta,
            SecurityDefaults + " | where isEnabled == true | top 1 by displayName | project isEnabled", DateTimeOffset.UnixEpoch);

        var fetch = Assert.Single(plan.Fetches);
        Assert.True(fetch.Table.Single);
        Assert.Null(fetch.Filter);
        Assert.Empty(fetch.FilterClauses);
        Assert.Null(fetch.Top);
        Assert.Null(fetch.OrderBy);
        Assert.True(fetch.FilteredLocally);
        Assert.Equal("policies/identitySecurityDefaultsEnforcementPolicy?$select=" + Uri.EscapeDataString("displayName,isEnabled,id"),
            GraphCollectionReader.FirstPageUrl(fetch));

        var count = Assert.Single(GraphQueryPlanner.Plan(GraphSchemaCatalog.Beta, SecurityDefaults + " | count", DateTimeOffset.UnixEpoch).Fetches);
        Assert.Null(count.Count);
    }

    [Fact]
    public async Task A_single_object_is_read_with_one_get_as_one_object()
    {
        var table = GraphSchemaCatalog.Beta.Find(SecurityDefaults)!;
        var handler = new Scripted((_, _) => Json(System.Net.HttpStatusCode.OK, """
            {"@odata.context":"https://graph.microsoft.com/beta/$metadata#policies/identitySecurityDefaultsEnforcementPolicy/$entity","id":"00000000-0000-0000-0000-000000000005","isEnabled":true}
            """));

        var result = await Read(Reader(handler), new GraphFetch(table, ["isEnabled", "id"], null));

        var o = Assert.Single(result.Objects);
        Assert.True(o["isEnabled"]!.GetValue<bool>());
        Assert.Equal("policies/identitySecurityDefaultsEnforcementPolicy?$select=" + Uri.EscapeDataString("isEnabled,id"),
            Assert.Single(result.Requests));
    }
}
