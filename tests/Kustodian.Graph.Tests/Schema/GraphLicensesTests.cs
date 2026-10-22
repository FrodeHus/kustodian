using System.Text;
using Kustodian.Graph.Schema;

namespace Kustodian.Graph.Tests;

public sealed class GraphLicensesTests
{
    private static GraphLicenseRequirement Need(string license, params string[] plans) =>
        new(license, plans, "https://learn.microsoft.com/x");

    [Fact]
    public void Longest_table_match_wins()
    {
        var licenses = new GraphLicenses(
            new Dictionary<string, GraphLicenseRequirement>
            {
                ["identityProtection/"] = Need("Microsoft Entra ID P2", "AAD_PREMIUM_P2"),
                ["identityProtection/riskyServicePrincipals"] = Need("Workload Identities Premium", "Workload_Identities_Prem"),
                ["auditLogs/signIns"] = Need("Microsoft Entra ID P1 or P2", "AAD_PREMIUM", "AAD_PREMIUM_P2"),
            },
            new Dictionary<string, GraphLicenseRequirement>());

        Assert.Equal("Microsoft Entra ID P2", licenses.ForTable("identityProtection/riskyUsers")?.License);
        Assert.Equal("Workload Identities Premium", licenses.ForTable("identityProtection/riskyServicePrincipals")?.License);
        Assert.Equal(["AAD_PREMIUM", "AAD_PREMIUM_P2"], licenses.ForTable("auditLogs/signIns")?.Plans);
        // An exact entry is only that path.
        Assert.Null(licenses.ForTable("auditLogs/signInsMore"));
        Assert.Null(licenses.ForTable("users"));
    }

    [Fact]
    public void Columns_are_matched_by_table_path_and_name()
    {
        var licenses = new GraphLicenses(
            new Dictionary<string, GraphLicenseRequirement>(),
            new Dictionary<string, GraphLicenseRequirement> { ["users.signInActivity"] = Need("Microsoft Entra ID P1 or P2", "AAD_PREMIUM") });

        Assert.Equal("Microsoft Entra ID P1 or P2", licenses.ForColumn("users", "signInActivity")?.License);
        Assert.Null(licenses.ForColumn("users", "displayName"));
        Assert.Null(licenses.ForColumn("groups", "signInActivity"));
    }

    [Fact]
    public void Read_takes_tables_and_columns_with_their_sources()
    {
        const string json = """
            {
              "tables": {
                "identityProtection/": { "license": "Microsoft Entra ID P2", "plans": ["AAD_PREMIUM_P2"], "source": "https://learn.microsoft.com/a" }
              },
              "columns": {
                "users.signInActivity": { "license": "Microsoft Entra ID P1 or P2", "plans": ["AAD_PREMIUM", "AAD_PREMIUM_P2"], "source": "https://learn.microsoft.com/b" }
              }
            }
            """;

        var licenses = GraphLicenses.Read(new MemoryStream(Encoding.UTF8.GetBytes(json)));

        Assert.Equal("https://learn.microsoft.com/a", licenses.ForTable("identityProtection/riskDetections")?.Source);
        Assert.Equal(["AAD_PREMIUM", "AAD_PREMIUM_P2"], licenses.ForColumn("users", "signInActivity")?.Plans);
    }

    [Theory]
    [InlineData("""{ "tables": { "a": { "license": "L", "plans": [], "source": "https://learn.microsoft.com/a" } }, "columns": {} }""")]
    [InlineData("""{ "tables": { "a": { "license": "", "plans": ["P"], "source": "https://learn.microsoft.com/a" } }, "columns": {} }""")]
    [InlineData("""{ "tables": { "a": { "license": "L", "plans": ["P"], "source": "https://example.com/a" } }, "columns": {} }""")]
    [InlineData("""{ "tables": {}, "columns": { "users": { "license": "L", "plans": ["P"], "source": "https://learn.microsoft.com/a" } } }""")]
    [InlineData("""{ "tables": { "a": { "license": "L", "plans": ["P"], "source": "https://learn.microsoft.com/a" }, "a": { "license": "L", "plans": ["P"], "source": "https://learn.microsoft.com/a" } }, "columns": {} }""")]
    public void Read_refuses_an_entry_without_plans_license_learn_source_or_column(string json)
    {
        Assert.Throws<InvalidOperationException>(() => GraphLicenses.Read(new MemoryStream(Encoding.UTF8.GetBytes(json))));
    }

    [Fact]
    public void Every_bundled_table_entry_matches_a_bundled_table()
    {
        var paths = GraphSchemaCatalog.Beta.Tables.Select(t => t.Path).ToList();

        var stale = GraphLicenses.Bundled.Tables.Keys.Where(entry => !paths.Any(path => GraphAreas.Matches(entry, path))).ToList();

        Assert.Empty(stale);
    }

    [Fact]
    public void Every_bundled_column_entry_matches_a_bundled_column()
    {
        var schema = GraphSchemaCatalog.Beta;

        var stale = GraphLicenses.Bundled.Columns.Keys.Where(entry =>
        {
            var dot = entry.LastIndexOf('.');
            var (path, column) = (entry[..dot], entry[(dot + 1)..]);
            return !schema.Tables.Any(t => t.Path == path && t.Columns.Any(c => c.Name == column));
        }).ToList();

        Assert.Empty(stale);
    }

    [Fact]
    public void The_bundled_map_covers_the_known_starting_points()
    {
        var licenses = GraphLicenses.Bundled;

        Assert.Contains("AAD_PREMIUM_P2", licenses.ForTable("identityProtection/riskyUsers")!.Plans);
        Assert.Contains("AAD_PREMIUM", licenses.ForTable("auditLogs/signIns")!.Plans);
        Assert.Contains("AAD_PREMIUM", licenses.ForColumn("users", "signInActivity")!.Plans);
        Assert.Contains("AAD_PREMIUM", licenses.ForTable("policies/conditionalAccessPolicies")!.Plans);
        Assert.Contains("INTUNE_A", licenses.ForTable("deviceManagement/managedDevices")!.Plans);
        Assert.Null(licenses.ForTable("users"));
    }
}
