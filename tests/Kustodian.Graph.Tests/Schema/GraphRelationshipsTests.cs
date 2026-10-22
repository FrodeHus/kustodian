using Kustodian.Graph.Schema;

namespace Kustodian.Graph.Tests;

public sealed class GraphRelationshipsTests
{
    [Fact]
    public void Bundled_list_is_the_spec_list()
    {
        var expected = new Dictionary<string, string[]>
        {
            ["users"] = ["memberOf", "manager", "directReports", "ownedObjects", "registeredDevices", "ownedDevices"],
            ["groups"] = ["members", "owners"],
            ["servicePrincipals"] = ["owners"],
            ["applications"] = ["owners"],
            ["devices"] = ["registeredOwners", "registeredUsers"],
        };

        var bundled = GraphRelationships.Bundled;

        Assert.Equal(expected.Keys.Order(), bundled.Keys.Order());
        foreach (var (table, names) in expected)
            Assert.Equal(names, bundled[table]);
        Assert.DoesNotContain(bundled.Values.SelectMany(v => v), n => n.StartsWith("transitive", StringComparison.Ordinal));
    }
}
