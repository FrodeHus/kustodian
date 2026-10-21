using Kustodian.Graph.Schema;

namespace Kustodian.Graph.Tests;

public sealed class GraphSchemaBuilderTests
{
    private static GraphSchema Build() => TestSchemas.Fixture();

    private static GraphColumn Column(string name) => Build().Find("applications")!.Columns.Single(c => c.Name == name);

    [Fact]
    public void Entity_sets_and_singleton_collections_become_tables()
    {
        var schema = Build();

        Assert.Equal(["applications", "security_incidents"], schema.Tables.Select(t => t.Name).Order().ToArray());
        Assert.Equal("security/incidents", schema.Find("security_incidents")!.Path);
    }

    [Fact]
    public void The_me_singletons_collections_are_left_out()
    {
        // me is the signed-in user: delegated only, never there for an application token.
        var schema = Build();

        Assert.DoesNotContain(schema.Tables, t => t.Path.StartsWith("me/", StringComparison.Ordinal));
        Assert.Null(schema.Find("me_incidents"));
    }

    [Fact]
    public void Columns_only_returned_on_a_single_object_get_are_not_listable()
    {
        Assert.False(Column("getOnlyGroup").Listable);
        Assert.False(Column("getOnlyById").Listable);
        Assert.True(Column("signInActivity").Listable);   // $select only, but listable
        Assert.True(Column("appId").Listable);
    }

    // A stream (application.logo) is media, not a value: selecting it in a list makes Graph answer 404 with a web page.
    [Fact]
    public void Stream_columns_are_not_listable()
    {
        Assert.False(Column("logo").Listable);
        Assert.Equal("string", Column("logo").Type);
    }

    // Microsoft Learn's List users: these "are only supported when retrieving a single user", and the metadata doesn't say
    // so. Selected in a list, Graph refuses the whole list (in a tenant without SharePoint Online, "Tenant does not have a
    // SPO license").
    public static readonly string[] UsersGetOnlyColumns =
    [
        "aboutMe", "birthday", "hireDate", "interests", "mySite", "pastProjects", "preferredName", "responsibilities", "schools",
        "skills", "mailboxSettings",
    ];

    public static TheoryData<string> UsersGetOnly => new(UsersGetOnlyColumns);

    [Theory]
    [MemberData(nameof(UsersGetOnly))]
    public void Users_columns_only_returned_on_a_single_user_get_are_not_listable(string column)
    {
        const string csdl = """
            <?xml version="1.0" encoding="utf-8"?>
            <edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
              <edmx:DataServices>
                <Schema Namespace="microsoft.graph" Alias="graph" xmlns="http://docs.oasis-open.org/odata/ns/edm">
                  <EntityType Name="user">
                    <Key><PropertyRef Name="id" /></Key>
                    <Property Name="id" Type="Edm.String" Nullable="false" />
                    <Property Name="displayName" Type="Edm.String" />
                    <Property Name="{0}" Type="Edm.String" />
                  </EntityType>
                  <EntityContainer Name="GraphService">
                    <EntitySet Name="users" EntityType="graph.user" />
                  </EntityContainer>
                </Schema>
              </edmx:DataServices>
            </edmx:Edmx>
            """;
        using var stream = new MemoryStream(System.Text.Encoding.UTF8.GetBytes(csdl.Replace("{0}", column, StringComparison.Ordinal)));
        var users = GraphSchemaBuilder.Build(GraphMetadata.Load(stream), new Dictionary<string, IReadOnlyList<string>>(), "test",
            DateTimeOffset.UnixEpoch).Find("users")!;

        Assert.False(users.Columns.Single(c => c.Name == column).Listable);
        Assert.True(users.Columns.Single(c => c.Name == "displayName").Listable);
    }

    [Theory]
    [MemberData(nameof(UsersGetOnly))]
    public void The_embedded_schema_marks_users_get_only_columns_not_listable(string column)
        => Assert.False(GraphSchemaCatalog.Beta.Find("users")!.Columns.Single(c => c.Name == column).Listable);

    // Learn's group resource: "Supported only on the Get group API", which these two's beta descriptions leave out.
    [Theory]
    [InlineData("unseenConversationsCount")]
    [InlineData("unseenMessagesCount")]
    public void The_embedded_schema_marks_groups_unseen_counters_not_listable(string column)
    {
        Assert.Contains(("groups", column), GraphSchemaBuilder.KnownGetOnly);
        Assert.False(GraphSchemaCatalog.Beta.Find("groups")!.Columns.Single(c => c.Name == column).Listable);
    }

    // Both are served in a list (Learn's List users lists them with $select); without a license or role Graph refuses the
    // list (signInActivity, left to the license fallback) or returns null (customSecurityAttributes).
    [Theory]
    [InlineData("signInActivity")]
    [InlineData("customSecurityAttributes")]
    public void Users_license_or_role_gated_columns_stay_listable(string column)
        => Assert.True(GraphSchemaCatalog.Beta.Find("users")!.Columns.Single(c => c.Name == column).Listable);

    [Fact]
    public void Directory_object_tables_are_marked_through_the_base_chain()
    {
        var schema = Build();

        Assert.True(schema.Find("applications")!.DirectoryObject);
        Assert.False(schema.Find("security_incidents")!.DirectoryObject);
    }

    [Fact]
    public void Inherited_properties_come_first()
    {
        var columns = Build().Find("applications")!.Columns.Select(c => c.Name).ToArray();

        Assert.Equal(["id", "deletedDateTime"], columns.Take(2).ToArray());
        Assert.DoesNotContain("owners", columns);
    }

    [Fact]
    public void Types_map_as_the_spec_says()
    {
        Assert.Equal("datetime", Column("createdDateTime").Type);
        Assert.Equal("dynamic", Column("passwordCredentials").Type);
        Assert.Equal("microsoft.graph.passwordCredential", Column("passwordCredentials").ComplexType);
        Assert.Equal("dynamic", Column("onPremisesPublishing").Type);
        Assert.Equal("string", Column("appId").Type);

        var enumField = Build().ComplexTypes["microsoft.graph.onPremisesPublishing"].Single();
        Assert.Equal("string", enumField.Type);
        Assert.Null(enumField.ComplexType);
    }

    [Fact]
    public void Filter_operators_and_select_only_come_from_descriptions()
    {
        Assert.Equal(["eq", "ne", "not", "ge", "le", "in", "startsWith"], Column("displayName").Filter);
        Assert.Equal(["eq"], Column("appId").Filter);
        Assert.Empty(Column("createdDateTime").Filter);
        Assert.True(Column("signInActivity").SelectOnly);
        Assert.False(Column("appId").SelectOnly);
    }

    [Fact]
    public void Complex_types_are_kept_once_and_recursion_terminates()
    {
        var complex = Build().ComplexTypes;

        Assert.Single(complex.Keys, k => k == "microsoft.graph.node");
        var children = complex["microsoft.graph.node"].Single(f => f.Name == "children");
        Assert.True(children.Collection);
        Assert.Equal("microsoft.graph.node", children.ComplexType);
        Assert.DoesNotContain("microsoft.graph.unreachable", complex.Keys);
    }

    [Fact]
    public void Docs_url_names_the_entity_type()
    {
        Assert.Equal("https://learn.microsoft.com/graph/api/resources/application?view=graph-rest-beta",
            Build().Find("applications")!.DocsUrl);
    }

    [Fact]
    public void Filter_operators_are_read_from_the_real_phrasings()
    {
        Assert.Equal(["eq"], Column("eqOnly").Filter);
        Assert.Equal(["eq", "ne", "not", "in"], Column("withNullClause").Filter);
        Assert.Equal(["eq"], Column("withUnknown").Filter);
        Assert.Equal(["eq"], Column("operatorEq").Filter);
        Assert.Equal(["lt"], Column("operatorLt").Filter);
    }

    [Fact]
    public void Descriptions_come_from_annotations_blocks_through_aliases()
    {
        var text = Build().ComplexTypes["microsoft.graph.security.note"].Single();

        Assert.Equal("The note body.", text.Description);
    }

    [Fact]
    public void Collection_columns_are_marked()
    {
        Assert.True(Column("passwordCredentials").Collection);
        Assert.False(Column("onPremisesPublishing").Collection);
        Assert.False(Column("appId").Collection);
    }
}
