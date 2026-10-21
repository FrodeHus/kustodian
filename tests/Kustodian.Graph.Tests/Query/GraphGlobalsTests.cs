using Kustodian.Graph.Query;
using Kusto.Language.Symbols;

namespace Kustodian.Graph.Tests;

public sealed class GraphGlobalsTests
{
    private static TypeSymbol ColumnType(Kusto.Language.GlobalState globals, string column) =>
        globals.Database.GetTable("applications").GetColumn(column).Type;

    private static TypeSymbol Member(TypeSymbol bag, string name) =>
        Assert.IsType<DynamicBagSymbol>(bag).Properties.Single(p => p.Name == name).Type;

    [Fact]
    public void Plain_columns_have_their_kusto_type()
    {
        var globals = GraphGlobals.Plain(TestSchemas.WithServicePrincipals());

        Assert.Same(ScalarTypes.DateTime, ColumnType(globals, "createdDateTime"));
        Assert.Same(ScalarTypes.Dynamic, ColumnType(globals, "onPremisesPublishing"));
        Assert.Same(ScalarTypes.Bool, globals.Database.GetTable("servicePrincipals").GetColumn("accountEnabled").Type);
    }

    [Fact]
    public void Typed_columns_know_the_fields_of_complex_values()
    {
        var globals = GraphGlobals.Typed(TestSchemas.WithServicePrincipals());

        Assert.Same(ScalarTypes.String, Member(ColumnType(globals, "onPremisesPublishing"), "externalAuthenticationType"));
        Assert.Same(ScalarTypes.String, Member(ColumnType(globals, "note"), "text"));
        Assert.Same(ScalarTypes.DateTime, ColumnType(globals, "createdDateTime"));
    }

    [Fact]
    public void Typed_fields_stop_at_the_depth()
    {
        var globals = GraphGlobals.Typed(TestSchemas.WithServicePrincipals(), depth: 2);

        // tree (level 1) -> children[] of node (level 2) -> children below that is plain dynamic.
        var children = Assert.IsType<DynamicArraySymbol>(Member(ColumnType(globals, "tree"), "children"));
        Assert.Same(ScalarTypes.String, Member(children.ElementType, "name"));
        Assert.Same(ScalarTypes.Dynamic, Assert.IsType<DynamicArraySymbol>(Member(children.ElementType, "children")).ElementType);
    }

    [Fact]
    public void Globals_are_built_once_per_schema()
    {
        var schema = TestSchemas.WithServicePrincipals();

        Assert.Same(GraphGlobals.Plain(schema), GraphGlobals.Plain(schema));
        Assert.Same(GraphGlobals.Typed(schema), GraphGlobals.Typed(schema));
        Assert.NotSame(GraphGlobals.Typed(schema), GraphGlobals.Typed(schema, depth: 1));
    }

    [Fact]
    public void Typed_collection_columns_are_arrays()
    {
        var globals = GraphGlobals.Typed(TestSchemas.WithServicePrincipals());

        var credentials = Assert.IsType<DynamicArraySymbol>(ColumnType(globals, "passwordCredentials"));
        Assert.Same(ScalarTypes.DateTime, Member(credentials.ElementType, "endDateTime"));
        Assert.IsType<DynamicBagSymbol>(ColumnType(globals, "onPremisesPublishing"));
    }

    [Fact]
    public void Completion_inside_an_expanded_collection_offers_its_fields()
    {
        const string kql = "applications | mv-expand c = passwordCredentials | where c.";
        var code = Kusto.Language.KustoCode.ParseAndAnalyze(kql, GraphGlobals.Typed(TestSchemas.WithServicePrincipals()));

        var items = new Kusto.Language.Editor.KustoCodeService(code).GetCompletionItems(kql.Length);

        Assert.Contains(items.Items, i => i.DisplayText == "endDateTime");
    }

    [Fact]
    public void Typed_collections_of_primitives_are_arrays()
    {
        var schema = TestSchemas.WithServicePrincipals();
        var extra = schema.Find("applications")! with { Name = "extras", Columns = [new("tags", "dynamic", "", [], false, null, Collection: true)] };
        var globals = GraphGlobals.Typed(schema with { Tables = [.. schema.Tables, extra] });

        Assert.IsType<DynamicArraySymbol>(globals.Database.GetTable("extras").GetColumn("tags").Type);
    }
}
