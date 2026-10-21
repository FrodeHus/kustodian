using System.Text;
using Kustodian.Graph.Schema;

namespace Kustodian.Graph.Tests;

public sealed class GraphPermissionCatalogTests
{
    private static GraphTable Table(string path) => new(path.Split('/')[^1], path, "microsoft.graph.x", "", "", []);

    private static readonly GraphTable[] Tables = [Table("users"), Table("applications"), Table("auditLogs/signIns")];

    private static GraphPermissionCatalog BuildExcerpt()
    {
        using var stream = File.OpenRead(Path.Combine(AppContext.BaseDirectory, "Schema", "permissions-excerpt.json"));
        return GraphPermissionCatalog.Build(stream, Tables, "test");
    }

    private static CatalogPermission Find(GraphPermissionCatalog catalog, string name) => catalog.Permissions.Single(p => p.Name == name);

    [Fact]
    public void Build_lists_every_permission_that_can_read_a_table()
    {
        var catalog = BuildExcerpt();

        Assert.Equal("test", catalog.Source);
        Assert.Equal(["applications", "users"], Find(catalog, "Directory.Read.All").Tables);
        Assert.Contains("users", Find(catalog, "User.ReadBasic.All").Tables);
        Assert.Contains("auditLogs/signIns", Find(catalog, "AuditLog.Read.All").Tables);
        Assert.Equal(catalog.Permissions.Select(p => p.Name).Order(StringComparer.Ordinal), catalog.Permissions.Select(p => p.Name));
    }

    [Fact]
    public void Build_takes_admin_consent_and_description_from_DelegatedWork()
    {
        var directory = Find(BuildExcerpt(), "Directory.Read.All");

        Assert.True(directory.AdminConsent);
        Assert.Equal("Allows the app to read data in your organization's directory.", directory.Description);
    }

    [Fact]
    public void Build_ignores_permissions_without_DelegatedWork_or_GET()
    {
        const string json = """
            {"permissions": {
              "App.Only": {"schemes": {"Application": {}}, "pathSets": [
                {"schemeKeys": ["Application"], "methods": ["GET"], "paths": {"/users": ""}}]},
              "Post.Only": {"schemes": {"DelegatedWork": {}}, "pathSets": [
                {"schemeKeys": ["DelegatedWork"], "methods": ["POST"], "paths": {"/users": ""}}]},
              "Reads.Users": {"schemes": {"DelegatedWork": {}}, "pathSets": [
                {"schemeKeys": ["DelegatedWork"], "methods": ["GET"], "paths": {"/users": ""}}]}
            }}
            """;
        using var stream = new MemoryStream(Encoding.UTF8.GetBytes(json));

        var catalog = GraphPermissionCatalog.Build(stream, Tables, "test");

        Assert.Equal(["Reads.Users"], catalog.Permissions.Select(p => p.Name));
        Assert.False(catalog.Permissions[0].AdminConsent);
        Assert.Equal("", catalog.Permissions[0].Description);
    }

    [Fact]
    public void Write_then_Read_round_trips()
    {
        var catalog = BuildExcerpt();

        var json = GraphPermissionCatalog.Write(catalog);
        using var stream = new MemoryStream(Encoding.UTF8.GetBytes(json));
        var read = GraphPermissionCatalog.Read(stream);

        Assert.Equal(catalog.Source, read.Source);
        Assert.Equal(catalog.Permissions.Count, read.Permissions.Count);
        foreach (var (expected, actual) in catalog.Permissions.Zip(read.Permissions))
        {
            Assert.Equal(expected.Name, actual.Name);
            Assert.Equal(expected.AdminConsent, actual.AdminConsent);
            Assert.Equal(expected.Description, actual.Description);
            Assert.Equal(expected.Tables, actual.Tables);
        }

        Assert.Equal(json, GraphPermissionCatalog.Write(read));
    }

    [Fact]
    public void Bundled_loads()
    {
        var directory = GraphPermissionCatalog.Bundled.Permissions.Single(p => p.Name == "Directory.Read.All");

        Assert.Contains("users", directory.Tables);
    }
}
