using Kustodian.Auth.EntraApp;
using Kustodian.Graph.Schema;

namespace Kustodian.Tests.Auth.EntraApp;

public sealed class PermissionPlannerTests
{
    private static GraphTable Table(string path) => new(path.Replace('/', '_'), path, "x", "", "", []);

    private static CatalogPermission P(string name, bool admin, params string[] tables) => new(name, admin, "d", tables);

    private static GraphAreas Areas() => new(new Dictionary<string, string>
    {
        ["users"] = "Users, groups and directory",
        ["groups"] = "Users, groups and directory",
        ["applications"] = "Apps and permissions",
        ["me/"] = "Mail, Teams and files",
        ["security/"] = "Security",
        ["reports/"] = "Reports and usage",
    });

    private static PermissionPlan Plan(IEnumerable<CatalogPermission> permissions, params string[] paths) =>
        PermissionPlanner.Plan(new GraphPermissionCatalog("t", [.. permissions]), [.. paths.Select(Table)], Areas());

    private static IEnumerable<PlannedPermission> All(PermissionPlan plan) =>
        plan.Groups.SelectMany(g => g.Subgroups).SelectMany(s => s.Permissions);

    private static PlannedPermission Find(PermissionPlan plan, string name) => All(plan).Single(p => p.Name == name);

    [Fact]
    public void Read_only_filter_drops_Write_and_non_Read_names()
    {
        var plan = Plan(
            [P("X.ReadWrite.All", false, "users"), P("Directory.AccessAsUser.All", true, "users"), P("AppCatalog.Submit", false, "users"), P("User.Read.All", true, "users")],
            "users");
        var names = All(plan).Select(p => p.Name).ToList();
        Assert.Contains("User.Read.All", names);
        Assert.DoesNotContain("X.ReadWrite.All", names);
        Assert.DoesNotContain("Directory.AccessAsUser.All", names);
        Assert.DoesNotContain("AppCatalog.Submit", names);
    }

    [Fact]
    public void Greedy_cover_prefers_the_permission_covering_most_uncovered_tables()
    {
        var plan = Plan([P("Narrow.Read", false, "users"), P("Broad.Read", false, "users", "groups")], "users", "groups");
        var names = All(plan).Select(p => p.Name).ToList();
        Assert.Contains("Broad.Read", names);
        Assert.DoesNotContain("Narrow.Read", names);
    }

    [Fact]
    public void Ties_prefer_no_admin_consent_then_name()
    {
        var plan = Plan([P("A.Read", true, "users"), P("C.Read", false, "users"), P("B.Read", false, "users")], "users");
        Assert.Equal(["B.Read"], All(plan).Where(p => p.Resource == "Microsoft Graph" && p.Name != "ThreatHunting.Read.All").Select(p => p.Name));
    }

    [Fact]
    public void Permission_is_homed_in_its_majority_area_ties_to_first_in_Names_order()
    {
        var plan = Plan(
            [P("Majority.Read", false, "users", "groups", "applications"), P("Tie.Read", false, "applications", "users")],
            "users", "groups", "applications");
        var graph = plan.Groups.Single(g => g.Id == "graph");
        Assert.Contains(graph.Subgroups.Single(s => s.Title == "Users, groups and directory").Permissions, p => p.Name == "Majority.Read");

        var tie = Plan([P("Tie.Read", false, "applications", "users")], "users", "applications");
        Assert.Contains(tie.Groups.Single(g => g.Id == "graph").Subgroups.Single(s => s.Title == "Users, groups and directory").Permissions, p => p.Name == "Tie.Read");
    }

    [Fact]
    public void Security_area_moves_to_Security_group_under_Graph_security_data()
    {
        var plan = Plan([P("SecurityAlert.Read.All", true, "security/alerts")], "security/alerts");
        Assert.DoesNotContain(plan.Groups.Single(g => g.Id == "graph").Subgroups, s => s.Title == "Security");
        var security = plan.Groups.Single(g => g.Id == "security");
        Assert.Equal(["Advanced hunting", "Graph security data"], security.Subgroups.Select(s => s.Title));
        Assert.Contains(security.Subgroups[1].Permissions, p => p.Name == "SecurityAlert.Read.All" && p.Ticked);
    }

    [Fact]
    public void Default_tick_follows_home_area()
    {
        var plan = Plan(
            [P("Mail.Read", false, "me/messages", "me/events", "users"), P("User.Read.All", false, "users", "groups"), P("Report.Read.All", false, "reports/x")],
            "users", "groups", "me/messages", "me/events", "reports/x");
        Assert.False(Find(plan, "Mail.Read").Ticked);
        Assert.False(Find(plan, "Report.Read.All").Ticked);
        Assert.True(Find(plan, "User.Read.All").Ticked);
    }

    [Fact]
    public void Sources_are_added()
    {
        var plan = Plan([]);
        var hunting = Find(plan, "ThreatHunting.Read.All");
        Assert.True(hunting.Ticked);
        Assert.True(hunting.AdminConsent);
        Assert.Equal("Defender advanced hunting tabs", hunting.Unlocks);
        Assert.Equal("Advanced hunting", plan.Groups.Single(g => g.Id == "security").Subgroups[0].Title);
        var arg = Find(plan, "user_impersonation");
        Assert.True(arg.Ticked);
        Assert.False(arg.AdminConsent);
        Assert.Equal("Azure Service Management", arg.Resource);
        Assert.Equal(SourcePermissions.ArmAppId, arg.ResourceAppId);
        Assert.Equal("Resource Graph", plan.Groups.Single(g => g.Id == "azure").Subgroups.Single().Title);
    }

    [Fact]
    public void Hunting_is_listed_once_even_if_the_catalog_has_it()
    {
        var plan = Plan([P("ThreatHunting.Read.All", true, "users")], "users");
        Assert.Single(All(plan), p => p.Name == "ThreatHunting.Read.All");
    }

    [Fact]
    public void Counts_tables_without_data_and_write_only_tables()
    {
        var plan = Plan([P("User.Read.All", false, "users"), P("Group.ReadWrite.All", false, "groups", "users")], "users", "groups", "applications");
        Assert.Equal(1, plan.TablesWithData);
        Assert.Equal(1, plan.WriteOnlyTables);
        Assert.Equal(1, plan.TablesWithoutData);
    }

    [Fact]
    public void Lost_tables_only_counts_tables_with_no_other_ticked_cover()
    {
        var plan = Plan(
            [P("Broad.Read", false, "users", "groups", "applications"), P("Other.Read", false, "users", "me/x", "groups")],
            "users", "groups", "applications", "me/x");
        var all = All(plan).Select(p => $"{p.Resource}|{p.Name}").ToHashSet();
        const string broad = "Microsoft Graph|Broad.Read";
        const string other = "Microsoft Graph|Other.Read";

        Assert.Equal(["applications"], PermissionPlanner.LostTables(plan, all, broad));
        Assert.Equal(["me/x"], PermissionPlanner.LostTables(plan, all, other));

        var onlyBroad = new HashSet<string> { broad };
        Assert.Equal(["applications", "groups", "users"], PermissionPlanner.LostTables(plan, onlyBroad, broad));
    }

    [Fact]
    public void Bundled_plan_matches_spec_numbers()
    {
        var plan = PermissionPlanner.Plan(GraphPermissionCatalog.Bundled, GraphSchemaCatalog.Beta.Tables, GraphAreas.Bundled);
        var graph = plan.Groups.SelectMany(g => g.Subgroups).SelectMany(s => s.Permissions).Where(p => p.Resource == "Microsoft Graph" && p.Name != "ThreatHunting.Read.All").ToList();
        Assert.Equal(67, graph.Count);
        Assert.Equal(295, plan.TablesWithData);
        Assert.Equal(8, plan.WriteOnlyTables);
    }
}
