using System.Text.Json;

namespace Kustodian.Sources.Arg;

/// <summary>A column of a Resource Graph table, its type as the engine names it.</summary>
public sealed record ArgColumn(string Name, string Type);

/// <summary>A Resource Graph table, with its columns.</summary>
public sealed record ArgTable(string Name, string Description, IReadOnlyList<ArgColumn> Columns);

/// <summary>
/// The Resource Graph tables Microsoft documents, embedded as <c>arg-schema.json</c>, each with the common resource columns
/// (<c>properties</c>, <c>tags</c> and the other objects dynamic). The editor completes from it and the schema panel lists it;
/// which resource types an account has comes from <see cref="ArmDirectory.ResourceTypesAsync"/>.
/// </summary>
public static class BuiltInArgSchema
{
    private sealed record Document(DateTimeOffset DocumentedAt, List<ArgColumn> Columns, List<DocumentTable> Tables);

    private sealed record DocumentTable(string Name, string Description);

    private static readonly Lazy<(DateTimeOffset DocumentedAt, IReadOnlyList<ArgTable> Tables)> Loaded = new(Load);

    /// <summary>When Microsoft's table list was read.</summary>
    public static DateTimeOffset DocumentedAt => Loaded.Value.DocumentedAt;

    public static IReadOnlyList<ArgTable> Tables => Loaded.Value.Tables;

    private static (DateTimeOffset, IReadOnlyList<ArgTable>) Load()
    {
        using var stream = typeof(BuiltInArgSchema).Assembly.GetManifestResourceStream("arg-schema.json")
            ?? throw new InvalidOperationException("The embedded arg-schema.json is missing.");
        var document = JsonSerializer.Deserialize<Document>(stream, new JsonSerializerOptions(JsonSerializerDefaults.Web))
            ?? throw new InvalidOperationException("The embedded arg-schema.json is empty.");
        IReadOnlyList<ArgColumn> columns = [.. document.Columns];
        return (document.DocumentedAt, [.. document.Tables.Select(t => new ArgTable(t.Name, t.Description, columns))]);
    }
}
