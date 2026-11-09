using System.Security.Cryptography;
using System.Text.Json;

namespace Kustodian.Graph.Schema;

/// <summary>One file the manifest lists: its name in the <c>GraphSchema</c> folder, lowercase hex SHA-256 and size in bytes.</summary>
public sealed record GraphSchemaFile(string Path, string Sha256, long Size);

/// <summary>
/// <c>GraphSchema/manifest.json</c>, written by <c>tools/schema</c> beside <see cref="SchemaFile"/> and
/// <see cref="PermissionsFile"/>. The app reads it from the repository to find out whether a newer schema is published, and
/// downloads the files only when <see cref="Format"/> is one it reads (<see cref="CurrentFormat"/>) and
/// <see cref="GeneratedAt"/> is newer than the schema it has.
/// </summary>
public sealed record GraphSchemaManifest(int Format, DateTimeOffset GeneratedAt, IReadOnlyList<GraphSchemaFile> Files)
{
    /// <summary>The file layout this build reads. Raise it when <see cref="GraphSchemaJson"/> or
    /// <see cref="GraphPermissionCatalog"/> changes in a way an older build can't read, so older builds keep the schema they have.</summary>
    public const int CurrentFormat = 1;

    public const string FileName = "manifest.json";
    public const string SchemaFile = "graph-beta.json";
    public const string PermissionsFile = "graph-permissions.json";

    /// <summary>The files the app downloads, in that order.</summary>
    public static readonly IReadOnlyList<string> FileNames = [SchemaFile, PermissionsFile];

    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { WriteIndented = true };

    /// <summary>The manifest for the files in <paramref name="directory"/>, dated by the schema's own <c>generatedAt</c>.</summary>
    public static GraphSchemaManifest Describe(string directory)
    {
        DateTimeOffset generatedAt;
        using (var schema = File.OpenRead(Path.Combine(directory, SchemaFile)))
            generatedAt = GraphSchemaJson.Read(schema).GeneratedAt;
        return new GraphSchemaManifest(CurrentFormat, generatedAt, [.. FileNames.Select(name =>
        {
            var bytes = File.ReadAllBytes(Path.Combine(directory, name));
            return new GraphSchemaFile(name, Sha256(bytes), bytes.Length);
        })]);
    }

    /// <summary>Lowercase hex SHA-256.</summary>
    public static string Sha256(ReadOnlySpan<byte> data) => Convert.ToHexStringLower(SHA256.HashData(data));

    /// <summary>The entry for <paramref name="name"/>, or null when the manifest doesn't list it.</summary>
    public GraphSchemaFile? FileOf(string name) => Files.FirstOrDefault(f => f.Path == name);

    public string Write() => JsonSerializer.Serialize(this, Json) + "\n";

    /// <summary>Reads a manifest; throws <see cref="JsonException"/> when it isn't one, or doesn't list every file in
    /// <see cref="FileNames"/> with a hash and size.</summary>
    public static GraphSchemaManifest Read(ReadOnlySpan<byte> json)
    {
        var manifest = JsonSerializer.Deserialize<Wire>(json, Json) ?? throw new JsonException("The manifest is empty.");
        if (manifest.Format is not { } format || manifest.GeneratedAt is not { } generatedAt || manifest.Files is null)
            throw new JsonException("The manifest has no format, generatedAt or files.");
        var files = manifest.Files.Select(f => f is { Path: not null, Sha256: not null, Size: >= 0 }
            ? new GraphSchemaFile(f.Path, f.Sha256, f.Size.Value)
            : throw new JsonException("A manifest file has no path, sha256 or size.")).ToList();
        var result = new GraphSchemaManifest(format, generatedAt, files);
        if (FileNames.Any(name => result.FileOf(name) is null))
            throw new JsonException("The manifest doesn't list every schema file.");
        return result;
    }

    private sealed record Wire(int? Format, DateTimeOffset? GeneratedAt, List<WireFile?>? Files);

    private sealed record WireFile(string? Path, string? Sha256, long? Size);
}
