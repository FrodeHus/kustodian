using System.Text;
using Kustodian.Graph.Schema;

namespace Kustodian.Graph.Tests;

public sealed class GraphPermissionsTests
{
    private static IReadOnlyDictionary<string, IReadOnlyList<string>> Excerpt()
    {
        using var stream = File.OpenRead(Path.Combine(AppContext.BaseDirectory, "Schema", "permissions-excerpt.json"));
        return GraphPermissions.ReadDelegated(stream);
    }

    private static IReadOnlyDictionary<string, IReadOnlyList<string>> Read(string json)
    {
        using var stream = new MemoryStream(Encoding.UTF8.GetBytes(json));
        return GraphPermissions.ReadDelegated(stream);
    }

    [Fact]
    public void ReadDelegated_returns_least_privileged_delegated_permissions_per_path()
    {
        var permissions = Excerpt();

        Assert.Equal(["Application.Read.All"], permissions["/applications"]);
        Assert.Equal(["User.ReadBasic.All"], permissions["/users"]);
        Assert.Equal(["AuditLog.Read.All"], permissions["/auditLogs/signIns"]);
    }

    [Fact]
    public void ReadDelegated_prefers_get_only_sets_over_read_write_ones_and_ignores_application_only_least()
    {
        // Application.ReadWrite.All is least-privileged (delegated) on /applications only for GET plus POST;
        // Application.ReadWrite.OwnedBy is application-only.
        var permissions = Excerpt();

        Assert.DoesNotContain("Application.ReadWrite.All", permissions["/applications"]);
        Assert.DoesNotContain("Application.ReadWrite.OwnedBy", permissions["/applications"]);
    }

    [Fact]
    public void ReadDelegated_falls_back_to_mixed_method_sets_when_no_get_only_set_lists_the_path()
    {
        var permissions = Read("""
            {"permissions":{
              "Only.ReadWrite":{"pathSets":[{"schemeKeys":["DelegatedWork"],"methods":["GET","POST"],
                "paths":{"/mixed":"least=DelegatedWork","/both":"least=DelegatedWork"}}]},
              "Both.Read":{"pathSets":[{"schemeKeys":["DelegatedWork"],"methods":["GET"],"paths":{"/both":"least=DelegatedWork"}}]},
              "Write.Only":{"pathSets":[{"schemeKeys":["DelegatedWork"],"methods":["POST"],"paths":{"/writeonly":"least=DelegatedWork"}}]}}}
            """);

        Assert.Equal(["Only.ReadWrite"], permissions["/mixed"]);
        Assert.Equal(["Both.Read"], permissions["/both"]);
        Assert.False(permissions.ContainsKey("/writeonly"));
    }

    [Fact]
    public void ReadDelegated_counts_only_the_DelegatedWork_scheme()
    {
        var permissions = Read("""
            {"permissions":{
              "Personal.Read":{"pathSets":[{"schemeKeys":["DelegatedPersonal"],"methods":["GET"],"paths":{"/p":"least=DelegatedPersonal"}}]},
              "Work.Read":{"pathSets":[{"schemeKeys":["DelegatedWork","DelegatedPersonal"],"methods":["GET"],
                "paths":{"/p":"least=DelegatedWork,DelegatedPersonal","/q":"least=DelegatedPersonal,Application"}}]}}}
            """);

        Assert.Equal(["Work.Read"], permissions["/p"]);
        Assert.False(permissions.ContainsKey("/q"));
    }

    [Fact]
    public void ReadDelegated_normalises_case_leading_slash_and_placeholders()
    {
        var permissions = Read("""
            {"permissions":{"Thing.Read":{"pathSets":[{"schemeKeys":["DelegatedWork"],"methods":["GET"],
              "paths":{"/Things/{thing-id}/Parts":"least=DelegatedWork"}}]}}}
            """);

        Assert.Equal(["Thing.Read"], permissions["/things/{}/parts"]);
        Assert.Equal(["Thing.Read"], permissions["/THINGS/{}/PARTS"]);
    }

    [Fact]
    public void ReadDelegated_collects_several_permissions_sorted_and_distinct()
    {
        var permissions = Read("""
            {"permissions":{
              "B.Read":{"pathSets":[{"schemeKeys":["DelegatedWork"],"methods":["GET"],"paths":{"/x":"least=DelegatedWork"}}]},
              "A.Read":{"pathSets":[{"schemeKeys":["DelegatedWork"],"methods":["GET"],"paths":{"/x":"least=DelegatedWork","/X":"least=DelegatedWork"}}]}}}
            """);

        Assert.Equal(["A.Read", "B.Read"], permissions["/x"]);
    }

    [Fact]
    public void Build_sets_table_permissions_from_path()
    {
        var schema = TestSchemas.Fixture();

        Assert.Equal(["Application.Read.All"], schema.Find("applications")!.Permissions);
        Assert.Empty(schema.Find("security_incidents")!.Permissions);
    }

    [Fact]
    public void Build_sets_known_column_permission()
    {
        var applications = TestSchemas.Fixture().Find("applications")!;

        Assert.Equal("Directory.ReadWrite.All", applications.Columns.Single(c => c.Name == "onPremisesPublishing").KnownPermission);
        Assert.All(applications.Columns.Where(c => c.Name != "onPremisesPublishing"), c => Assert.Null(c.KnownPermission));
    }

    [Fact]
    public void GraphSchemaJson_round_trips_permissions()
    {
        var schema = TestSchemas.Fixture();

        var json = GraphSchemaJson.Write(schema);
        var read = GraphSchemaJson.Read(new MemoryStream(Encoding.UTF8.GetBytes(json)));

        Assert.Equal(["Application.Read.All"], read.Find("applications")!.Permissions);
        Assert.Equal("Directory.ReadWrite.All",
            read.Find("applications")!.Columns.Single(c => c.Name == "onPremisesPublishing").KnownPermission);
        Assert.Equal(json, GraphSchemaJson.Write(read));
    }

    [Fact]
    public void GraphSchemaJson_omits_empty_permissions()
    {
        var json = GraphSchemaJson.Write(TestSchemas.Fixture());

        Assert.Equal(1, json.Split("\"permissions\"").Length - 1);
        Assert.Equal(1, json.Split("\"knownPermission\"").Length - 1);
    }

    [Fact]
    public void Diff_reports_permission_changes()
    {
        var before = TestSchemas.Fixture();
        var after = before with
        {
            Tables = [.. before.Tables.Select(t => t.Name == "applications" ? t with { Permissions = ["Directory.Read.All"] } : t)],
        };

        var diff = GraphSchemaDiff.Compare(before, after);

        Assert.False(diff.IsEmpty);
        Assert.Contains("applications: permissions [Application.Read.All] → [Directory.Read.All]", diff.ToSummary());
    }

    [Fact]
    public void Beta_catalog_has_no_me_tables_and_no_listable_stream_columns()
    {
        var schema = GraphSchemaCatalog.Beta;

        Assert.DoesNotContain(schema.Tables, t => t.Path.StartsWith("me/", StringComparison.Ordinal));
        Assert.Contains(schema.Tables, t => t.Permissions.Count > 0);
        // A stream column maps to "string" but is media on its own URL, so a list must not select it.
        var streamLike = schema.Tables.SelectMany(t => t.Columns).Where(c => c.Name is "logo" or "photo" && c.Type == "string");
        Assert.All(streamLike, c => Assert.False(c.Listable));
    }
}
