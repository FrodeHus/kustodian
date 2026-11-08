using System.Text;
using Kustodian.Graph.Schema;

namespace Kustodian.Graph.Tests;

public sealed class GraphMetadataTests
{
    // reports/authenticationMethods/userRegistrationDetails: a collection under a single-valued contained navigation.
    private const string Csdl = """
        <?xml version="1.0" encoding="utf-8"?>
        <edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
          <edmx:DataServices>
            <Schema Namespace="microsoft.graph" Alias="graph" xmlns="http://docs.oasis-open.org/odata/ns/edm">
              <EntityType Name="entity" Abstract="true">
                <Key><PropertyRef Name="id" /></Key>
                <Property Name="id" Type="Edm.String" Nullable="false" />
              </EntityType>
              <EntityType Name="userRegistrationDetails" BaseType="graph.entity">
                <Property Name="methodsRegistered" Type="Collection(Edm.String)" />
              </EntityType>
              <EntityType Name="authenticationMethodsRoot" BaseType="graph.entity">
                <NavigationProperty Name="userRegistrationDetails" Type="Collection(graph.userRegistrationDetails)" ContainsTarget="true" />
                <NavigationProperty Name="deep" Type="graph.deepRoot" ContainsTarget="true" />
              </EntityType>
              <EntityType Name="deepRoot" BaseType="graph.entity">
                <NavigationProperty Name="items" Type="Collection(graph.userRegistrationDetails)" ContainsTarget="true" />
              </EntityType>
              <EntityType Name="reportRoot" BaseType="graph.entity">
                <NavigationProperty Name="authenticationMethods" Type="graph.authenticationMethodsRoot" ContainsTarget="true" />
                <NavigationProperty Name="related" Type="graph.authenticationMethodsRoot" />
              </EntityType>
              <EntityType Name="cycle" BaseType="graph.entity">
                <NavigationProperty Name="self" Type="graph.cycle" ContainsTarget="true" />
              </EntityType>
              <EntityType Name="educationRoot" BaseType="graph.entity">
                <NavigationProperty Name="me" Type="graph.authenticationMethodsRoot" ContainsTarget="true" />
              </EntityType>
              <EntityContainer Name="GraphService">
                <Singleton Name="reports" Type="graph.reportRoot" />
                <Singleton Name="cycle" Type="graph.cycle" />
                <Singleton Name="education" Type="graph.educationRoot" />
              </EntityContainer>
            </Schema>
          </edmx:DataServices>
        </edmx:Edmx>
        """;

    private static GraphMetadata Load() => GraphMetadata.Load(new MemoryStream(Encoding.UTF8.GetBytes(Csdl)));

    [Fact]
    public void Collections_under_a_single_valued_contained_navigation_are_listed()
    {
        var collection = Assert.Single(Load().Collections, c => c.Path == "reports/authenticationMethods/userRegistrationDetails");

        Assert.Equal("microsoft.graph.userRegistrationDetails", collection.EntityType);
    }

    [Fact]
    public void Only_one_single_valued_navigation_deep_and_only_contained_ones()
    {
        var paths = Load().Collections.Select(c => c.Path).ToList();

        Assert.DoesNotContain("reports/authenticationMethods/deep/items", paths);
        // The single object at the second hop is listed, but nothing under it.
        Assert.Contains("reports/authenticationMethods/deep", paths);
        Assert.DoesNotContain(paths, p => p.StartsWith("reports/related/", StringComparison.Ordinal));
        Assert.DoesNotContain(paths, p => p.StartsWith("cycle/self/", StringComparison.Ordinal));
    }

    [Fact]
    public void Singletons_and_single_valued_contained_navigations_are_single_objects()
    {
        var collections = Load().Collections;

        var nav = Assert.Single(collections, c => c.Path == "reports/authenticationMethods");
        Assert.True(nav.Single);
        Assert.Equal("microsoft.graph.authenticationMethodsRoot", nav.EntityType);
        Assert.True(Assert.Single(collections, c => c.Path == "reports").Single);
        Assert.False(Assert.Single(collections, c => c.Path == "reports/authenticationMethods/userRegistrationDetails").Single);
        // Not contained: not under the singleton's path.
        Assert.DoesNotContain(collections, c => c.Path == "reports/related");
    }

    [Fact]
    public void A_single_object_is_a_table_only_with_a_permission_to_read_it()
    {
        var permissions = new Dictionary<string, IReadOnlyList<string>>(StringComparer.OrdinalIgnoreCase)
        {
            [GraphPermissions.NormalizePath("/reports/authenticationMethods")] = ["AuditLog.Read.All"],
        };
        var schema = GraphSchemaBuilder.Build(Load(), permissions, "test", DateTimeOffset.UnixEpoch);

        var table = Assert.IsType<GraphTable>(schema.Find("reports_authenticationMethods"));
        Assert.True(table.Single);
        Assert.Equal(["AuditLog.Read.All"], table.Permissions);
        Assert.Equal(["id"], table.Columns.Select(c => c.Name));
        Assert.Null(schema.Find("reports"));
        Assert.False(schema.Find("reports_authenticationMethods_userRegistrationDetails")!.Single);
    }

    [Fact]
    public void A_path_through_a_me_segment_is_not_a_table()
    {
        var schema = GraphSchemaBuilder.Build(Load(), new Dictionary<string, IReadOnlyList<string>>(), "test", DateTimeOffset.UnixEpoch);

        Assert.NotNull(schema.Find("reports_authenticationMethods_userRegistrationDetails"));
        Assert.Null(schema.Find("education_me_userRegistrationDetails"));
    }

    // GET /me reads the signed-in user (every sign-in is delegated); the collections under it repeat other tables.
    [Fact]
    public void The_me_singleton_is_a_single_object_table_and_its_collections_are_not()
    {
        var schema = GraphSchemaCatalog.Beta;

        var me = Assert.IsType<GraphTable>(schema.Find("me"));
        Assert.True(me.Single);
        Assert.Equal("microsoft.graph.user", me.EntityType);
        Assert.NotEmpty(me.Permissions);
        // A single GET, so the columns a list of users never returns are read here.
        Assert.All(GraphSchemaBuilder.KnownGetOnly.Where(k => k.Table == "users"),
            k => Assert.True(me.Columns.Single(c => c.Name == k.Column).Listable));
        Assert.DoesNotContain(schema.Tables, t => t.Path.StartsWith("me/", StringComparison.Ordinal) || t.Path.Contains("/me/", StringComparison.Ordinal));
    }

    [Fact]
    public void Secret_columns_are_left_out_of_the_bundled_schema()
    {
        foreach (var (table, column) in GraphSchemaBuilder.SecretColumns)
        {
            var found = Assert.IsType<GraphTable>(GraphSchemaCatalog.Beta.Find(table));
            Assert.DoesNotContain(found.Columns, c => c.Name == column);
        }
        // The rest of the object stays.
        Assert.Contains(GraphSchemaCatalog.Beta.Find("deviceManagement_applePushNotificationCertificate")!.Columns,
            c => c.Name == "expirationDateTime");
    }
}
