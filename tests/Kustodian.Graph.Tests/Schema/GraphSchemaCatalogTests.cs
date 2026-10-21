using Kustodian.Graph.Schema;

namespace Kustodian.Graph.Tests;

public sealed class GraphSchemaCatalogTests
{
    [Fact]
    public void Beta_schema_loads_and_has_applications()
    {
        var schema = GraphSchemaCatalog.Beta;

        var applications = schema.Find("applications");
        Assert.NotNull(applications);
        var names = applications.Columns.Select(c => c.Name).ToHashSet();
        Assert.Contains("appId", names);
        Assert.Contains("passwordCredentials", names);
        Assert.Contains("onPremisesPublishing", names);
        Assert.True(schema.Tables.Count > 400);
    }
}
