using System.Text;
using Kustodian.Graph.Schema;

namespace Kustodian.Graph.Tests;

public sealed class GraphSchemaJsonTests
{
    private static GraphSchema ReadBack(string text) => GraphSchemaJson.Read(new MemoryStream(Encoding.UTF8.GetBytes(text)));

    [Fact]
    public void Write_is_deterministic()
    {
        var schema = TestSchemas.Fixture();

        var first = GraphSchemaJson.Write(schema);
        var second = GraphSchemaJson.Write(schema);

        Assert.Equal(first, second);
        Assert.DoesNotContain('\r', first);
        Assert.StartsWith("{\n  \"source\": \"test\",\n  \"generatedAt\": \"1970-01-01T00:00:00+00:00\",\n  \"tables\": [\n", first);
    }

    [Fact]
    public void Tables_are_sorted_columns_keep_csdl_order_and_empty_values_are_omitted()
    {
        var schema = TestSchemas.Fixture();
        var reversed = schema with { Tables = schema.Tables.Reverse().ToList() };

        var text = GraphSchemaJson.Write(reversed);
        var read = ReadBack(text);

        Assert.Equal(["applications", "security_incidents"], read.Tables.Select(t => t.Name).ToArray());
        Assert.Equal(["id", "deletedDateTime"], read.Find("applications")!.Columns.Take(2).Select(c => c.Name).ToArray());

        var start = text.IndexOf("\"name\": \"createdDateTime\"", StringComparison.Ordinal);
        Assert.True(start >= 0);
        var created = text[start..];
        created = created[..created.IndexOf('}', StringComparison.Ordinal)];
        Assert.DoesNotContain("\"filter\"", created);
        Assert.DoesNotContain("\"complexType\"", created);
        Assert.Contains("\"selectOnly\": false", created);
    }

    [Fact]
    public void Round_trips()
    {
        var schema = TestSchemas.Fixture();

        var read = ReadBack(GraphSchemaJson.Write(schema));

        Assert.Equal(schema.Source, read.Source);
        Assert.Equal(schema.GeneratedAt, read.GeneratedAt);
        Assert.Equal(schema.Tables.Count, read.Tables.Count);
        foreach (var (expected, actual) in schema.Tables.OrderBy(t => t.Name, StringComparer.Ordinal).Zip(read.Tables))
        {
            Assert.Equal((expected.Name, expected.Path, expected.EntityType, expected.Description, expected.DocsUrl, expected.DirectoryObject),
                (actual.Name, actual.Path, actual.EntityType, actual.Description, actual.DocsUrl, actual.DirectoryObject));
            Assert.Equal(expected.Columns.Count, actual.Columns.Count);
            foreach (var (c, d) in expected.Columns.Zip(actual.Columns))
            {
                Assert.Equal((c.Name, c.Type, c.Description, c.SelectOnly, c.ComplexType, c.Collection, c.Listable),
                    (d.Name, d.Type, d.Description, d.SelectOnly, d.ComplexType, d.Collection, d.Listable));
                Assert.Equal(c.Filter, d.Filter);
            }
        }

        Assert.Equal(schema.ComplexTypes.Keys.Order(StringComparer.Ordinal), read.ComplexTypes.Keys);
        foreach (var (name, fields) in schema.ComplexTypes)
            Assert.Equal(fields, read.ComplexTypes[name]);
    }

    [Fact]
    public void Collection_is_written_only_when_true()
    {
        var text = GraphSchemaJson.Write(TestSchemas.Fixture());

        string ColumnText(string name)
        {
            var start = text.IndexOf($"\"name\": \"{name}\"", StringComparison.Ordinal);
            var rest = text[start..];
            return rest[..rest.IndexOf('}', StringComparison.Ordinal)];
        }

        Assert.Contains("\"collection\": true", ColumnText("passwordCredentials"));
        Assert.DoesNotContain("\"collection\"", ColumnText("onPremisesPublishing"));
        Assert.True(ReadBack(text).Find("applications")!.Columns.Single(c => c.Name == "passwordCredentials").Collection);
    }

    [Fact]
    public void Listable_is_written_only_when_false()
    {
        var text = GraphSchemaJson.Write(TestSchemas.Fixture());

        string ColumnText(string name)
        {
            var start = text.IndexOf($"\"name\": \"{name}\"", StringComparison.Ordinal);
            var rest = text[start..];
            return rest[..rest.IndexOf('}', StringComparison.Ordinal)];
        }

        Assert.Contains("\"listable\": false", ColumnText("getOnlyById"));
        Assert.DoesNotContain("\"listable\"", ColumnText("appId"));
        Assert.False(ReadBack(text).Find("applications")!.Columns.Single(c => c.Name == "getOnlyById").Listable);
        Assert.True(ReadBack(text).Find("applications")!.Columns.Single(c => c.Name == "appId").Listable);
    }

    [Fact]
    public void Directory_object_is_written_only_when_true()
    {
        var text = GraphSchemaJson.Write(TestSchemas.Fixture());

        string TableText(string name)
        {
            var start = text.IndexOf($"\"name\": \"{name}\"", StringComparison.Ordinal);
            var rest = text[start..];
            return rest[..rest.IndexOf("\"columns\"", StringComparison.Ordinal)];
        }

        Assert.Contains("\"directoryObject\": true", TableText("applications"));
        Assert.DoesNotContain("\"directoryObject\"", TableText("security_incidents"));
        Assert.True(ReadBack(text).Find("applications")!.DirectoryObject);
        Assert.False(ReadBack(text).Find("security_incidents")!.DirectoryObject);
    }

    [Fact]
    public void Relationship_columns_round_trip()
    {
        var column = new GraphColumn("memberOf", "dynamic", "d", [], false, "kustodian.directoryObjectRef", Collection: true, Listable: false)
        {
            Relationship = true,
            Permissions = ["GroupMember.Read.All", "Directory.Read.All"],
        };
        var schema = TestSchemas.Fixture();
        var table = schema.Tables[0];
        schema = schema with { Tables = [table with { Columns = [.. table.Columns, column] }, .. schema.Tables.Skip(1)] };

        var read = ReadBack(GraphSchemaJson.Write(schema));

        var back = read.Find(table.Name)!.Columns.Single(c => c.Name == "memberOf");
        Assert.True(back.Relationship);
        Assert.Equal(["GroupMember.Read.All", "Directory.Read.All"], back.Permissions.ToArray());
    }

    [Fact]
    public void Plain_columns_write_no_relationship_keys()
    {
        var schema = TestSchemas.Plain();
        // Tables carry their own "permissions"; only the columns are under test.
        var text = GraphSchemaJson.Write(schema with { Tables = schema.Tables.Select(t => t with { Permissions = [] }).ToList() });

        Assert.DoesNotContain("\"relationship\"", text);
        Assert.DoesNotContain("\"permissions\"", text);
    }
}
