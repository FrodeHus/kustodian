using Kustodian.Sources.Arg;

namespace Kustodian.Sources.Tests.Arg;

public class ArgSchemaTests
{
    [Fact]
    public void Arg_schema_has_the_documented_tables_with_common_columns()
    {
        var tables = BuiltInArgSchema.Tables;

        foreach (var name in new[]
        {
            "Resources", "ResourceContainers", "AuthorizationResources", "SecurityResources", "PolicyResources", "AdvisorResources",
            "HealthResources", "AlertsManagementResources", "MaintenanceResources", "NetworkResources",
        })
        {
            Assert.Contains(tables, t => t.Name == name);
        }

        Assert.Equal(40, tables.Count);
        Assert.Equal(tables.Count, tables.Select(t => t.Name).Distinct(StringComparer.OrdinalIgnoreCase).Count());
        Assert.All(tables, t =>
        {
            Assert.NotEmpty(t.Description);
            Assert.Equal(
                [
                    new ArgColumn("id", "string"), new("name", "string"), new("type", "string"), new("tenantId", "string"),
                    new("kind", "string"), new("location", "string"), new("resourceGroup", "string"), new("subscriptionId", "string"),
                    new("managedBy", "string"), new("sku", "dynamic"), new("plan", "dynamic"), new("properties", "dynamic"),
                    new("tags", "dynamic"), new("identity", "dynamic"), new("zones", "dynamic"), new("extendedLocation", "dynamic"),
                ],
                t.Columns);
        });
        Assert.Equal(new DateTimeOffset(2026, 10, 21, 0, 0, 0, TimeSpan.Zero), BuiltInArgSchema.DocumentedAt);
    }
}
