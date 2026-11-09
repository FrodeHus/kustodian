using System.Net;
using System.Text;
using System.Text.Json;
using Kustodian.App;
using Kustodian.Graph.Schema;
using Microsoft.Extensions.Time.Testing;

namespace Kustodian.Tests.App;

public sealed class GraphSchemaUpdatesTests : IDisposable
{
    private static readonly string Folder = Path.Combine(FindRoot(), "GraphSchema");
    private static readonly ActiveGraphSchema BuiltIn = new(GraphSchemaCatalog.Beta, GraphPermissionCatalog.Bundled, false);
    private readonly string _root = Path.Combine(Path.GetTempPath(), "kustodian-tests-" + Guid.NewGuid().ToString("N"));

    public GraphSchemaUpdatesTests() => Directory.CreateDirectory(_root);

    public void Dispose()
    {
        if (Directory.Exists(_root))
            Directory.Delete(_root, recursive: true);
    }

    [Fact]
    public void The_committed_manifest_matches_the_committed_files()
    {
        var committed = GraphSchemaManifest.Read(File.ReadAllBytes(Path.Combine(Folder, GraphSchemaManifest.FileName)));

        Assert.Equal(GraphSchemaManifest.Describe(Folder).Write(), committed.Write());
        var (schema, permissions) = GraphSchemaUpdates.Parse(committed, name => File.ReadAllBytes(Path.Combine(Folder, name)));
        Assert.Equal(GraphSchemaCatalog.Beta.GeneratedAt, schema.GeneratedAt);
        Assert.Equal(GraphPermissionCatalog.Bundled.Permissions.Count, permissions.Permissions.Count);
    }

    [Fact]
    public async Task A_newer_schema_is_downloaded_and_used_at_the_next_start()
    {
        var published = Publish(GraphSchemaCatalog.Beta.GeneratedAt.AddDays(1));
        var updates = new GraphSchemaUpdates(Client(published), _root, BuiltIn, new FakeTimeProvider());

        var status = await updates.CheckAsync(force: false, CancellationToken.None);

        Assert.Equal(GraphSchemaCatalog.Beta.GeneratedAt.AddDays(1), status.Pending);
        Assert.False(status.Downloaded);
        var next = GraphSchemaUpdates.Load(_root);
        Assert.True(next.Downloaded);
        Assert.Equal(GraphSchemaCatalog.Beta.GeneratedAt.AddDays(1), next.Schema.GeneratedAt);
        Assert.Null(new GraphSchemaUpdates(Client(published), _root, next, new FakeTimeProvider()).Status().Pending);
    }

    [Fact]
    public async Task The_same_schema_is_not_downloaded_unless_forced()
    {
        var published = Publish(GraphSchemaCatalog.Beta.GeneratedAt);
        var updates = new GraphSchemaUpdates(Client(published), _root, BuiltIn, new FakeTimeProvider());

        Assert.Null((await updates.CheckAsync(force: false, CancellationToken.None)).Pending);
        Assert.False(Directory.Exists(Path.Combine(_root, GraphSchemaUpdates.DirectoryName)));

        Assert.Null((await updates.CheckAsync(force: true, CancellationToken.None)).Pending);
        Assert.True(File.Exists(Path.Combine(_root, GraphSchemaUpdates.DirectoryName, GraphSchemaManifest.SchemaFile)));
        Assert.False(GraphSchemaUpdates.Load(_root).Downloaded);
    }

    [Fact]
    public async Task A_file_that_does_not_match_the_manifest_is_not_kept()
    {
        var published = Publish(GraphSchemaCatalog.Beta.GeneratedAt.AddDays(1));
        published[GraphSchemaManifest.PermissionsFile] = [.. published[GraphSchemaManifest.PermissionsFile], (byte)' '];
        var updates = new GraphSchemaUpdates(Client(published), _root, BuiltIn, new FakeTimeProvider());

        await Assert.ThrowsAsync<GraphSchemaUpdateException>(() => updates.CheckAsync(force: false, CancellationToken.None));
        Assert.False(Directory.Exists(Path.Combine(_root, GraphSchemaUpdates.DirectoryName)));
        Assert.False(GraphSchemaUpdates.Load(_root).Downloaded);
    }

    [Fact]
    public async Task A_newer_format_is_left_for_a_newer_build()
    {
        var published = Publish(GraphSchemaCatalog.Beta.GeneratedAt.AddDays(1), GraphSchemaManifest.CurrentFormat + 1);
        var updates = new GraphSchemaUpdates(Client(published), _root, BuiltIn, new FakeTimeProvider());

        Assert.Null((await updates.CheckAsync(force: true, CancellationToken.None)).Pending);
        Assert.False(Directory.Exists(Path.Combine(_root, GraphSchemaUpdates.DirectoryName)));
    }

    [Fact]
    public void A_damaged_copy_falls_back_to_the_built_in_schema()
    {
        var dir = Path.Combine(_root, GraphSchemaUpdates.DirectoryName);
        Directory.CreateDirectory(dir);
        File.WriteAllText(Path.Combine(dir, GraphSchemaManifest.FileName), "{ not json");

        Assert.False(GraphSchemaUpdates.Load(_root).Downloaded);
    }

    [Theory]
    [InlineData("users", true)]
    [InlineData("admin/cloudLicensing/allotments", true)]
    [InlineData("https://evil.example/x", false)]
    [InlineData("//evil.example/x", false)]
    [InlineData("/users", false)]
    [InlineData("users/../../v1.0/me", false)]
    [InlineData("users?$top=1", false)]
    [InlineData("users#x", false)]
    [InlineData("", false)]
    public void Only_relative_graph_paths_are_accepted(string path, bool ok) =>
        Assert.Equal(ok, GraphSchemaUpdates.IsGraphPath(path));

    [Fact]
    public void A_schema_with_an_absolute_table_path_is_refused()
    {
        var table = GraphSchemaCatalog.Beta.Tables[0] with { Path = "https://evil.example/collect" };
        var schema = GraphSchemaCatalog.Beta with { Tables = [table] };

        Assert.Throws<JsonException>(() => GraphSchemaUpdates.Validate(schema, GraphPermissionCatalog.Bundled));
    }

    [Fact]
    public void A_schema_with_a_docs_link_off_learn_is_refused()
    {
        var table = GraphSchemaCatalog.Beta.Tables[0] with { DocsUrl = "https://evil.example/" };
        var schema = GraphSchemaCatalog.Beta with { Tables = [table] };

        Assert.Throws<JsonException>(() => GraphSchemaUpdates.Validate(schema, GraphPermissionCatalog.Bundled));
    }

    /// <summary>The committed files, with the schema dated <paramref name="generatedAt"/>, and their manifest.</summary>
    private static Dictionary<string, byte[]> Publish(DateTimeOffset generatedAt, int format = GraphSchemaManifest.CurrentFormat)
    {
        var committed = GraphSchemaCatalog.Beta.GeneratedAt;
        var schemaText = File.ReadAllText(Path.Combine(Folder, GraphSchemaManifest.SchemaFile));
        var schema = Encoding.UTF8.GetBytes(schemaText.Replace(
            $"\"generatedAt\": {JsonSerializer.Serialize(committed)}", $"\"generatedAt\": {JsonSerializer.Serialize(generatedAt)}"));
        var permissions = File.ReadAllBytes(Path.Combine(Folder, GraphSchemaManifest.PermissionsFile));
        var manifest = new GraphSchemaManifest(format, generatedAt, [
            new GraphSchemaFile(GraphSchemaManifest.SchemaFile, GraphSchemaManifest.Sha256(schema), schema.Length),
            new GraphSchemaFile(GraphSchemaManifest.PermissionsFile, GraphSchemaManifest.Sha256(permissions), permissions.Length),
        ]);
        return new Dictionary<string, byte[]>
        {
            [GraphSchemaManifest.SchemaFile] = schema,
            [GraphSchemaManifest.PermissionsFile] = permissions,
            [GraphSchemaManifest.FileName] = Encoding.UTF8.GetBytes(manifest.Write()),
        };
    }

    private static HttpClient Client(Dictionary<string, byte[]> files) => new(new Serving(files));

    private static string FindRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !File.Exists(Path.Combine(dir.FullName, "Kustodian.slnx")))
            dir = dir.Parent;
        return dir?.FullName ?? throw new InvalidOperationException("Kustodian.slnx not found above the test output.");
    }

    /// <summary>Answers each file under <see cref="GraphSchemaUpdates.BaseUrl"/>; anything else is a 404.</summary>
    private sealed class Serving(Dictionary<string, byte[]> files) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var url = request.RequestUri!.AbsoluteUri;
            return Task.FromResult(url.StartsWith(GraphSchemaUpdates.BaseUrl, StringComparison.Ordinal)
                                   && files.TryGetValue(url[GraphSchemaUpdates.BaseUrl.Length..], out var body)
                ? new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(body) }
                : new HttpResponseMessage(HttpStatusCode.NotFound));
        }
    }
}
