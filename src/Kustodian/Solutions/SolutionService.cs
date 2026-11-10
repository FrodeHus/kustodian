using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Kustodian.App;
using Kustodian.History;
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

/// <summary>An item a solution installed: <see cref="Kind"/> is <c>query</c> or <c>workbook</c>, <see cref="ItemId"/> its id in the
/// solution and <see cref="LibraryId"/> the saved query's or workbook's id.</summary>
public sealed record InstalledItem(string Kind, string ItemId, string LibraryId);

/// <summary>An installed solution as <c>solutions.json</c> lists it. <see cref="Manifest"/> is the manifest as installed, so the
/// solution can be shown and uninstalled offline or after it leaves the catalog; null in files written before it was kept.</summary>
public sealed record InstalledSolution(string Id, string SolutionVersion, DateTimeOffset InstalledAt, IReadOnlyList<InstalledItem> Items,
    SolutionManifest? Manifest = null);

/// <summary>Why a catalog request was refused; the message is meant for the user.</summary>
public sealed class SolutionRejectedException(string message) : Exception(message);

/// <summary>
/// The Community Solutions catalog: the repo's <c>Solutions/index.json</c> fetched from GitHub and cached under
/// <c>solution-cache/</c>, and the solution files behind it. Everything fetched is untrusted: bodies are read with a hard size
/// limit, index entries that break the rules are left out, and a file is used only when its bytes match the index's SHA-256.
/// One gate serializes the cache and <c>solutions.json</c>. Install fetches and checks every item before it writes any, and
/// deletes what it wrote when a write fails; each installed item carries a <see cref="SolutionOrigin"/>.
/// </summary>
public sealed class SolutionService(JsonFileStore store, HttpClient http, LibraryService library, WorkbookService workbooks,
    HistoryStore history, TimeProvider time, string appVersion, ILogger<SolutionService>? logger = null)
{
    public const string BaseUrl = "https://raw.githubusercontent.com/FrodeHus/kustodian/main/Solutions/";

    private const string CachePath = "solution-cache/index.json";
    private const string InstalledPath = "solutions.json";
    private const string QueryKind = "query";
    private const string WorkbookKind = "workbook";
    private const long IndexLimit = 4L * 1024 * 1024;
    private static readonly TimeSpan CacheLife = TimeSpan.FromHours(1);
    private static readonly TimeSpan ReadTimeout = TimeSpan.FromSeconds(30);
    private const string Unreachable = "Kustodian couldn't reach GitHub.";
    private const string Mismatch = "The download didn't match the catalog. Try again later.";
    private const string NotInCatalog = "That solution isn't in the catalog.";
    private const string AlreadyInstalled = "This solution is already installed.";
    private const string NotInstalled = "That solution isn't installed.";

    private readonly SemaphoreSlim _gate = new(1, 1);
    private readonly ILogger<SolutionService> _log = logger ?? NullLogger<SolutionService>.Instance;
    private readonly LibraryService _library = library;
    private readonly WorkbookService _workbooks = workbooks;

    private sealed record Cache(DateTimeOffset FetchedAt, SolutionIndexDoc? Index);

    private sealed record InstalledDoc(int Version, IReadOnlyList<InstalledSolution> Installed);

    private sealed record QueryPlan(string ItemId, SavedQueryInput Input, SolutionOrigin Origin);

    private sealed record WorkbookPlan(string ItemId, JsonObject Doc);

    private sealed record Loaded(IReadOnlyList<IndexEntry> Entries, DateTimeOffset FetchedAt, bool Offline);

    /// <summary>The catalog; fetched when there is no cache, the cache is over an hour old, or <paramref name="refresh"/> is set.
    /// Offline, the cache is returned; with no cache, throws <see cref="SolutionRejectedException"/>.</summary>
    public async Task<Catalog> ListAsync(bool refresh, CancellationToken ct)
    {
        await _gate.WaitAsync(ct);
        try
        {
            var loaded = await LoadAsync(refresh, ct);
            var installed = await ReadInstalledAsync(ct);
            var items = loaded.Entries.Select(e => new CatalogItem(e.Manifest, Compatible(e.Manifest),
                installed.FirstOrDefault(s => s.Id == e.Manifest.Id)?.SolutionVersion)).ToList();
            // Installed solutions no longer in the catalog stay listed, so they can still be uninstalled.
            items.AddRange(installed.Where(s => items.All(i => i.Manifest.Id != s.Id))
                .Select(s => new CatalogItem(ManifestOf(s), true, s.SolutionVersion)));
            return new Catalog(items, loaded.FetchedAt, loaded.Offline);
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>A solution's manifest and its README, the README checked against the index. For an installed solution, a
    /// catalog or README that can't be had is no error: the README is empty, and the manifest is its snapshot when the catalog
    /// doesn't list it.</summary>
    public async Task<(SolutionManifest Manifest, string Readme)> GetAsync(string id, CancellationToken ct)
    {
        IndexEntry? entry;
        InstalledSolution? installed;
        await _gate.WaitAsync(ct);
        try
        {
            installed = (await ReadInstalledAsync(ct)).FirstOrDefault(s => s.Id == id);
            try
            {
                entry = (await LoadAsync(false, ct)).Entries.FirstOrDefault(e => e.Manifest.Id == id);
            }
            catch (SolutionRejectedException) when (installed is not null)
            {
                entry = null;
            }
        }
        finally
        {
            _gate.Release();
        }

        if (entry is null)
        {
            return installed is null ? throw new SolutionRejectedException(NotInCatalog) : (ManifestOf(installed), "");
        }

        // Downloaded outside the gate, which only protects the cache and solutions.json.
        var readme = entry.Files.First(f => f.Path == "README.md");
        try
        {
            return (entry.Manifest, Encoding.UTF8.GetString(await FetchFileAsync(entry, readme, ct)));
        }
        catch (SolutionRejectedException) when (installed is not null)
        {
            return (entry.Manifest, "");
        }
    }

    /// <summary>Installs the solution's queries and workbooks, except the item ids in <paramref name="skip"/>, into a library
    /// folder named after it, with new ids and each item's <see cref="SolutionOrigin"/>, and lists it in <c>solutions.json</c>.
    /// Every item is fetched and checked first; when a write fails, what was written is deleted and the error rethrown.
    /// Throws <see cref="SolutionRejectedException"/> when it isn't in the catalog, needs a newer app, is already installed, or
    /// an item is refused.</summary>
    public async Task<InstalledSolution> InstallAsync(string id, IReadOnlySet<string> skip, CancellationToken ct)
    {
        IndexEntry entry;
        await _gate.WaitAsync(ct);
        try
        {
            entry = (await LoadAsync(false, ct)).Entries.FirstOrDefault(e => e.Manifest.Id == id)
                ?? throw new SolutionRejectedException(NotInCatalog);
            if (!Compatible(entry.Manifest))
            {
                throw new SolutionRejectedException($"Needs Kustodian {entry.Manifest.MinAppVersion}");
            }

            if ((await ReadInstalledAsync(ct)).Any(s => s.Id == id))
            {
                throw new SolutionRejectedException(AlreadyInstalled);
            }
        }
        finally
        {
            _gate.Release();
        }

        // Downloaded and checked outside the gate; nothing is written until every item passes.
        var (queries, workbooks) = await PlanAsync(entry, skip, ct);

        await _gate.WaitAsync(ct);
        try
        {
            // Checked again: another install of the same solution may have finished while this one downloaded.
            var installed = await ReadInstalledAsync(ct);
            if (installed.Any(s => s.Id == id))
            {
                throw new SolutionRejectedException(AlreadyInstalled);
            }

            var writtenQueries = new List<string>();
            var writtenWorkbooks = new List<string>();
            try
            {
                foreach (var q in queries)
                {
                    writtenQueries.Add(q.Input.Id!);
                    await _library.SaveAsync(q.Input, q.Origin, ct);
                }

                foreach (var w in workbooks)
                {
                    writtenWorkbooks.Add(w.Doc["id"]!.GetValue<string>());
                    await _workbooks.SaveAsync(w.Doc, false, ct);
                }

                var solution = new InstalledSolution(id, entry.Manifest.SolutionVersion, time.GetUtcNow(),
                [
                    .. queries.Select(q => new InstalledItem(QueryKind, q.ItemId, q.Input.Id!)),
                    .. workbooks.Select(w => new InstalledItem(WorkbookKind, w.ItemId, w.Doc["id"]!.GetValue<string>())),
                ], entry.Manifest);
                await store.WriteAsync(InstalledPath, new InstalledDoc(1, [.. installed, solution]), ct);
                return solution;
            }
            catch
            {
                await RollBackAsync(writtenQueries, writtenWorkbooks);
                throw;
            }
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>The installed solution with this id, or null when it isn't installed.</summary>
    public async Task<InstalledSolution?> InstalledAsync(string id, CancellationToken ct)
    {
        await _gate.WaitAsync(ct);
        try
        {
            return (await ReadInstalledAsync(ct)).FirstOrDefault(s => s.Id == id);
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>The installed solution's items that still exist and whose content no longer matches their origin's hash.</summary>
    public async Task<IReadOnlyList<InstalledItem>> ModifiedAsync(string id, CancellationToken ct)
    {
        InstalledSolution solution;
        await _gate.WaitAsync(ct);
        try
        {
            solution = (await ReadInstalledAsync(ct)).FirstOrDefault(s => s.Id == id)
                ?? throw new SolutionRejectedException(NotInstalled);
        }
        finally
        {
            _gate.Release();
        }

        var queries = (await _library.ListAsync(ct)).Queries.ToDictionary(q => q.Id);
        var modified = new List<InstalledItem>();
        foreach (var item in solution.Items)
        {
            var modifiedNow = item.Kind == QueryKind
                ? queries.TryGetValue(item.LibraryId, out var q) && IsModified(q)
                : await _workbooks.GetAsync(item.LibraryId, ct) is { } wb && IsModified(wb);
            if (modifiedNow)
            {
                modified.Add(item);
            }
        }

        return modified;
    }

    /// <summary>Deletes the solution's unmodified items and removes it from <c>solutions.json</c>. The library ids in
    /// <paramref name="keepModified"/>, and any item modified by now, stay as the user's own with their origin cleared. Items
    /// already gone are skipped.</summary>
    public async Task UninstallAsync(string id, IReadOnlySet<string> keepModified, CancellationToken ct)
    {
        await _gate.WaitAsync(ct);
        try
        {
            var installed = await ReadInstalledAsync(ct);
            var solution = installed.FirstOrDefault(s => s.Id == id) ?? throw new SolutionRejectedException(NotInstalled);
            var queries = (await _library.ListAsync(ct)).Queries.ToDictionary(q => q.Id);
            foreach (var item in solution.Items)
            {
                // Never delete what the user changed, even after ModifiedAsync was asked.
                var keep = keepModified.Contains(item.LibraryId);
                if (item.Kind == QueryKind)
                {
                    if (queries.TryGetValue(item.LibraryId, out var q))
                    {
                        await (keep || IsModified(q) ? _library.SaveAsync(InputOf(q), null, ct) : _library.DeleteAsync(q.Id, ct));
                    }
                }
                else if (await _workbooks.GetAsync(item.LibraryId, ct) is { } wb)
                {
                    keep = keep || IsModified(wb);
                    wb.Remove("origin");
                    if (keep)
                    {
                        await _workbooks.SaveAsync(wb, false, ct);
                    }
                    else
                    {
                        await _workbooks.DeleteAsync(item.LibraryId, ct);
                        // As WorkbookHandler's delete: the workbook's history goes with it, filed under the lowercase id.
                        await history.DeleteWorkbookAsync(Guid.Parse(item.LibraryId).ToString("D"), ct);
                    }
                }
            }

            await store.WriteAsync(InstalledPath, new InstalledDoc(1, [.. installed.Where(s => s.Id != id)]), ct);
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>The library folder for a solution: the twin of the web's <c>importFolder</c>.</summary>
    internal static string FolderFor(string name)
    {
        var cut = name.Trim().Replace('/', '-');
        cut = cut[..Math.Min(cut.Length, LibraryService.MaxFolderLength)].Trim();
        return cut.Length == 0 ? "Imported workbook" : cut;
    }

    /// <summary>Fetches and checks the items to install: queries with new ids, workbooks with a new id, the folder, links to
    /// the installed queries rewritten (to null for the others) and their origin. Writes nothing.</summary>
    private async Task<(List<QueryPlan>, List<WorkbookPlan>)> PlanAsync(IndexEntry entry, IReadOnlySet<string> skip,
        CancellationToken ct)
    {
        var m = entry.Manifest;
        var folder = FolderFor(m.Name);
        var queries = new List<QueryPlan>();
        foreach (var itemId in m.Content.Queries.Where(q => !skip.Contains(q)))
        {
            var (node, sha) = await FetchJsonAsync(entry, $"queries/{itemId}.json", ct);
            var input = LibraryService.ReadInput(node, JsonFileStore.Options) is { } read
                ? read with
                {
                    Id = Guid.NewGuid().ToString("D"),
                    Folder = folder,
                    // Solutions are tenant-agnostic: an author's workspace never installs (hashed on this stripped form).
                    Options = read.Options is null ? null : read.Options with { Workspaces = null },
                }
                : throw Refused(QueryKind, itemId, "It isn't a saved query.");
            if (LibraryService.Problem(input) is { } problem)
            {
                throw Refused(QueryKind, itemId, problem);
            }

            queries.Add(new QueryPlan(itemId, input, new SolutionOrigin(m.Id, m.SolutionVersion, itemId, sha, SolutionHash.Query(input))));
        }

        var linked = queries.ToDictionary(q => q.ItemId);
        var workbooks = new List<WorkbookPlan>();
        foreach (var itemId in m.Content.Workbooks.Where(w => !skip.Contains(w)))
        {
            var (node, sha) = await FetchJsonAsync(entry, $"workbooks/{itemId}.json", ct);
            var doc = node as JsonObject ?? throw Refused(WorkbookKind, itemId, "It isn't a Kustodian workbook.");
            doc["id"] = Guid.NewGuid().ToString("D");
            doc["folder"] = folder;
            doc.Remove("origin");
            if (doc["widgets"] is JsonArray widgets)
            {
                foreach (var options in widgets.OfType<JsonObject>().Select(w => w["query"]).OfType<JsonObject>()
                             .Select(q => q["options"]).OfType<JsonObject>())
                {
                    options.Remove("workspaces");
                }

                foreach (var query in widgets.OfType<JsonObject>().Select(w => w["query"]).OfType<JsonObject>()
                             .Where(q => q["saved"] is not null))
                {
                    // A link to a skipped query becomes the copy the widget already holds.
                    query["saved"] = query["saved"] is JsonObject saved && saved["id"] is JsonValue v
                                     && v.TryGetValue<string>(out var savedId) && linked.TryGetValue(savedId, out var q)
                        ? new JsonObject { ["id"] = q.Input.Id, ["name"] = q.Input.Name }
                        : null;
                }
            }

            doc["origin"] = JsonSerializer.SerializeToNode(
                new SolutionOrigin(m.Id, m.SolutionVersion, itemId, sha, SolutionHash.Workbook(doc)), JsonFileStore.Options);
            if (WorkbookService.Check(doc) is { } problem)
            {
                throw Refused(WorkbookKind, itemId, problem);
            }

            workbooks.Add(new WorkbookPlan(itemId, doc));
        }

        return (queries, workbooks);
    }

    private async Task<(JsonNode? Node, string Sha256)> FetchJsonAsync(IndexEntry entry, string path, CancellationToken ct)
    {
        var file = entry.Files.First(f => f.Path == path);
        var bytes = await FetchFileAsync(entry, file, ct);
        try
        {
            return (JsonNode.Parse(bytes), file.Sha256);
        }
        catch (JsonException)
        {
            return (null, file.Sha256);
        }
    }

    private static SolutionRejectedException Refused(string kind, string itemId, string problem) =>
        new($"The {kind} {itemId} can't be installed. {problem}");

    /// <summary>Deletes what an install wrote; a delete that fails is logged so the install's own error is the one thrown.</summary>
    private async Task RollBackAsync(List<string> queries, List<string> workbooks)
    {
        foreach (var (kind, id) in queries.Select(q => (QueryKind, q)).Concat(workbooks.Select(w => (WorkbookKind, w))))
        {
            try
            {
                await (kind == QueryKind
                    ? _library.DeleteAsync(id, CancellationToken.None)
                    : _workbooks.DeleteAsync(id, CancellationToken.None));
            }
            catch (Exception e) when (e is not OperationCanceledException)
            {
                _log.LogWarning(e, "The installed {Kind} {Id} could not be removed after a failed install.", kind, id);
            }
        }
    }

    private static bool IsModified(SavedQuery q) => SolutionHash.Query(InputOf(q)) != q.Origin?.ContentHash;

    private static bool IsModified(JsonObject wb) => SolutionHash.Workbook(wb) != OriginOf(wb)?.ContentHash;

    private static SavedQueryInput InputOf(SavedQuery q) => new(q.Id, q.Name, q.Folder, q.Source, q.Text, q.Parameters, q.Options);

    private static SolutionOrigin? OriginOf(JsonObject wb)
    {
        try
        {
            return wb["origin"]?.Deserialize<SolutionOrigin>(JsonFileStore.Options);
        }
        catch (JsonException)
        {
            return null;
        }
    }

    /// <summary>The installed solution's snapshot, or for one installed before snapshots were kept, a manifest made from what
    /// <c>solutions.json</c> has: its id as the name and its installed items as the content.</summary>
    private static SolutionManifest ManifestOf(InstalledSolution s) => s.Manifest ?? new SolutionManifest(1, s.Id, s.Id,
        s.SolutionVersion, "", "", "community", [], [], "0.0.0", null, new SolutionContent(
            [.. s.Items.Where(i => i.Kind == QueryKind).Select(i => i.ItemId)],
            [.. s.Items.Where(i => i.Kind == WorkbookKind).Select(i => i.ItemId)], []));

    private bool Compatible(SolutionManifest m)
    {
        var running = UpdateCheck.VersionOf(appVersion);
        return running is null || UpdateCheck.VersionOf(m.MinAppVersion) <= running;
    }

    /// <summary>The installed solutions; a <c>solutions.json</c> that isn't JSON or isn't the expected shape is moved aside and
    /// read as empty.</summary>
    private async Task<IReadOnlyList<InstalledSolution>> ReadInstalledAsync(CancellationToken ct)
    {
        var read = await store.ReadAsync<InstalledDoc?>(InstalledPath, null, ct);
        if (read.Corrupt)
        {
            _log.LogWarning("{File} could not be read; it was moved aside", InstalledPath);
        }

        if (read.Value is null)
        {
            return [];
        }

        if (read.Value is { Version: 1, Installed: not null } doc && doc.Installed.All(s =>
                s is { Id: not null, SolutionVersion: not null, Items: not null }
                && (s.Manifest is null || HasNoNulls(new IndexEntry(s.Manifest, [])))
                && s.Items.All(i => i is { Kind: QueryKind or WorkbookKind, ItemId: not null, LibraryId: not null }
                                    && Guid.TryParseExact(i.LibraryId, "D", out _))))
        {
            return doc.Installed;
        }

        _log.LogWarning("{File} is not valid; it was moved aside", InstalledPath);
        store.MoveAside(InstalledPath);
        return [];
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
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
                _log.LogWarning(e, "The solutions cache could not be written.");
            }

            return new Loaded(Valid(index), fetched, false);
        }
        catch (Exception e) when (e is HttpRequestException or IOException or InvalidDataException or JsonException
                                      || e is OperationCanceledException && !ct.IsCancellationRequested)
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

    private static bool IsValid(IndexEntry e)
    {
        // The index lists solution.json too (SolutionIndex.Build), but holds the manifest itself, so that file is never fetched.
        var files = e.Files.Where(f => f.Path != "solution.json").ToList();
        return SolutionRules.IsId(e.Manifest.Id) && SolutionRules.ManifestProblem(e.Manifest, e.Manifest.Id) is null
            && files.All(f => SolutionRules.FileProblem(f) is null)
            && files.Select(f => f.Path).Order(StringComparer.Ordinal)
                .SequenceEqual(SolutionRules.ExpectedFiles(e.Manifest).Order(StringComparer.Ordinal));
    }

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
        catch (Exception ex) when (ex is HttpRequestException or IOException
                                       || ex is OperationCanceledException && !ct.IsCancellationRequested)
        {
            _log.LogWarning(ex, "The solution file {Path} could not be fetched.", f.Path);
            throw new SolutionRejectedException(Unreachable);
        }

        return SolutionHash.Sha256(bytes) == f.Sha256 ? bytes : throw new SolutionRejectedException(Mismatch);
    }

    private Task<byte[]> GetBytesAsync(string url, long limit, CancellationToken ct) =>
        BoundedGet.BytesAsync(http, url, limit, ReadTimeout, ct);
}
