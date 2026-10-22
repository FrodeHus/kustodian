using Kustodian.Graph.Schema;

namespace Kustodian.Graph.Tests;

internal static class TestSchemas
{
    private static readonly IReadOnlyDictionary<string, IReadOnlyList<string>> NoRelationships =
        new Dictionary<string, IReadOnlyList<string>>();

    /// <summary>The fixture with <c>applications.owners</c> and <c>primaryOwner</c> as relationship columns.</summary>
    public static GraphSchema Fixture() => Build(new Dictionary<string, IReadOnlyList<string>> { ["applications"] = ["owners", "primaryOwner"] });

    /// <summary>The fixture with no relationship columns: just the properties the metadata declares.</summary>
    public static GraphSchema Plain() => Build(NoRelationships);

    private static GraphSchema Build(IReadOnlyDictionary<string, IReadOnlyList<string>> relationships)
    {
        using var stream = File.OpenRead(Path.Combine(AppContext.BaseDirectory, "Fixtures", "mini-metadata.xml"));
        using var permissions = File.OpenRead(Path.Combine(AppContext.BaseDirectory, "Schema", "permissions-excerpt.json"));
        return GraphSchemaBuilder.Build(GraphMetadata.Load(stream), GraphPermissions.ReadDelegated(permissions), relationships, "test",
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
