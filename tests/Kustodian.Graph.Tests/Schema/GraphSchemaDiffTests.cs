using Kustodian.Graph.Schema;

namespace Kustodian.Graph.Tests;

public sealed class GraphSchemaDiffTests
{
    private static GraphColumn Col(string name, string type, string description = "") => new(name, type, description, [], false, null);

    private static GraphTable Table(string name, params GraphColumn[] columns) =>
        new(name, name, "microsoft.graph." + name, "", "", columns);

    private static GraphSchema Schema(params GraphTable[] tables) =>
        new("test", DateTimeOffset.UnixEpoch, tables, new Dictionary<string, IReadOnlyList<GraphField>>());

    [Fact]
    public void Diff_reports_tables_columns_and_types()
    {
        var before = Schema(
            Table("applications", Col("createdDateTime", "datetime"), Col("appId", "string", "old")),
            Table("programs", Col("id", "string")));
        var after = Schema(
            Table("applications", Col("createdDateTime", "string"), Col("appId", "string", "new"), Col("tags", "dynamic")),
            Table("users", Col("id", "string")));

        var diff = GraphSchemaDiff.Compare(before, after);

        Assert.False(diff.IsEmpty);
        var lines = diff.ToSummary().Split('\n');
        Assert.Contains("+ table users", lines);
        Assert.Contains("- table programs", lines);
        Assert.Contains("applications: + column tags", lines);
        Assert.Contains("applications: createdDateTime datetime → string", lines);
        Assert.Contains("1 descriptions changed", lines);
    }

    [Fact]
    public void Description_changes_are_a_count()
    {
        var before = Schema(Table("a", Enumerable.Range(0, 12).Select(i => Col("c" + i, "string", "x")).ToArray()));
        var after = Schema(Table("a", Enumerable.Range(0, 12).Select(i => Col("c" + i, "string", "y")).ToArray()));

        Assert.Contains("12 descriptions changed", GraphSchemaDiff.Compare(before, after).ToSummary().Split('\n'));
    }

    private static GraphSchema Changed(Func<GraphTable, GraphTable> change)
    {
        var table = new GraphTable("applications", "applications", "microsoft.graph.application", "d", "https://docs/a",
            [Col("a", "string"), new GraphColumn("passwordCredentials", "dynamic", "", ["eq"], false, "microsoft.graph.x"), Col("b", "string")]);
        return Schema(change(table));
    }

    private static void AssertDetected(Func<GraphTable, GraphTable> change, string expectedLine)
    {
        var diff = GraphSchemaDiff.Compare(Changed(t => t), Changed(change));

        Assert.False(diff.IsEmpty);
        Assert.Contains(expectedLine, diff.ToSummary().Split('\n'));
    }

    [Fact]
    public void Column_complex_type_change_is_detected() => AssertDetected(
        t => t with { Columns = t.Columns.Select(c => c.Name == "passwordCredentials" ? c with { ComplexType = "microsoft.graph.y" } : c).ToList() },
        "applications: passwordCredentials complex type microsoft.graph.x → microsoft.graph.y");

    [Fact]
    public void Docs_url_change_is_detected() => AssertDetected(
        t => t with { DocsUrl = "https://docs/b" }, "applications: docs url https://docs/a → https://docs/b");

    [Fact]
    public void Column_reorder_is_detected() => AssertDetected(
        t => t with { Columns = t.Columns.Reverse().ToList() }, "applications: columns reordered");

    [Fact]
    public void Filter_change_is_detected() => AssertDetected(
        t => t with { Columns = t.Columns.Select(c => c.Name == "passwordCredentials" ? c with { Filter = ["eq", "ne"] } : c).ToList() },
        "applications: passwordCredentials filter [eq] → [eq, ne]");

    [Fact]
    public void Select_only_change_is_detected() => AssertDetected(
        t => t with { Columns = t.Columns.Select(c => c.Name == "a" ? c with { SelectOnly = true } : c).ToList() },
        "applications: a selectOnly False → True");

    [Fact]
    public void Complex_field_change_and_reorder_are_detected()
    {
        var fields = new GraphField[] { new("x", "string", false, null, ""), new("y", "string", false, null, "") };
        GraphSchema With(IReadOnlyList<GraphField> f) => Schema() with { ComplexTypes = new Dictionary<string, IReadOnlyList<GraphField>> { ["t"] = f } };

        var reordered = GraphSchemaDiff.Compare(With(fields), With([fields[1], fields[0]]));
        var retyped = GraphSchemaDiff.Compare(With(fields), With([fields[0], fields[1] with { Collection = true }]));

        Assert.Contains("t: fields reordered", reordered.ToSummary().Split('\n'));
        Assert.Contains("t: y string → collection of string", retyped.ToSummary().Split('\n'));
    }

    [Fact]
    public void Identical_schemas_are_empty()
    {
        var schema = TestSchemas.Fixture();

        var diff = GraphSchemaDiff.Compare(schema, schema with { GeneratedAt = DateTimeOffset.UtcNow, Source = "other" });

        Assert.True(diff.IsEmpty);
        Assert.Equal("No changes.", diff.ToSummary());
    }

    [Fact]
    public void Column_collection_change_is_detected() => AssertDetected(
        t => t with { Columns = t.Columns.Select(c => c.Name == "passwordCredentials" ? c with { Collection = true } : c).ToList() },
        "applications: passwordCredentials collection False → True");

    [Fact]
    public void Column_listable_change_is_detected() => AssertDetected(
        t => t with { Columns = t.Columns.Select(c => c.Name == "a" ? c with { Listable = false } : c).ToList() },
        "applications: a listable True → False");

    [Fact]
    public void Directory_object_change_is_detected() => AssertDetected(
        t => t with { DirectoryObject = true }, "applications: directoryObject False → True");

    [Fact]
    public void Reports_an_added_relationship_column()
    {
        var memberOf = new GraphColumn("memberOf", "dynamic", "d", [], false, "kustodian.directoryObjectRef", Collection: true, Listable: false)
        {
            Relationship = true,
            Permissions = ["GroupMember.Read.All", "Directory.Read.All"],
        };
        var before = Schema(Table("users", Col("id", "string")));
        var after = Schema(Table("users", Col("id", "string"), memberOf));

        var diff = GraphSchemaDiff.Compare(before, after);

        Assert.Contains("users: + column memberOf", diff.ToSummary().Split('\n'));
    }
}
