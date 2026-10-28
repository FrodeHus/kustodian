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
        Assert.DoesNotContain(paths, p => p.StartsWith("reports/related/", StringComparison.Ordinal));
        Assert.DoesNotContain(paths, p => p.StartsWith("cycle/", StringComparison.Ordinal));
    }

    [Fact]
    public void A_path_through_a_me_segment_is_not_a_table()
    {
        var schema = GraphSchemaBuilder.Build(Load(), new Dictionary<string, IReadOnlyList<string>>(), "test", DateTimeOffset.UnixEpoch);

        Assert.NotNull(schema.Find("reports_authenticationMethods_userRegistrationDetails"));
        Assert.Null(schema.Find("education_me_userRegistrationDetails"));
    }
}
