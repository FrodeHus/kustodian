using System.Net.Http.Headers;
using System.Text.Json;
using Kustodian.Graph.Schema;

// Regenerates src/Kustodian.Graph/Schema/graph-beta.json from Microsoft Graph's described beta CSDL and Microsoft's
// permissions data.
//   dotnet run --project tools/schema -- [--metadata <path|url>] [--permissions <path|url>] [--out <path>]
// With no arguments it downloads both inputs, writes the file and prints what changed.

// Exit codes: 0 ok, 2 usage, 3 an input couldn't be read or downloaded.
const string MetadataPath = "clean_beta_metadata/cleanMetadataWithDescriptionsAndAnnotationsbeta.xml";
const string CommitUrl = "https://api.github.com/repos/microsoftgraph/msgraph-metadata/commits/master";
const string PermissionsUrl = "https://raw.githubusercontent.com/microsoftgraph/microsoft-graph-devx-content/master/permissions/new/permissions.json";

string? metadata = null;
string? permissionsInput = null;
string? outPath = null;
for (var i = 0; i < args.Length; i++)
{
    switch (args[i])
    {
        case "--metadata" when i + 1 < args.Length:
            metadata = args[++i];
            break;
        case "--permissions" when i + 1 < args.Length:
            permissionsInput = args[++i];
            break;
        case "--out" when i + 1 < args.Length:
            outPath = args[++i];
            break;
        default:
            Console.Error.WriteLine("Usage: schema [--metadata <path|url>] [--permissions <path|url>] [--out <path>]");
            return 2;
    }
}

var schemaPath = outPath ?? Path.Combine(FindSolutionRoot(), "src", "Kustodian.Graph", "Schema", "graph-beta.json");

using var http = new HttpClient { Timeout = TimeSpan.FromMinutes(2) };
http.DefaultRequestHeaders.UserAgent.Add(new ProductInfoHeaderValue("kustodian-schema", "1.0"));

GraphSchema generated;
try
{
    var (metadataSource, metadataStream) = metadata is null ? await DownloadMetadata(http) : await Open(http, metadata);
    var (permissionsSource, permissionsStream) = await Open(http, permissionsInput ?? PermissionsUrl);
    await using (metadataStream)
    await using (permissionsStream)
    {
        var permissions = GraphPermissions.ReadDelegated(permissionsStream);
        generated = GraphSchemaBuilder.Build(GraphMetadata.Load(metadataStream), permissions,
            $"{metadataSource}; permissions {permissionsSource}", DateTimeOffset.UtcNow);
    }
}
catch (Exception e) when (e is HttpRequestException or TaskCanceledException or JsonException or KeyNotFoundException or IOException)
{
    Console.Error.WriteLine($"Couldn't read the inputs: {e.Message}");
    return 3;
}

GraphSchema? committed = null;
if (File.Exists(schemaPath))
{
    await using var existing = File.OpenRead(schemaPath);
    committed = GraphSchemaJson.Read(existing);
}

var diff = committed is null ? null : GraphSchemaDiff.Compare(committed, generated);
Console.WriteLine($"Source: {generated.Source}");
Console.WriteLine($"Tables: {generated.Tables.Count}, with permissions: {generated.Tables.Count(t => t.Permissions.Count > 0)}, " +
    $"complex types: {generated.ComplexTypes.Count}");
if (diff is not null)
    Console.WriteLine(diff.ToSummary());

if (diff is { IsEmpty: true })
{
    Console.WriteLine("Nothing to write.");
    return 0;
}

await File.WriteAllTextAsync(schemaPath, GraphSchemaJson.Write(generated));
Console.WriteLine($"Wrote {schemaPath}");
return 0;

// A URL is downloaded, anything else is a local file.
static async Task<(string Source, Stream Content)> Open(HttpClient http, string pathOrUrl)
{
    if (!Uri.TryCreate(pathOrUrl, UriKind.Absolute, out var uri) || uri.Scheme is not ("http" or "https"))
        return ("local:" + Path.GetFileName(pathOrUrl), File.OpenRead(pathOrUrl));

    var buffer = new MemoryStream();
    using (var response = await http.GetAsync(uri, HttpCompletionOption.ResponseHeadersRead))
    {
        response.EnsureSuccessStatusCode();
        await (await response.Content.ReadAsStreamAsync()).CopyToAsync(buffer);
    }

    buffer.Position = 0;
    return (pathOrUrl, buffer);
}

// Resolves master to a commit sha, then fetches the metadata at that sha so the recorded source and the content agree.
static async Task<(string Source, Stream Metadata)> DownloadMetadata(HttpClient http)
{
    using var commitRequest = new HttpRequestMessage(HttpMethod.Get, CommitUrl);
    var token = Environment.GetEnvironmentVariable("GITHUB_TOKEN");
    if (!string.IsNullOrEmpty(token))
        commitRequest.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);

    string sha;
    using (var commitResponse = await http.SendAsync(commitRequest))
    {
        commitResponse.EnsureSuccessStatusCode();
        using var commit = await JsonDocument.ParseAsync(await commitResponse.Content.ReadAsStreamAsync());
        sha = commit.RootElement.GetProperty("sha").GetString() ?? throw new JsonException("The commit answer has no sha.");
    }

    var (_, content) = await Open(http, $"https://raw.githubusercontent.com/microsoftgraph/msgraph-metadata/{sha}/{MetadataPath}");
    return ("msgraph-metadata@" + sha, content);
}

static string FindSolutionRoot()
{
    for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir is not null; dir = dir.Parent)
    {
        if (dir.EnumerateFiles("Kustodian.slnx").Any())
            return dir.FullName;
    }

    throw new InvalidOperationException("No Kustodian.slnx found above the tool.");
}
