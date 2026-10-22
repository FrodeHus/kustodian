using Kustodian.Graph.Fetch;
using Kustodian.Graph.Query;
using Kustodian.Graph.Run;
using Kustodian.Graph.Schema;

namespace Kustodian.Graph.Tests;

public sealed class GraphLicenseGateTests
{
    private static readonly DateTimeOffset Now = new(2026, 10, 22, 0, 0, 0, TimeSpan.Zero);

    private static readonly GraphLicenses Map = new(
        new Dictionary<string, GraphLicenseRequirement>
        {
            ["auditLogs/signIns"] = new("Microsoft Entra ID P1 or P2", ["AAD_PREMIUM", "AAD_PREMIUM_P2"], "https://learn.microsoft.com/a"),
        },
        new Dictionary<string, GraphLicenseRequirement>
        {
            ["users.signInActivity"] = new("Microsoft Entra ID P1 or P2", ["AAD_PREMIUM", "AAD_PREMIUM_P2"], "https://learn.microsoft.com/b"),
        });

    private static GraphLicenseGate Gate(params string[] plans) =>
        new(Map, new TenantLicenses(plans.ToHashSet(StringComparer.OrdinalIgnoreCase)));

    private static readonly GraphLicenseGate UnknownGate = new(Map, TenantLicenses.Unknown("no permission"));

    private static GraphFetch Single(string kql, GraphLicenseGate gate) =>
        Assert.Single(GraphQueryPlanner.Plan(GraphSchemaCatalog.Beta, kql, Now, gate).Fetches);

    [Fact]
    public void A_red_column_is_left_out_of_the_select_with_its_license()
    {
        var fetch = Single("users | project displayName, signInActivity", Gate());

        Assert.DoesNotContain("signInActivity", fetch.Select);
        Assert.DoesNotContain("signInActivity", fetch.Named);
        Assert.Contains("displayName", fetch.Select);
        var gap = Assert.Single(fetch.LicenseLeftOut);
        Assert.Equal("signInActivity", gap.Column);
        Assert.Equal("Microsoft Entra ID P1 or P2", gap.Requirement.License);
        Assert.Null(fetch.MissingLicense);
    }

    [Fact]
    public void A_condition_on_a_red_column_runs_locally()
    {
        var explained = GraphQueryPlanner.PlanExplained(GraphSchemaCatalog.Beta,
            "users | where accountEnabled == true and todatetime(signInActivity.lastSignInDateTime) < ago(30d) | take 5", Now, Gate());
        var fetch = Assert.Single(explained.Plan.Fetches);

        Assert.Equal("accountEnabled eq true", fetch.Filter);
        var local = Assert.Single(explained.Filters[0].Local);
        Assert.Equal(PushdownReasons.Unlicensed("signInActivity", "Microsoft Entra ID P1 or P2"), local.Reason);
        // A condition kept local means Graph's first rows aren't the query's.
        Assert.Null(fetch.Top);
    }

    [Fact]
    public void A_sort_on_a_red_column_is_not_sent()
    {
        var map = new GraphLicenses(new Dictionary<string, GraphLicenseRequirement>(), new Dictionary<string, GraphLicenseRequirement>
        {
            ["users.createdDateTime"] = new("Microsoft Entra ID P2", ["AAD_PREMIUM_P2"], "https://learn.microsoft.com/c"),
        });
        var gate = new GraphLicenseGate(map, new TenantLicenses(new HashSet<string>()));

        var fetch = Single("users | top 5 by createdDateTime", gate);

        Assert.Null(fetch.OrderBy);
        Assert.Null(fetch.Top);
    }

    [Fact]
    public void A_column_the_tenant_has_the_license_for_is_selected()
    {
        var fetch = Single("users | project displayName, signInActivity", Gate("AAD_PREMIUM"));

        Assert.Contains("signInActivity", fetch.Select);
        Assert.Empty(fetch.LicenseLeftOut);
    }

    [Fact]
    public void Unknown_licenses_change_nothing()
    {
        var gated = Single("users | where todatetime(signInActivity.lastSignInDateTime) < ago(30d) | project signInActivity", UnknownGate);
        var plain = Assert.Single(GraphQueryPlanner.Plan(GraphSchemaCatalog.Beta,
            "users | where todatetime(signInActivity.lastSignInDateTime) < ago(30d) | project signInActivity", Now).Fetches);

        Assert.Equal(plain.Select, gated.Select);
        Assert.Equal(plain.Filter, gated.Filter);
        Assert.Empty(gated.LicenseLeftOut);
    }

    [Fact]
    public void A_red_column_the_query_does_not_touch_is_not_noted()
    {
        var fetch = Single("users | project displayName", Gate());

        Assert.Empty(fetch.LicenseLeftOut);
    }

    [Fact]
    public void A_red_table_carries_its_missing_license()
    {
        var fetch = Single("auditLogs_signIns | take 10", Gate("AAD_PREMIUM_P2X"));

        Assert.Equal("Microsoft Entra ID P1 or P2", fetch.MissingLicense?.License);
        Assert.Null(Single("auditLogs_signIns | take 10", Gate("AAD_PREMIUM_P2")).MissingLicense);
        Assert.Null(Single("auditLogs_signIns | take 10", UnknownGate).MissingLicense);
    }

    [Fact]
    public void Explain_shows_what_was_left_out_and_why()
    {
        var view = GraphExplain.Explain(GraphSchemaCatalog.Beta, "users | project displayName, signInActivity", Now, GraphLimits.Default, Gate());

        var table = Assert.Single(view.Tables);
        var left = Assert.Single(table.LicenseLeftOut);
        Assert.Equal("signInActivity", left.Column);
        Assert.Equal("Microsoft Entra ID P1 or P2", left.License);
        Assert.Equal("https://learn.microsoft.com/b", left.Source);
        Assert.DoesNotContain("signInActivity", table.Select);
        Assert.Null(table.MissingLicense);
    }

    [Fact]
    public void Explain_names_the_license_a_red_table_needs()
    {
        var view = GraphExplain.Explain(GraphSchemaCatalog.Beta, "auditLogs_signIns | take 10", Now, GraphLimits.Default, Gate());

        Assert.Equal("Microsoft Entra ID P1 or P2", Assert.Single(view.Tables).MissingLicense);
    }
}
