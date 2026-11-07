using System.Text;
using System.Text.Json;
using Kustodian.App;
using Kustodian.Library;
using Kustodian.Storage;
using Kustodian.Workbooks;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

namespace Kustodian.Solutions;

/// <summary>A solution in the catalog. <see cref="Compatible"/> is false when it needs a newer app than the running one.</summary>
public sealed record CatalogItem(SolutionManifest Manifest, bool Compatible, string? InstalledVersion);

/// <summary>The catalog's valid solutions; <see cref="Offline"/> is true when the list is the cached one from <see cref="FetchedAt"/>.</summary>
public sealed record Catalog(IReadOnlyList<CatalogItem> Solutions, DateTimeOffset FetchedAt, bool Offline);

/// <summary>Why a catalog request was refused; the message is meant for the user.</summary>
public sealed class SolutionRejectedException(string message) : Exception(message);

/// <summary>
/// The Community Solutions catalog: the repo's <c>Solutions/index.json</c> fetched from GitHub and cached under
/// <c>solution-cache/</c>, and the solution files behind it. Everything fetched is untrusted: bodies are read with a hard size
/// limit, index entries that break the rules are left out, and a file is used only when its bytes match the index's SHA-256.
/// One gate serializes the cache and <c>solutions.json</c>.
/// </summary>
public sealed class SolutionService(JsonFileStore store, HttpClient http, LibraryService library, WorkbookService workbooks,
    TimeProvider time, string appVersion, ILogger<SolutionService>? logger = null)
{
    public const string BaseUrl = "https://raw.githubusercontent.com/FrodeHus/kustodian/main/Solutions/";

    private const string CachePath = "solution-cache/index.json";
    private const long IndexLimit = 4L * 1024 * 1024;
    private static readonly TimeSpan CacheLife = TimeSpan.FromHours(1);
    private const string Unreachable = "Kustodian couldn't reach GitHub.";
    private const string Mismatch = "The download didn't match the catalog. Try again later.";

    private readonly SemaphoreSlim _gate = new(1, 1);
    private readonly ILogger<SolutionService> _log = logger ?? NullLogger<SolutionService>.Instance;
    // Used by install and uninstall.
    private readonly LibraryService _library = library;
    private readonly WorkbookService _workbooks = workbooks;

    private sealed record Cache(DateTimeOffset FetchedAt, SolutionIndexDoc? Index);

    private sealed record Loaded(IReadOnlyList<IndexEntry> Entries, DateTimeOffset FetchedAt, bool Offline);

    /// <summary>The catalog; fetched when there is no cache, the cache is over an hour old, or <paramref name="refresh"/> is set.
    /// Offline, the cache is returned; with no cache, throws <see cref="SolutionRejectedException"/>.</summary>
    public async Task<Catalog> ListAsync(bool refresh, CancellationToken ct)
    {
        await _gate.WaitAsync(ct);
        try
        {
            var loaded = await LoadAsync(refresh, ct);
            var running = UpdateCheck.VersionOf(appVersion);
            var items = loaded.Entries.Select(e => new CatalogItem(e.Manifest,
                running is null || UpdateCheck.VersionOf(e.Manifest.MinAppVersion) <= running, null)).ToList();
            return new Catalog(items, loaded.FetchedAt, loaded.Offline);
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>A solution's manifest and its README, the README checked against the index.</summary>
    public async Task<(SolutionManifest Manifest, string Readme)> GetAsync(string id, CancellationToken ct)
    {
        await _gate.WaitAsync(ct);
        try
        {
            var entry = (await LoadAsync(false, ct)).Entries.FirstOrDefault(e => e.Manifest.Id == id)
                ?? throw new SolutionRejectedException("That solution isn't in the catalog.");
            var readme = entry.Files.First(f => f.Path == "README.md");
            return (entry.Manifest, Encoding.UTF8.GetString(await FetchFileAsync(entry, readme, ct)));
        }
        finally
        {
            _gate.Release();
        }
    }

    private async Task<Loaded> LoadAsync(bool refresh, CancellationToken ct)
    {
        var cache = await ReadCacheAsync(ct);
        if (!refresh && cache is not null && time.GetUtcNow() - cache.FetchedAt < CacheLife)
        {
            return new Loaded(Valid(cache.Index!), cache.FetchedAt, false);
        }

        try
        {
            var bytes = await GetBytesAsync(BaseUrl + "index.json", IndexLimit, ct);
            var index = JsonSerializer.Deserialize<SolutionIndexDoc>(bytes, JsonFileStore.Options);
            if (index is not { Version: 1, Solutions: not null })
            {
                throw new InvalidDataException("The index isn't the expected shape.");
            }

            var fetched = time.GetUtcNow();
            try
            {
                await store.WriteAsync(CachePath, new Cache(fetched, index), ct);
            }
            catch (IOException e)
            {
                _log.LogWarning(e, "The solutions cache could not be written.");
            }

            return new Loaded(Valid(index), fetched, false);
        }
        catch (Exception e) when (e is HttpRequestException or InvalidDataException or JsonException
                                      or OperationCanceledException && !ct.IsCancellationRequested)
        {
            _log.LogWarning(e, "The solutions index could not be fetched.");
            return cache is null
                ? throw new SolutionRejectedException(Unreachable)
                : new Loaded(Valid(cache.Index!), cache.FetchedAt, true);
        }
    }

    private async Task<Cache?> ReadCacheAsync(CancellationToken ct)
    {
        var read = await store.ReadAsync<Cache?>(CachePath, null, ct);
        return read.Value is { Index.Solutions: not null } ? read.Value : null;
    }

    /// <summary>The entries that pass the rules: nothing null, a valid manifest under its own id, valid files that are exactly the
    /// expected ones, and each id once. The index is untrusted JSON, so nulls are checked before any rule runs.</summary>
    private static List<IndexEntry> Valid(SolutionIndexDoc index) =>
    [
        .. index.Solutions.Where(e => e is not null && HasNoNulls(e) && IsValid(e))
            .GroupBy(e => e.Manifest.Id).Select(g => g.First()),
    ];

    private static bool HasNoNulls(IndexEntry e) =>
        e.Manifest is { Id: not null, Name: not null, SolutionVersion: not null, Support: not null, MinAppVersion: not null,
            Categories: not null, Sources: not null, Description: not null, Author: not null, Content: not null }
        && e.Manifest.Categories.All(c => c is not null) && e.Manifest.Sources.All(s => s is not null)
        && e.Manifest.Content is { Queries: not null, Workbooks: not null, Tools: not null } content
        && content.Queries.All(q => q is not null) && content.Workbooks.All(w => w is not null)
        && content.Tools.All(t => t is not null)
        && e.Files is not null && e.Files.All(f => f is { Path: not null, Sha256: not null });

    private static bool IsValid(IndexEntry e) =>
        SolutionRules.IsId(e.Manifest.Id) && SolutionRules.ManifestProblem(e.Manifest, e.Manifest.Id) is null
        && e.Files.All(f => SolutionRules.FileProblem(f) is null)
        && e.Files.Select(f => f.Path).Order(StringComparer.Ordinal)
            .SequenceEqual(SolutionRules.ExpectedFiles(e.Manifest).Order(StringComparer.Ordinal));

    /// <summary>The file's bytes, read with the index's size as the limit and checked against its SHA-256.</summary>
    private async Task<byte[]> FetchFileAsync(IndexEntry e, IndexFile f, CancellationToken ct)
    {
        byte[] bytes;
        try
        {
            bytes = await GetBytesAsync(BaseUrl + e.Manifest.Id + "/" + f.Path, f.Size, ct);
        }
        catch (InvalidDataException)
        {
            throw new SolutionRejectedException(Mismatch);
        }
        catch (Exception ex) when (ex is HttpRequestException or OperationCanceledException && !ct.IsCancellationRequested)
        {
            _log.LogWarning(ex, "The solution file {Path} could not be fetched.", f.Path);
            throw new SolutionRejectedException(Unreachable);
        }

        return SolutionHash.Sha256(bytes) == f.Sha256 ? bytes : throw new SolutionRejectedException(Mismatch);
    }

    /// <summary>A GET read in chunks; over <paramref name="limit"/> bytes throws <see cref="InvalidDataException"/> without
    /// trusting Content-Length.</summary>
    private async Task<byte[]> GetBytesAsync(string url, long limit, CancellationToken ct)
    {
        using var response = await http.GetAsync(url, HttpCompletionOption.ResponseHeadersRead, ct);
        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync(ct);
        using var body = new MemoryStream();
        var buffer = new byte[16 * 1024];
        int read;
        while ((read = await stream.ReadAsync(buffer, ct)) > 0)
        {
            if (body.Length + read > limit)
            {
                throw new InvalidDataException($"The response is over {limit} bytes.");
            }

            body.Write(buffer, 0, read);
        }

        return body.ToArray();
    }
}
