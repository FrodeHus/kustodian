using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Kustodian.Storage;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

namespace Kustodian.Library;

/// <summary>A parameter of a saved query. <see cref="Type"/> is <c>text</c>, <c>number</c>, <c>timespan</c>, <c>datetime</c> or
/// <c>list</c>; <see cref="Choices"/> are the values it may take, when it has a fixed set.</summary>
public sealed record ParameterDef(string Name, string Type, string Value, bool Required, IReadOnlyList<string>? Choices);

/// <summary>A query in the library. <see cref="Id"/> is a GUID and the file name (<c>saved/&lt;id&gt;.json</c>);
/// <see cref="Folder"/> is one level or null.</summary>
public sealed record SavedQuery(int Version, string Id, string Name, string? Folder, string Source, string Text,
    IReadOnlyList<ParameterDef> Parameters, DateTimeOffset CreatedAt, DateTimeOffset ModifiedAt);

/// <summary>What the UI sends to save a query: a null <see cref="Id"/> creates, any other updates.</summary>
public sealed record SavedQueryInput(string? Id, string Name, string? Folder, string Source, string Text,
    IReadOnlyList<ParameterDef> Parameters)
{
    public static SavedQueryInput Default { get; } = new(null, "", null, "graph", "", []);
}

/// <summary>The library: its queries by name, its folders sorted, and how many files could not be read (they were moved aside).</summary>
public sealed record LibraryList(IReadOnlyList<SavedQuery> Queries, IReadOnlyList<string> Folders, int Skipped);

/// <summary>A query that was refused; the message says what is wrong, as the user is told it.</summary>
public sealed class LibraryRejectedException(string message) : Exception(message);

/// <summary>
/// Owns <c>saved/</c>: one JSON file per query, <c>saved/&lt;id&gt;.json</c>. One gate serialises every read and write of the
/// folder. A file that can't be read (not JSON, the wrong shape, or not the query its name says) is moved aside as
/// <c>*.corrupt</c> and counted in <see cref="LibraryList.Skipped"/>; the others are listed. Fields missing from a file take
/// their defaults (<see cref="JsonDefaults.Fill"/>), the query's and each parameter's.
/// </summary>
public sealed class LibraryService(JsonFileStore store, TimeProvider time, ILogger<LibraryService>? logger = null)
{
    public const string Folder = "saved";
    public const int MaxNameLength = 200;
    public const int MaxFolderLength = 80;
    public const int MaxTextBytes = 1 << 20;

    private static readonly string[] ParameterTypes = ["text", "number", "timespan", "datetime", "list"];

    private static readonly SavedQuery DefaultQuery = new(1, "", "", null, "graph", "", [], default, default);
    private static readonly ParameterDef DefaultParameter = new("", "text", "", false, null);

    private readonly SemaphoreSlim _gate = new(1, 1);
    private readonly ILogger<LibraryService> _log = logger ?? NullLogger<LibraryService>.Instance;

    public async Task<LibraryList> ListAsync(CancellationToken ct = default)
    {
        await _gate.WaitAsync(ct);
        try
        {
            var queries = new List<SavedQuery>();
            var skipped = 0;
            foreach (var file in Files())
            {
                if (await ReadAsync(file, ct) is { } query)
                {
                    queries.Add(query);
                }
                else
                {
                    skipped++;
                }
            }

            var folders = queries.Select(q => q.Folder).OfType<string>().Distinct(StringComparer.Ordinal)
                .Order(StringComparer.OrdinalIgnoreCase).ThenBy(f => f, StringComparer.Ordinal).ToList();
            var sorted = queries.OrderBy(q => q.Name, StringComparer.OrdinalIgnoreCase).ThenBy(q => q.Id, StringComparer.Ordinal).ToList();
            return new LibraryList(sorted, folders, skipped);
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>Saves <paramref name="input"/>: a new query when its Id is null, otherwise the query with that Id is replaced,
    /// keeping its <see cref="SavedQuery.CreatedAt"/> (a query whose file is gone is created again under the same Id).
    /// <see cref="SavedQuery.ModifiedAt"/> is now. Throws <see cref="LibraryRejectedException"/> for a value that isn't allowed,
    /// and writes nothing then.</summary>
    public async Task<SavedQuery> SaveAsync(SavedQueryInput input, CancellationToken ct = default)
    {
        var id = input.Id is null ? Guid.NewGuid().ToString("D") : NormalizeId(input.Id);
        if (Problem(input) is { } problem)
        {
            throw new LibraryRejectedException(problem);
        }

        await _gate.WaitAsync(ct);
        try
        {
            var now = time.GetUtcNow();
            var existing = input.Id is null ? null : await ReadAsync(RelativePath(id), ct);
            var saved = new SavedQuery(1, id, input.Name, input.Folder, input.Source, input.Text, input.Parameters.ToList(),
                existing?.CreatedAt ?? now, now);
            await store.WriteAsync(RelativePath(id), saved, ct);
            return saved;
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>Removes the query; nothing happens when there is none.</summary>
    public async Task DeleteAsync(string id, CancellationToken ct = default)
    {
        var path = Path.Combine(store.Root, RelativePath(NormalizeId(id)));
        await _gate.WaitAsync(ct);
        try
        {
            File.Delete(path);
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>Reads a bridge payload as a <see cref="SavedQueryInput"/>: fields missing from it (or null) take their defaults,
    /// and so do those of each parameter. Null when it isn't an object or a value has the wrong type.</summary>
    public static SavedQueryInput? ReadInput(JsonNode? node, JsonSerializerOptions options)
    {
        if (node is not JsonObject value)
        {
            return null;
        }

        try
        {
            var inputDefaults = JsonSerializer.SerializeToNode(SavedQueryInput.Default, options)!.AsObject();
            var parameterDefaults = JsonSerializer.SerializeToNode(DefaultParameter, options)!.AsObject();
            return JsonDefaults.FillElements(JsonDefaults.Fill(value, inputDefaults), nameof(SavedQueryInput.Parameters), parameterDefaults)
                .Deserialize<SavedQueryInput>(options);
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private static string RelativePath(string id) => Path.Combine(Folder, id + ".json");

    private List<string> Files()
    {
        var directory = Path.Combine(store.Root, Folder);
        return Directory.Exists(directory)
            ? Directory.EnumerateFiles(directory, "*.json").Select(f => Path.Combine(Folder, Path.GetFileName(f)))
                .Order(StringComparer.Ordinal).ToList()
            : [];
    }

    /// <summary>The query in the file, or null when the file is missing or can't be read (then it is moved aside).</summary>
    private async Task<SavedQuery?> ReadAsync(string relativePath, CancellationToken ct)
    {
        var read = await store.ReadAsync<JsonNode?>(relativePath, null, ct);
        if (read.Corrupt)
        {
            _log.LogWarning("The saved query {File} could not be read; it was moved aside", relativePath);
            return null;
        }

        if (read.Value is null)
        {
            return null;
        }

        var expectedId = Path.GetFileNameWithoutExtension(relativePath);
        if (Complete(read.Value) is { Version: 1 } query && query.Id == expectedId && Problem(ToInput(query)) is null)
        {
            return query;
        }

        _log.LogWarning("The saved query {File} is not valid; it was moved aside", relativePath);
        store.MoveAside(relativePath);
        return null;
    }

    private static SavedQuery? Complete(JsonNode node)
    {
        if (node is not JsonObject value)
        {
            return null;
        }

        try
        {
            var queryDefaults = JsonSerializer.SerializeToNode(DefaultQuery, JsonFileStore.Options)!.AsObject();
            var parameterDefaults = JsonSerializer.SerializeToNode(DefaultParameter, JsonFileStore.Options)!.AsObject();
            return JsonDefaults.FillElements(JsonDefaults.Fill(value, queryDefaults), nameof(SavedQuery.Parameters), parameterDefaults)
                .Deserialize<SavedQuery>(JsonFileStore.Options);
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private static SavedQueryInput ToInput(SavedQuery q) => new(q.Id, q.Name, q.Folder, q.Source, q.Text, q.Parameters);

    private static string NormalizeId(string id) =>
        Guid.TryParseExact(id, "D", out var guid) ? guid.ToString("D") : throw new LibraryRejectedException("The saved query id isn't valid.");

    /// <summary>What is wrong with <paramref name="input"/>, or null when nothing is. Parts missing from the JSON arrive as null,
    /// whatever the types say.</summary>
    private static string? Problem(SavedQueryInput input)
    {
        if (input.Parameters is null || input.Name is null || input.Source is null || input.Text is null)
        {
            return "The saved query is incomplete.";
        }

        if (string.IsNullOrWhiteSpace(input.Name) || input.Name.Length > MaxNameLength)
        {
            return $"The name must be 1 to {MaxNameLength} characters.";
        }

        if (input.Folder is { } folder && (folder.Length is 0 or > MaxFolderLength || folder.Contains('/')))
        {
            return $"The folder must be 1 to {MaxFolderLength} characters and have no /.";
        }

        if (string.IsNullOrWhiteSpace(input.Source))
        {
            return "The saved query needs a source.";
        }

        if (Encoding.UTF8.GetByteCount(input.Text) > MaxTextBytes)
        {
            return "The query text can be at most 1 MB.";
        }

        foreach (var parameter in input.Parameters)
        {
            if (parameter is null || parameter.Name is null || parameter.Value is null || string.IsNullOrWhiteSpace(parameter.Name))
            {
                return "Every parameter needs a name.";
            }

            if (!ParameterTypes.Contains(parameter.Type, StringComparer.Ordinal))
            {
                return $"Parameter {parameter.Name} must be of type text, number, timespan, datetime or list.";
            }
        }

        return null;
    }
}
