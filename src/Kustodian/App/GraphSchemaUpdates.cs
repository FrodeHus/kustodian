using System.Text.Json;
using System.Text.RegularExpressions;
using Kustodian.Graph.Schema;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

namespace Kustodian.App;

/// <summary>The Graph schema and permission catalog the app runs with. <see cref="Downloaded"/> is true when they are the copy
/// <see cref="GraphSchemaUpdates"/> downloaded, false when they are the ones built into the app.</summary>
public sealed record ActiveGraphSchema(GraphSchema Schema, GraphPermissionCatalog Permissions, bool Downloaded);

/// <summary>What the app knows about its Graph schema: the one in use (<see cref="Downloaded"/>: the downloaded copy rather
/// than the built-in one), and a newer one downloaded since the app started, which is used after a restart
/// (<see cref="Pending"/>, its date; null when there is none). <see cref="CheckedAt"/> is when the repository was last asked.</summary>
public sealed record GraphSchemaStatus(DateTimeOffset GeneratedAt, string Source, bool Downloaded, DateTimeOffset? Pending,
    DateTimeOffset? CheckedAt);

/// <summary>Thrown when the published schema couldn't be read or isn't valid; the message is meant for the user.</summary>
public sealed class GraphSchemaUpdateException(string message) : Exception(message);

/// <summary>
/// Keeps the Graph schema current without a new release. The repository's <c>GraphSchema/</c> folder on main holds the
/// schema, the permission catalog and <see cref="GraphSchemaManifest"/>; <see cref="CheckAsync"/> downloads them when the
/// manifest is newer than the schema in use and in a format this build reads, checks each file's hash and contents, and keeps
/// them under <c>graph-schema/</c>. <see cref="Load"/> uses that copy at the next start when it is newer than the built-in one,
/// so a schema is never swapped under a running app. Everything downloaded is untrusted: bodies are size-limited, and table
/// paths, docs links and permission names are checked before the copy is kept or used.
/// </summary>
public sealed partial class GraphSchemaUpdates(HttpClient github, string root, ActiveGraphSchema active, TimeProvider time,
    ILogger<GraphSchemaUpdates>? logger = null)
{
    public const string BaseUrl = "https://raw.githubusercontent.com/FrodeHus/kustodian/main/GraphSchema/";
    public const string DirectoryName = "graph-schema";

    private const long ManifestLimit = 64 * 1024;
    private const long FileLimit = 64 * 1024 * 1024;
    private static readonly TimeSpan ReadTimeout = TimeSpan.FromMinutes(2);

    private readonly ILogger<GraphSchemaUpdates> _log = logger ?? NullLogger<GraphSchemaUpdates>.Instance;
    private readonly SemaphoreSlim _gate = new(1, 1);
    private DateTimeOffset? _checkedAt;

    /// <summary>The schema to run with: the downloaded copy under <paramref name="root"/> when it is valid, in this build's
    /// format and newer than the built-in schema; otherwise the built-in one. A copy that can't be used is logged and skipped.</summary>
    public static ActiveGraphSchema Load(string root, ILogger? log = null)
    {
        var builtIn = new ActiveGraphSchema(GraphSchemaCatalog.Beta, GraphPermissionCatalog.Bundled, false);
        var dir = Path.Combine(root, DirectoryName);
        if (!File.Exists(Path.Combine(dir, GraphSchemaManifest.FileName)))
            return builtIn;
        try
        {
            var manifest = GraphSchemaManifest.Read(File.ReadAllBytes(Path.Combine(dir, GraphSchemaManifest.FileName)));
            if (manifest.Format != GraphSchemaManifest.CurrentFormat || manifest.GeneratedAt <= builtIn.Schema.GeneratedAt)
                return builtIn;
            var (schema, permissions) = Parse(manifest, name => File.ReadAllBytes(Path.Combine(dir, name)));
            return new ActiveGraphSchema(schema, permissions, true);
        }
        catch (Exception e) when (IsUnreadable(e) || e is IOException or UnauthorizedAccessException)
        {
            log?.LogWarning(e, "The downloaded Graph schema can't be used; the built-in one is.");
            return builtIn;
        }
    }

    /// <summary>The schema in use and any newer one waiting for a restart.</summary>
    public GraphSchemaStatus Status() =>
        new(active.Schema.GeneratedAt, active.Schema.Source, active.Downloaded, PendingDate(), _checkedAt);

    /// <summary>Asks the repository for a newer schema and downloads it. <paramref name="force"/> downloads it again even when it
    /// is the one in use or already waiting for a restart, which replaces a damaged copy. Throws
    /// <see cref="GraphSchemaUpdateException"/> when the repository can't be reached or what it sent isn't valid; nothing is
    /// kept then.</summary>
    public async Task<GraphSchemaStatus> CheckAsync(bool force, CancellationToken ct)
    {
        await _gate.WaitAsync(ct);
        try
        {
            var manifest = GraphSchemaManifest.Read(await GetAsync(GraphSchemaManifest.FileName, ManifestLimit, ct));
            _checkedAt = time.GetUtcNow();
            var wanted = force
                ? manifest.GeneratedAt >= active.Schema.GeneratedAt
                : manifest.GeneratedAt > active.Schema.GeneratedAt && !(PendingDate() >= manifest.GeneratedAt);
            if (manifest.Format != GraphSchemaManifest.CurrentFormat || !wanted)
                return Status();

            var files = new Dictionary<string, byte[]>(StringComparer.Ordinal);
            foreach (var name in GraphSchemaManifest.FileNames)
                files[name] = await GetAsync(name, Math.Min(manifest.FileOf(name)!.Size, FileLimit), ct);
            Parse(manifest, name => files[name]);
            Keep(manifest, files);
            _log.LogInformation("Downloaded the Graph schema generated at {GeneratedAt}; it is used after a restart.", manifest.GeneratedAt);
            return Status();
        }
        catch (Exception e) when (IsUnreadable(e))
        {
            _log.LogWarning(e, "The published Graph schema isn't valid.");
            throw new GraphSchemaUpdateException("The published Graph schema isn't valid, so it wasn't downloaded.");
        }
        catch (Exception e) when (e is HttpRequestException or InvalidDataException
                                      || e is OperationCanceledException && !ct.IsCancellationRequested)
        {
            _log.LogWarning(e, "The Graph schema couldn't be downloaded.");
            throw new GraphSchemaUpdateException("Kustodian couldn't download the Graph schema from GitHub.");
        }
        catch (IOException e)
        {
            _log.LogWarning(e, "The downloaded Graph schema couldn't be saved.");
            throw new GraphSchemaUpdateException("The downloaded Graph schema couldn't be saved.");
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>The kept copy's date when it is newer than the schema in use, else null.</summary>
    private DateTimeOffset? PendingDate()
    {
        try
        {
            var path = Path.Combine(root, DirectoryName, GraphSchemaManifest.FileName);
            if (!File.Exists(path))
                return null;
            var kept = GraphSchemaManifest.Read(File.ReadAllBytes(path));
            return kept.Format == GraphSchemaManifest.CurrentFormat && kept.GeneratedAt > active.Schema.GeneratedAt ? kept.GeneratedAt : null;
        }
        catch (Exception e) when (e is JsonException or IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    private Task<byte[]> GetAsync(string name, long limit, CancellationToken ct) =>
        BoundedGet.BytesAsync(github, BaseUrl + name, limit, ReadTimeout, ct);

    /// <summary>Writes the files to a fresh folder, then swaps it in, so a crash leaves the old copy or the new one whole.</summary>
    private void Keep(GraphSchemaManifest manifest, Dictionary<string, byte[]> files)
    {
        var dir = Path.Combine(root, DirectoryName);
        var staging = dir + ".new";
        var old = dir + ".old";
        if (Directory.Exists(staging))
            Directory.Delete(staging, true);
        Directory.CreateDirectory(staging);
        foreach (var (name, bytes) in files)
            File.WriteAllBytes(Path.Combine(staging, name), bytes);
        File.WriteAllText(Path.Combine(staging, GraphSchemaManifest.FileName), manifest.Write());
        if (Directory.Exists(old))
            Directory.Delete(old, true);
        var replacing = Directory.Exists(dir);
        if (replacing)
            Directory.Move(dir, old);
        Directory.Move(staging, dir);
        if (replacing)
            Directory.Delete(old, true);
    }

    /// <summary>Checks every file against the manifest and reads it; throws <see cref="JsonException"/> on anything that doesn't
    /// match or isn't safe to use.</summary>
    internal static (GraphSchema Schema, GraphPermissionCatalog Permissions) Parse(GraphSchemaManifest manifest, Func<string, byte[]> read)
    {
        byte[] Verified(string name)
        {
            var bytes = read(name);
            var entry = manifest.FileOf(name)!;
            return bytes.Length == entry.Size && GraphSchemaManifest.Sha256(bytes) == entry.Sha256
                ? bytes
                : throw new JsonException($"{name} doesn't match the manifest.");
        }

        var schema = GraphSchemaJson.Read(new MemoryStream(Verified(GraphSchemaManifest.SchemaFile)));
        var permissions = GraphPermissionCatalog.Read(new MemoryStream(Verified(GraphSchemaManifest.PermissionsFile)));
        if (schema.GeneratedAt != manifest.GeneratedAt)
            throw new JsonException("The schema's date doesn't match the manifest.");
        Validate(schema, permissions);
        return (schema, permissions);
    }

    /// <summary>Table paths go into Graph request URLs, docs links are opened in the browser and permission names are asked for
    /// when the Entra app is created, so each must look like what <c>tools/schema</c> writes.</summary>
    internal static void Validate(GraphSchema schema, GraphPermissionCatalog permissions)
    {
        foreach (var table in schema.Tables)
        {
            if (!IsGraphPath(table.Path))
                throw new JsonException($"The table {table.Name} has an invalid path.");
            if (!table.DocsUrl.StartsWith("https://learn.microsoft.com/", StringComparison.Ordinal))
                throw new JsonException($"The table {table.Name} has an invalid docs link.");
            if (table.Columns.Any(c => c.RelationshipPath is { } p && !IsGraphPath(p)))
                throw new JsonException($"The table {table.Name} has an invalid relationship path.");
        }

        if (permissions.Permissions.Any(p => !PermissionName().IsMatch(p.Name)))
            throw new JsonException("The permission catalog has an invalid permission name.");
    }

    internal static bool IsGraphPath(string path) => GraphPath().IsMatch(path) && !path.Split('/').Contains("..");

    private static bool IsUnreadable(Exception e) =>
        e is JsonException or KeyNotFoundException or InvalidOperationException or FormatException;

    [GeneratedRegex("^[A-Za-z0-9_.()'=,-]+(/[A-Za-z0-9_.()'=,-]+)*$")]
    private static partial Regex GraphPath();

    [GeneratedRegex("^[A-Za-z0-9._-]+$")]
    private static partial Regex PermissionName();
}
