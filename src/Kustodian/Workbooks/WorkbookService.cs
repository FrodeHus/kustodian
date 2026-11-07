using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Kustodian.Library;
using Kustodian.Storage;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

namespace Kustodian.Workbooks;

/// <summary>One workbook in the list: <see cref="Widgets"/> is how many it holds.</summary>
public sealed record WorkbookSummary(string Id, string Name, string? Folder, DateTimeOffset ModifiedAt, int Widgets);

/// <summary>The workbooks by name, the folders sorted, and how many files could not be read (they were moved aside).</summary>
public sealed record WorkbookList(IReadOnlyList<WorkbookSummary> Workbooks, IReadOnlyList<string> Folders, int Skipped);

/// <summary>A workbook that was refused; the message says what is wrong, as the user is told it.</summary>
public sealed class WorkbookRejectedException(string message) : Exception(message);

/// <summary>
/// Owns <c>workbooks/</c> (one file per workbook, <c>&lt;id&gt;.json</c>) and <c>workbook-values/</c> (the values last used,
/// same file name). A workbook is an opaque <see cref="JsonObject"/> to the host: only <c>kind</c>, <c>version</c>, <c>id</c>,
/// <c>name</c>, <c>folder</c>, the number of <c>widgets</c> and the size are checked, every other field is kept as it came.
/// One gate serialises every read and write. A file that can't be read (not JSON, invalid, or not the workbook its name says)
/// is moved aside as <c>*.corrupt</c> and counted in <see cref="WorkbookList.Skipped"/>.
/// </summary>
public sealed class WorkbookService(JsonFileStore store, TimeProvider time, ILogger<WorkbookService>? logger = null)
{
    public const string Folder = "workbooks";
    public const string ValuesFolder = "workbook-values";
    public const int MaxBytes = 2 << 20;
    public const int MaxWidgets = 100;

    private readonly SemaphoreSlim _gate = new(1, 1);
    private readonly ILogger<WorkbookService> _log = logger ?? NullLogger<WorkbookService>.Instance;

    public async Task<WorkbookList> ListAsync(CancellationToken ct = default)
    {
        await _gate.WaitAsync(ct);
        try
        {
            var workbooks = new List<WorkbookSummary>();
            var skipped = 0;
            var directory = Path.Combine(store.Root, Folder);
            var files = Directory.Exists(directory)
                ? Directory.EnumerateFiles(directory, "*.json").Select(f => Path.Combine(Folder, Path.GetFileName(f)))
                    .Order(StringComparer.Ordinal).ToList()
                : [];
            foreach (var file in files)
            {
                if (await ReadAsync(file, ct) is { } doc)
                {
                    workbooks.Add(new WorkbookSummary(doc["id"]!.GetValue<string>(), doc["name"]!.GetValue<string>(),
                        doc["folder"]?.GetValue<string>(), ModifiedAt(doc), doc["widgets"]!.AsArray().Count));
                }
                else
                {
                    skipped++;
                }
            }

            var folders = workbooks.Select(w => w.Folder).OfType<string>().Distinct(StringComparer.Ordinal)
                .Order(StringComparer.OrdinalIgnoreCase).ThenBy(f => f, StringComparer.Ordinal).ToList();
            var sorted = workbooks.OrderBy(w => w.Name, StringComparer.OrdinalIgnoreCase).ThenBy(w => w.Id, StringComparer.Ordinal).ToList();
            return new WorkbookList(sorted, folders, skipped);
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>The workbook with that id, or null when there is none or its file can't be read (then it is moved aside).</summary>
    public async Task<JsonObject?> GetAsync(string id, CancellationToken ct = default)
    {
        var path = RelativePath(Folder, NormalizeId(id));
        await _gate.WaitAsync(ct);
        try
        {
            return await ReadAsync(path, ct);
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>What is wrong with an imported workbook, or null. Reads and writes nothing.</summary>
    public static string? Check(JsonObject workbook) => Problem(workbook)
        ?? (Encoding.UTF8.GetByteCount(workbook.ToJsonString()) > MaxBytes ? "The workbook can be at most 2 MB." : null);

    /// <summary>Writes <paramref name="workbook"/> with <c>modifiedAt</c> set to now and returns what was written; a workbook
    /// without <c>origin</c> keeps the existing file's. Throws <see cref="WorkbookRejectedException"/> for a value that isn't
    /// allowed, and writes nothing then.</summary>
    public Task<JsonObject> SaveAsync(JsonObject workbook, CancellationToken ct = default) => SaveAsync(workbook, true, ct);

    /// <summary>As <see cref="SaveAsync(JsonObject, CancellationToken)"/>; with <paramref name="keepOrigin"/> false the
    /// workbook's <c>origin</c> is written as it is, or not at all.</summary>
    internal async Task<JsonObject> SaveAsync(JsonObject workbook, bool keepOrigin, CancellationToken ct)
    {
        if (Problem(workbook) is { } problem)
        {
            throw new WorkbookRejectedException(problem);
        }

        var saved = (JsonObject)workbook.DeepClone();
        saved["id"] = NormalizeId(saved["id"]!.GetValue<string>());
        saved["modifiedAt"] = time.GetUtcNow().ToString("O", CultureInfo.InvariantCulture);
        await _gate.WaitAsync(ct);
        try
        {
            var path = RelativePath(Folder, saved["id"]!.GetValue<string>());
            if (keepOrigin && saved["origin"] is null && await ReadAsync(path, ct) is { } existing && existing["origin"] is { } origin)
            {
                saved["origin"] = origin.DeepClone();
            }

            if (Encoding.UTF8.GetByteCount(saved.ToJsonString()) > MaxBytes)
            {
                throw new WorkbookRejectedException("The workbook can be at most 2 MB.");
            }

            await store.WriteAsync(path, saved, ct);
            return saved;
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>Removes the workbook and its values; nothing happens when there are none.</summary>
    public async Task DeleteAsync(string id, CancellationToken ct = default)
    {
        id = NormalizeId(id);
        await _gate.WaitAsync(ct);
        try
        {
            // File.Delete throws when the folder itself is missing.
            foreach (var path in new[] { RelativePath(Folder, id), RelativePath(ValuesFolder, id) }.Select(p => Path.Combine(store.Root, p)))
            {
                if (File.Exists(path))
                {
                    File.Delete(path);
                }
            }
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>The values last used in the workbook, an empty object when there are none (or the file was unreadable).</summary>
    public async Task<JsonObject> GetValuesAsync(string id, CancellationToken ct = default)
    {
        var path = RelativePath(ValuesFolder, NormalizeId(id));
        await _gate.WaitAsync(ct);
        try
        {
            var read = await store.ReadAsync<JsonObject>(path, [], ct);
            return read.Value;
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task SaveValuesAsync(string id, JsonObject values, CancellationToken ct = default)
    {
        var path = RelativePath(ValuesFolder, NormalizeId(id));
        await _gate.WaitAsync(ct);
        try
        {
            await store.WriteAsync(path, values, ct);
        }
        finally
        {
            _gate.Release();
        }
    }

    private static string RelativePath(string folder, string id) => Path.Combine(folder, id + ".json");

    private static DateTimeOffset ModifiedAt(JsonObject doc) =>
        doc["modifiedAt"] is JsonValue { } v && v.TryGetValue<string>(out var s)
            && DateTimeOffset.TryParse(s, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var at)
            ? at
            : default;

    private async Task<JsonObject?> ReadAsync(string relativePath, CancellationToken ct)
    {
        var read = await store.ReadAsync<JsonNode?>(relativePath, null, ct);
        if (read.Corrupt)
        {
            _log.LogWarning("The workbook {File} could not be read; it was moved aside", relativePath);
            return null;
        }

        if (read.Value is null)
        {
            return null;
        }

        if (read.Value is JsonObject doc && Problem(doc) is null
            && doc["id"]!.GetValue<string>() == Path.GetFileNameWithoutExtension(relativePath))
        {
            return doc;
        }

        _log.LogWarning("The workbook {File} is not valid; it was moved aside", relativePath);
        store.MoveAside(relativePath);
        return null;
    }

    private static string NormalizeId(string id) =>
        Guid.TryParseExact(id, "D", out var guid) ? guid.ToString("D") : throw new WorkbookRejectedException("The workbook id isn't valid.");

    private static string? Str(JsonObject doc, string key) =>
        doc[key] is JsonValue v && v.TryGetValue<string>(out var s) ? s : null;

    /// <summary>What is wrong with <paramref name="doc"/>, or null when nothing is. Size is checked on save, after
    /// <c>modifiedAt</c> is set.</summary>
    private static string? Problem(JsonObject doc)
    {
        if (Str(doc, "kind") != "kustodian.workbook")
        {
            return "This isn't a Kustodian workbook.";
        }

        if (doc["version"] is not JsonValue version || !version.TryGetValue<int>(out var number) || number != 1)
        {
            return "This workbook needs a newer Kustodian.";
        }

        if (Str(doc, "id") is not { } id || !Guid.TryParseExact(id, "D", out _))
        {
            return "The workbook id isn't valid.";
        }

        if (Str(doc, "name") is not { } name || string.IsNullOrWhiteSpace(name) || name.Length > LibraryService.MaxNameLength)
        {
            return $"The name must be 1 to {LibraryService.MaxNameLength} characters.";
        }

        if (doc["folder"] is not null && (Str(doc, "folder") is not { } folder
            || folder.Length is 0 or > LibraryService.MaxFolderLength || folder.Contains('/')))
        {
            return $"The folder must be 1 to {LibraryService.MaxFolderLength} characters and have no /.";
        }

        if (doc["widgets"] is not JsonArray widgets)
        {
            return "The workbook needs a list of widgets.";
        }

        return widgets.Count > MaxWidgets ? $"A workbook can have at most {MaxWidgets} widgets." : null;
    }
}
