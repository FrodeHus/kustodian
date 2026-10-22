using Kustodian.Graph.Query;
using Kustodian.Graph.Schema;

namespace Kustodian.Graph.Tests;

public sealed class GraphCompletionTests
{
    private static IReadOnlyList<GraphCompletionItem> CompleteAtEnd(string kql) =>
        GraphCompletion.Complete(GraphSchemaCatalog.Beta, kql, kql.Length);

    [Fact]
    public void Completion_offers_relationship_entry_fields()
    {
        var items = GraphCompletion.Complete(TestSchemas.Fixture(), "applications | mv-expand o = owners | where o.", 46);

        Assert.Contains(items, i => i.Label == "objectType");
        Assert.Contains(items, i => i.Label == "userPrincipalName");
        Assert.Contains(items, i => i.Label == "displayName");
    }

    [Fact]
    public void Completion_types_single_relationship_as_a_bag()
    {
        var items = GraphCompletion.Complete(TestSchemas.Fixture(), "applications | where primaryOwner.", 34);

        Assert.Contains(items, i => i.Label == "displayName");
    }

    [Fact]
    public void Offers_the_fields_of_a_complex_column_with_type_and_description()
    {
        var items = CompleteAtEnd("applications | where onPremisesPublishing.");

        var item = Assert.Single(items, i => i.Label == "externalAuthenticationType");
        Assert.Equal("string", item.Type);
        Assert.Equal("Column", item.Kind);
        Assert.All(items, i => Assert.DoesNotContain(i.Label, new[] { "where", "project", "displayName" }));
    }

    [Fact]
    public void Offers_the_fields_of_an_alias_over_an_expanded_collection()
    {
        var items = CompleteAtEnd("applications | mv-expand c = passwordCredentials | where c.");

        Assert.Equal("datetime", Assert.Single(items, i => i.Label == "endDateTime").Type);
    }

    [Fact]
    public void Offers_nested_fields_down_to_the_third_level()
    {
        var items = CompleteAtEnd("applications | where onPremisesPublishing.singleSignOnSettings.kerberosSignOnSettings.");

        Assert.Contains(items, i => i.Label == "kerberosServicePrincipalName");
    }

    [Fact]
    public void Offers_nothing_below_the_depth_cap()
    {
        Assert.Contains(CompleteAtEnd("users | where identityGovernance.approverDelegate.schedule."), i => i.Label == "expiration");

        Assert.Empty(CompleteAtEnd("users | where identityGovernance.approverDelegate.schedule.expiration."));
    }

    [Fact]
    public void Offers_nothing_after_a_dot_on_a_plain_value()
    {
        Assert.Empty(CompleteAtEnd("applications | where displayName."));
    }

    [Fact]
    public void A_position_inside_the_query_completes_there()
    {
        const string head = "applications | where onPremisesPublishing.";
        var items = GraphCompletion.Complete(GraphSchemaCatalog.Beta, head + " | take 5", head.Length);

        Assert.Contains(items, i => i.Label == "externalAuthenticationType");
    }
}
