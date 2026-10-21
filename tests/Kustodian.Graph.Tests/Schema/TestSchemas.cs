using Kustodian.Graph.Schema;

namespace Kustodian.Graph.Tests;

internal static class TestSchemas
{
    public static GraphSchema Fixture()
    {
        using var stream = File.OpenRead(Path.Combine(AppContext.BaseDirectory, "Fixtures", "mini-metadata.xml"));
        using var permissions = File.OpenRead(Path.Combine(AppContext.BaseDirectory, "Schema", "permissions-excerpt.json"));
        return GraphSchemaBuilder.Build(GraphMetadata.Load(stream), GraphPermissions.ReadDelegated(permissions), "test",
            DateTimeOffset.UnixEpoch);
    }

    private static readonly Lazy<GraphSchema> WithServicePrincipalsSchema = new(() =>
    {
        var schema = Fixture();
        static GraphColumn Column(string name, string type) => new(name, type, "", ["eq"], false, null);
        var servicePrincipals = new GraphTable("servicePrincipals", "servicePrincipals", "microsoft.graph.servicePrincipal", "",
            "", [Column("id", "string"), Column("appId", "string"), Column("accountEnabled", "bool"),
                Column("displayName", "string"), Column("servicePrincipalType", "string")]);
        return schema with { Tables = [.. schema.Tables, servicePrincipals] };
    });

    /// <summary>The fixture plus a hand-built <c>servicePrincipals</c> table, for joins. One shared instance, since the
    /// planner's globals are cached per schema instance.</summary>
    public static GraphSchema WithServicePrincipals() => WithServicePrincipalsSchema.Value;
}
