using Kustodian.Graph.Schema;

namespace Kustodian.Graph.Tests;

public sealed class GraphRelationshipsTests
{
    [Fact]
    public void Bundled_list_is_the_spec_list()
    {
        var expected = new Dictionary<string, string[]>
        {
            ["users"] = ["memberOf", "transitiveMemberOf", "manager", "directReports", "ownedObjects", "registeredDevices", "ownedDevices",
                "authenticationMethods", "authenticationRequirements"],
            ["groups"] = ["members", "owners"],
            ["servicePrincipals"] = ["owners"],
            ["applications"] = ["owners"],
            ["devices"] = ["registeredOwners", "registeredUsers"],
        };

        var bundled = GraphRelationships.Bundled;

        Assert.Equal(expected.Keys.Order(), bundled.Keys.Order());
        foreach (var (table, names) in expected)
            Assert.Equal(names, bundled[table].Select(r => r.Name));
        // users.transitiveMemberOf is the one transitive relationship (owner's call): nested reads are what throttles a large tenant.
        Assert.Equal(["transitiveMemberOf"], bundled.Values.SelectMany(v => v).Where(r => r.ReadPath.StartsWith("transitive", StringComparison.Ordinal)).Select(r => r.Name));
        Assert.Equal("authentication/methods", bundled["users"].Single(r => r.Name == "authenticationMethods").Path);
        Assert.Null(bundled["users"].Single(r => r.Name == "memberOf").Path);
    }
}
