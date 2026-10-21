using Kustodian.Graph.Schema;

namespace Kustodian.Graph.Tests;

public sealed class GraphAreasTests
{
    [Fact]
    public void Every_bundled_graph_table_has_a_known_area()
    {
        foreach (var table in GraphSchemaCatalog.Beta.Tables)
            Assert.Contains(GraphAreas.Bundled.Of(table.Path), GraphAreas.Names);
    }

    [Fact]
    public void Graph_areas_have_no_stale_entries()
    {
        var paths = GraphSchemaCatalog.Beta.Tables.Select(t => t.Path).ToList();

        var stale = GraphAreas.Bundled.Entries.Keys.Where(entry => !paths.Any(path => GraphAreas.Matches(entry, path))).ToList();

        Assert.Empty(stale);
    }

    [Fact]
    public void Longest_prefix_wins()
    {
        var areas = new GraphAreas(new Dictionary<string, string>
        {
            ["external/"] = "Other",
            ["external/authorizationSystems"] = "Apps and permissions",
            ["deviceManagement/"] = "Devices and Intune",
            ["deviceManagement/virtualEndpoint/"] = "Reports and usage",
            ["users"] = "Users, groups and directory",
        });

        Assert.Equal("Apps and permissions", areas.Of("external/authorizationSystems"));
        Assert.Equal("Other", areas.Of("external/connections"));
        Assert.Equal("Reports and usage", areas.Of("deviceManagement/virtualEndpoint/cloudPCs"));
        Assert.Equal("Devices and Intune", areas.Of("deviceManagement/managedDevices"));
        Assert.Equal("Users, groups and directory", areas.Of("users"));
        // An exact entry names one top-level collection, not everything that starts with it.
        Assert.Equal("Other", areas.Of("usersAndMore"));
        Assert.Equal("Other", areas.Of("users/x"));
    }

    [Fact]
    public void Unmapped_path_is_other()
    {
        Assert.Equal(GraphAreas.Other, GraphAreas.Bundled.Of("somethingGraphAddsLater"));
        Assert.Equal(GraphAreas.Other, GraphAreas.Bundled.Of("brandNew/collection"));
        Assert.Equal("Other", GraphAreas.Other);
        Assert.Equal(GraphAreas.Other, GraphAreas.Names[^1]);
    }

    [Fact]
    public void Graph_areas_are_the_eleven_in_display_order()
    {
        Assert.Equal(
            [
                "Users, groups and directory", "Apps and permissions", "Sign-in and audit logs", "Risk and identity protection",
                "Access reviews and privileged roles", "Policies and Conditional Access", "Devices and Intune", "Security",
                "Mail, Teams and files", "Reports and usage", "Other",
            ],
            GraphAreas.Names);
    }

    [Fact]
    public void Other_holds_at_most_twenty_bundled_tables()
    {
        var other = GraphSchemaCatalog.Beta.Tables.Where(t => GraphAreas.Bundled.Of(t.Path) == GraphAreas.Other).ToList();

        Assert.InRange(other.Count, 0, 20);
    }

    [Fact]
    public void Starting_assignments_place_the_known_collections()
    {
        var areas = GraphAreas.Bundled;
        Assert.Equal("Sign-in and audit logs", areas.Of("auditLogs/signIns"));
        Assert.Equal("Risk and identity protection", areas.Of("identityProtection/riskyServicePrincipals"));
        Assert.Equal("Policies and Conditional Access", areas.Of("policies/conditionalAccessPolicies"));
        Assert.Equal("Devices and Intune", areas.Of("deviceManagement/managedDevices"));
        Assert.Equal("Access reviews and privileged roles", areas.Of("privilegedRoles"));
        Assert.Equal("Reports and usage", areas.Of("reports/credentialUserRegistrationDetails"));
    }

    [Fact]
    public void Owner_placements_beat_their_prefixes()
    {
        var areas = GraphAreas.Bundled;
        Assert.Equal("Apps and permissions", areas.Of("copilot/agentRegistrations"));
        Assert.Equal("Other", areas.Of("copilot/conversations"));
        // Windows LAPS passwords are a device's.
        Assert.Equal("Devices and Intune", areas.Of("directory/deviceLocalCredentials"));
        Assert.Equal("Users, groups and directory", areas.Of("directory/deletedItems"));
        // Windows 365 alerts.
        Assert.Equal("Devices and Intune", areas.Of("monitoring/alertRecords"));
        Assert.Equal("Devices and Intune", areas.Of("monitoring/alertRules"));
        Assert.Equal("Reports and usage", areas.Of("monitoring/somethingElse"));
    }

    [Fact]
    public void Read_refuses_a_repeated_key()
    {
        using var stream = new MemoryStream("""{"users":"Users, groups and directory","users":"Other"}"""u8.ToArray());

        var error = Assert.Throws<InvalidOperationException>(() => GraphAreas.Read(stream));

        Assert.Equal("graph-areas.json lists users twice.", error.Message);
    }

    [Fact]
    public void An_entry_with_an_unknown_area_is_refused()
    {
        var error = Assert.Throws<InvalidOperationException>(() => new GraphAreas(new Dictionary<string, string> { ["users"] = "People" }));

        Assert.Contains("People", error.Message, StringComparison.Ordinal);
    }
}
