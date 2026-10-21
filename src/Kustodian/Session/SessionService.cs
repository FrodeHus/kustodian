using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Kustodian.Library;
using Kustodian.Storage;

namespace Kustodian.Sessions;

/// <summary>A tab as the session keeps it. <see cref="SavedId"/> is the library query it was opened from, if any;
/// <see cref="Dirty"/> says its text differs from the saved one.</summary>
public sealed record SessionTab(string Id, string Source, string Title, string Text, bool Dirty, string? SavedId,
    IReadOnlyList<ParameterDef> Parameters);

/// <summary>The open tabs, which one is active, so the next start can restore them.</summary>
public sealed record Session(int Version, string? ActiveId, IReadOnlyList<SessionTab> Tabs)
{
    public static Session Empty { get; } = new(1, null, []);
}

/// <summary>
/// Owns <c>session.json</c>. Fields missing from the file take their defaults, in each tab and each tab's parameters too, so
/// a file written by an older version restores. A file that can't be read is moved aside and reads as an empty session, marked
/// corrupt. Saving drops tabs over the caps (<see cref="MaxTabs"/> tabs, <see cref="MaxTextBytes"/> of text each) and says how
/// many it dropped.
/// </summary>
public sealed class SessionService(JsonFileStore store)
{
    public const string FileName = "session.json";
    public const int MaxTabs = 50;
    public const int MaxTextBytes = 1 << 20;

    private static readonly SessionTab DefaultTab = new("", "graph", "", "", false, null, []);
    private static readonly ParameterDef DefaultParameter = new("", "text", "", false, null);

    private readonly UserDataFile<Session> _file = new(store, FileName, () => Session.Empty, IsValid, FillElements);

    public Task<UserDataRead<Session>> GetAsync(CancellationToken ct = default) => _file.ReadAsync(ct);

    /// <summary>Writes <paramref name="session"/> as version 1 without the tabs over a cap, and returns how many it left out.
    /// A tab over the text cap is dropped; then the tabs after the first <see cref="MaxTabs"/> are. When the active tab is
    /// dropped nothing is active.</summary>
    public async Task<int> SaveAsync(Session session, CancellationToken ct = default)
    {
        var kept = session.Tabs.Where(t => Encoding.UTF8.GetByteCount(t.Text) <= MaxTextBytes).Take(MaxTabs).ToList();
        var activeId = kept.Any(t => t.Id == session.ActiveId) ? session.ActiveId : null;
        await _file.WriteAsync(new Session(1, activeId, kept), ct);
        return session.Tabs.Count - kept.Count;
    }

    /// <summary>Reads a bridge payload as a <see cref="Session"/>: fields missing from it (or null) take their defaults, in each
    /// tab and parameter too. Null when it isn't an object, has the wrong shape, or a tab or parameter is missing its parts.</summary>
    public static Session? ReadInput(JsonNode? node, JsonSerializerOptions options)
    {
        if (node is not JsonObject value)
        {
            return null;
        }

        try
        {
            var defaults = JsonSerializer.SerializeToNode(Session.Empty, options)!.AsObject();
            var session = FillElements(JsonDefaults.Fill(value, defaults), options).Deserialize<Session>(options);
            return session is not null && IsValid(session) ? session : null;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private static JsonObject FillElements(JsonObject filled) => FillElements(filled, JsonFileStore.Options);

    private static JsonObject FillElements(JsonObject filled, JsonSerializerOptions options)
    {
        var tabDefaults = JsonSerializer.SerializeToNode(DefaultTab, options)!.AsObject();
        var parameterDefaults = JsonSerializer.SerializeToNode(DefaultParameter, options)!.AsObject();
        var withTabs = JsonDefaults.FillElements(filled, nameof(Session.Tabs), tabDefaults);
        var key = withTabs.Select(p => p.Key).FirstOrDefault(k => string.Equals(k, nameof(Session.Tabs), StringComparison.OrdinalIgnoreCase));
        if (key is not null && withTabs[key] is JsonArray tabs)
        {
            for (var i = 0; i < tabs.Count; i++)
            {
                if (tabs[i] is JsonObject tab)
                {
                    tabs[i] = JsonDefaults.FillElements(tab, nameof(SessionTab.Parameters), parameterDefaults);
                }
            }
        }

        return withTabs;
    }

    /// <summary>Version 1 with every tab and parameter present (a null in an array arrives as null, whatever the types say).</summary>
    private static bool IsValid(Session session) =>
        session.Version == 1 && session.Tabs is not null
        && session.Tabs.All(t => t is { Id: not null, Source: not null, Title: not null, Text: not null, Parameters: not null }
            && t.Parameters.All(p => p is { Name: not null, Type: not null, Value: not null }));
}
