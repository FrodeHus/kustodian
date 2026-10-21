using System.Reflection;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Kustodian.Library;
using Kustodian.Storage;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

namespace Kustodian.Snippets;

/// <summary>A snippet: reusable query text. <see cref="Id"/> is a GUID (the file name of a user snippet); built-in snippets
/// ship with the app and have fixed ids. <see cref="Parameters"/> declare the <c>{name}</c> placeholders in the text.</summary>
public sealed record Snippet(string Id, string Source, string Name, string Description, string Text, bool BuiltIn, string? Group,
    IReadOnlyList<ParameterDef> Parameters);

/// <summary>What the UI sends to save a snippet: a null <see cref="Id"/> creates, any other updates.</summary>
public sealed record SnippetInput(string? Id, string Source, string Name, string Description, string Text, string? Group,
    IReadOnlyList<ParameterDef> Parameters)
{
    public static SnippetInput Default { get; } = new(null, "graph", "", "", "", null, []);
}

/// <summary>A snippet that was refused; the message says what is wrong, as the user is told it.</summary>
public sealed class SnippetRejectedException(string message) : Exception(message);

/// <summary>
/// The snippet library: the built-in snippets (embedded, never changed or deleted) and the user's own, one JSON file each,
/// <c>snippets/&lt;id&gt;.json</c>. One gate serialises every read and write of the folder. A user file that can't be read is
/// moved aside as <c>*.corrupt</c> and left out. Fields missing from a file take their defaults, the snippet's and each
/// parameter's.
/// </summary>
public sealed class SnippetService(JsonFileStore store, ILogger<SnippetService>? logger = null)
{
    public const string Folder = "snippets";
    public const int MaxNameLength = 200;
    public const int MaxTextBytes = 1 << 20;

    private const string BuiltinResource = "builtin-snippets.json";

    private static readonly Lazy<IReadOnlyList<Snippet>> Builtin = new(LoadBuiltin);
    private static readonly SnippetFile DefaultFile = new(1, "", "graph", "", "", "", null, []);
    private static readonly ParameterDef DefaultParameter = new("", "text", "", false, null);

    private readonly SemaphoreSlim _gate = new(1, 1);
    private readonly ILogger<SnippetService> _log = logger ?? NullLogger<SnippetService>.Instance;

    private sealed record SnippetFile(int Version, string Id, string Source, string Name, string Description, string Text,
        string? Group, IReadOnlyList<ParameterDef> Parameters);

    private sealed record BuiltinFile(int Version, IReadOnlyList<SnippetInput> Snippets);

    /// <summary>The built-in snippets in their order, then the user's by name.</summary>
    public async Task<IReadOnlyList<Snippet>> ListAsync(CancellationToken ct = default)
    {
        await _gate.WaitAsync(ct);
        try
        {
            var user = new List<Snippet>();
            foreach (var file in Files())
            {
                if (await ReadAsync(file, ct) is { } snippet)
                {
                    user.Add(snippet);
                }
            }

            return [.. Builtin.Value, .. user.OrderBy(s => s.Name, StringComparer.OrdinalIgnoreCase).ThenBy(s => s.Id, StringComparer.Ordinal)];
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>Saves <paramref name="input"/>: a new snippet when its Id is null, otherwise the user snippet with that Id is
    /// replaced (one whose file is gone is created again under the same Id). Throws <see cref="SnippetRejectedException"/> for
    /// a value that isn't allowed, or for a built-in snippet's Id, and writes nothing then.</summary>
    public async Task<Snippet> SaveAsync(SnippetInput input, CancellationToken ct = default)
    {
        var id = input.Id is null ? Guid.NewGuid().ToString("D") : NormalizeId(input.Id);
        if (IsBuiltin(id))
        {
            throw new SnippetRejectedException("Built-in snippets can't be changed. Save a copy instead.");
        }

        if (Problem(input) is { } problem)
        {
            throw new SnippetRejectedException(problem);
        }

        await _gate.WaitAsync(ct);
        try
        {
            var file = new SnippetFile(1, id, input.Source, input.Name, input.Description, input.Text, input.Group, input.Parameters.ToList());
            await store.WriteAsync(RelativePath(id), file, ct);
            return ToSnippet(file);
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>Removes the user snippet; nothing happens when there is none. A built-in snippet can't be deleted.</summary>
    public async Task DeleteAsync(string id, CancellationToken ct = default)
    {
        var normalized = NormalizeId(id);
        if (IsBuiltin(normalized))
        {
            throw new SnippetRejectedException("Built-in snippets can't be deleted.");
        }

        var path = Path.Combine(store.Root, RelativePath(normalized));
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

    /// <summary>Reads a bridge payload as a <see cref="SnippetInput"/>: fields missing from it (or null) take their defaults,
    /// and so do those of each parameter. Null when it isn't an object or a value has the wrong type.</summary>
    public static SnippetInput? ReadInput(JsonNode? node, JsonSerializerOptions options)
    {
        if (node is not JsonObject value)
        {
            return null;
        }

        try
        {
            var inputDefaults = JsonSerializer.SerializeToNode(SnippetInput.Default, options)!.AsObject();
            var parameterDefaults = JsonSerializer.SerializeToNode(DefaultParameter, options)!.AsObject();
            return JsonDefaults.FillElements(JsonDefaults.Fill(value, inputDefaults), nameof(SnippetInput.Parameters), parameterDefaults)
                .Deserialize<SnippetInput>(options);
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private static bool IsBuiltin(string id) => Builtin.Value.Any(s => s.Id == id);

    private static string RelativePath(string id) => Path.Combine(Folder, id + ".json");

    private static Snippet ToSnippet(SnippetFile f) => new(f.Id, f.Source, f.Name, f.Description, f.Text, false, f.Group, f.Parameters);

    private List<string> Files()
    {
        var directory = Path.Combine(store.Root, Folder);
        return Directory.Exists(directory)
            ? Directory.EnumerateFiles(directory, "*.json").Select(f => Path.Combine(Folder, Path.GetFileName(f)))
                .Order(StringComparer.Ordinal).ToList()
            : [];
    }

    /// <summary>The snippet in the file, or null when the file is missing or can't be read (then it is moved aside).</summary>
    private async Task<Snippet?> ReadAsync(string relativePath, CancellationToken ct)
    {
        var read = await store.ReadAsync<JsonNode?>(relativePath, null, ct);
        if (read.Corrupt)
        {
            _log.LogWarning("The snippet {File} could not be read; it was moved aside", relativePath);
            return null;
        }

        if (read.Value is null)
        {
            return null;
        }

        var expectedId = Path.GetFileNameWithoutExtension(relativePath);
        if (Complete(read.Value) is { Version: 1 } file && file.Id == expectedId && !IsBuiltin(file.Id) && Problem(ToInput(file)) is null)
        {
            return ToSnippet(file);
        }

        _log.LogWarning("The snippet {File} is not valid; it was moved aside", relativePath);
        store.MoveAside(relativePath);
        return null;
    }

    private static SnippetFile? Complete(JsonNode node)
    {
        if (node is not JsonObject value)
        {
            return null;
        }

        try
        {
            var fileDefaults = JsonSerializer.SerializeToNode(DefaultFile, JsonFileStore.Options)!.AsObject();
            var parameterDefaults = JsonSerializer.SerializeToNode(DefaultParameter, JsonFileStore.Options)!.AsObject();
            return JsonDefaults.FillElements(JsonDefaults.Fill(value, fileDefaults), nameof(SnippetFile.Parameters), parameterDefaults)
                .Deserialize<SnippetFile>(JsonFileStore.Options);
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private static SnippetInput ToInput(SnippetFile f) => new(f.Id, f.Source, f.Name, f.Description, f.Text, f.Group, f.Parameters);

    private static string NormalizeId(string id) =>
        Guid.TryParseExact(id, "D", out var guid) ? guid.ToString("D") : throw new SnippetRejectedException("The snippet id isn't valid.");

    /// <summary>What is wrong with <paramref name="input"/>, or null when nothing is. Parts missing from the JSON arrive as null,
    /// whatever the types say.</summary>
    private static string? Problem(SnippetInput input)
    {
        if (input.Parameters is null || input.Name is null || input.Source is null || input.Text is null || input.Description is null)
        {
            return "The snippet is incomplete.";
        }

        if (string.IsNullOrWhiteSpace(input.Name) || input.Name.Length > MaxNameLength)
        {
            return $"The name must be 1 to {MaxNameLength} characters.";
        }

        if (string.IsNullOrWhiteSpace(input.Source))
        {
            return "The snippet needs a source.";
        }

        if (input.Group is { } group && string.IsNullOrWhiteSpace(group))
        {
            return "The group can't be blank.";
        }

        if (Encoding.UTF8.GetByteCount(input.Text) > MaxTextBytes)
        {
            return "The snippet text can be at most 1 MB.";
        }

        return LibraryService.ParameterProblem(input.Parameters);
    }

    private static IReadOnlyList<Snippet> LoadBuiltin()
    {
        using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(BuiltinResource)
            ?? throw new InvalidOperationException("The built-in snippets are not embedded.");
        var file = JsonSerializer.Deserialize<BuiltinFile>(stream, JsonFileStore.Options)
            ?? throw new InvalidOperationException("The built-in snippets can't be read.");
        return file.Snippets.Select(s => new Snippet(s.Id!, s.Source, s.Name, s.Description, s.Text, true, s.Group, s.Parameters)).ToList();
    }
}
