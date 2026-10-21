using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Kustodian.Graph.Run;
using Kustodian.Library;
using Kustodian.Raw;
using Kustodian.Storage;

namespace Kustodian.Sessions;

/// <summary>A tab as the session keeps it. <see cref="SavedId"/> is the library query it was opened from, if any;
/// <see cref="Dirty"/> says its text differs from the saved one.
/// <see cref="FilePath"/> is the <c>.kql</c> file it was opened from or saved to, if any. <see cref="Raw"/> is a raw request
/// tab's version and headers (its text is the path); null for other tabs. <see cref="Options"/> are the tab's timespan or scope,
/// null for none.</summary>
public sealed record SessionTab(string Id, string Source, string Title, string Text, bool Dirty, string? SavedId,
    IReadOnlyList<ParameterDef> Parameters, string? FilePath = null, RawTabRequest? Raw = null, QueryOptions? Options = null);

/// <summary>A raw request tab's request: <see cref="Version"/> is <c>beta</c> or <c>v1.0</c>, or null for the settings'
/// default; <see cref="Headers"/> are in the order the user typed them, only those the raw tab could send.</summary>
public sealed record RawTabRequest(string? Version, IReadOnlyList<RawTabHeader> Headers);

public sealed record RawTabHeader(string Name, string Value);

/// <summary>The open tabs, which one is active, so the next start can restore them.</summary>
public sealed record Session(int Version, string? ActiveId, IReadOnlyList<SessionTab> Tabs)
{
    public static Session Empty { get; } = new(1, null, []);
}

/// <summary>
/// Owns <c>session.json</c>. Fields missing from the file take their defaults, in each tab and each tab's parameters and options
/// too (<see cref="QueryOptionsDefaults"/>; missing options are null), so
/// a file written by an older version restores. A file that can't be read is moved aside and reads as an empty session, marked
/// corrupt. Saving drops tabs over the caps (<see cref="MaxTabs"/> tabs, <see cref="MaxTextBytes"/> of text each) and says how
/// many it dropped. A raw tab's headers are written only when the raw tab could send them
/// (<see cref="RawRequestService.HeaderProblem"/>: never <c>Authorization</c>, <c>Host</c>, <c>Cookie</c>,
/// <c>Accept-Encoding</c>, a <c>Proxy-*</c>, hop-by-hop or content header, nor a name that isn't a token or a value with CR or
/// LF), at most
/// <see cref="RawRequestService.MaxHeaders"/> of them and <see cref="RawRequestService.MaxHeaderBytes"/> in all; an unknown
/// version is written as null.
/// </summary>
public sealed class SessionService(JsonFileStore store)
{
    public const string FileName = "session.json";
    public const int MaxTabs = 50;
    public const int MaxTextBytes = 1 << 20;

    private static readonly SessionTab DefaultTab = new("", "graph", "", "", false, null, []);
    private static readonly ParameterDef DefaultParameter = new("", "text", "", false, null);
    private static readonly RawTabRequest DefaultRaw = new(null, []);
    private static readonly RawTabHeader DefaultHeader = new("", "");
    private static readonly string[] RawVersions = ["beta", "v1.0"];

    private readonly UserDataFile<Session> _file = new(store, FileName, () => Session.Empty, IsValid, FillElements);

    public Task<UserDataRead<Session>> GetAsync(CancellationToken ct = default) => _file.ReadAsync(ct);

    /// <summary>Writes <paramref name="session"/> as version 1 without the tabs over a cap, and returns how many it left out.
    /// A tab over the text cap is dropped; then the tabs after the first <see cref="MaxTabs"/> are. When the active tab is
    /// dropped nothing is active.</summary>
    public async Task<int> SaveAsync(Session session, CancellationToken ct = default)
    {
        var kept = session.Tabs.Where(t => Encoding.UTF8.GetByteCount(t.Text) <= MaxTextBytes).Take(MaxTabs)
            .Select(t => t.Raw is null ? t : t with { Raw = Sendable(t.Raw) }).ToList();
        var activeId = kept.Any(t => t.Id == session.ActiveId) ? session.ActiveId : null;
        await _file.WriteAsync(new Session(1, activeId, kept), ct);
        return session.Tabs.Count - kept.Count;
    }

    /// <summary>The raw request with only the headers the raw tab could send, names trimmed as the page trims them when it
    /// sends, within the caps, in order; a header that would go over the size cap is left out and later smaller ones may still
    /// fit.</summary>
    private static RawTabRequest Sendable(RawTabRequest raw)
    {
        var headers = new List<RawTabHeader>();
        var total = 0;
        foreach (var header in raw.Headers)
        {
            if (headers.Count == RawRequestService.MaxHeaders)
            {
                break;
            }

            var name = header.Name.Trim();
            if (RawRequestService.HeaderProblem(name, header.Value) is not null
                || total + name.Length + header.Value.Length > RawRequestService.MaxHeaderBytes)
            {
                continue;
            }

            total += name.Length + header.Value.Length;
            headers.Add(header with { Name = name });
        }

        var version = raw.Version is not null && RawVersions.Contains(raw.Version, StringComparer.Ordinal) ? raw.Version : null;
        return new RawTabRequest(version, headers);
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
        var rawDefaults = JsonSerializer.SerializeToNode(DefaultRaw, options)!.AsObject();
        var headerDefaults = JsonSerializer.SerializeToNode(DefaultHeader, options)!.AsObject();
        var withTabs = JsonDefaults.FillElements(filled, nameof(Session.Tabs), tabDefaults);
        var key = withTabs.Select(p => p.Key).FirstOrDefault(k => string.Equals(k, nameof(Session.Tabs), StringComparison.OrdinalIgnoreCase));
        if (key is not null && withTabs[key] is JsonArray tabs)
        {
            for (var i = 0; i < tabs.Count; i++)
            {
                if (tabs[i] is JsonObject tab)
                {
                    var withParameters = JsonDefaults.FillElements(tab, nameof(SessionTab.Parameters), parameterDefaults);
                    // A raw tab's request (null for other tabs) and each of its headers take their defaults too.
                    var rawKey = withParameters.Select(p => p.Key).FirstOrDefault(k => string.Equals(k, nameof(SessionTab.Raw), StringComparison.OrdinalIgnoreCase));
                    if (rawKey is not null && withParameters[rawKey] is JsonObject raw)
                    {
                        withParameters[rawKey] = JsonDefaults.FillElements(JsonDefaults.Fill(raw, rawDefaults), nameof(RawTabRequest.Headers), headerDefaults);
                    }

                    // A tab's options (null when absent) and their scope take their defaults too.
                    tabs[i] = QueryOptionsDefaults.Fill(withParameters, options);
                }
            }
        }

        return withTabs;
    }

    /// <summary>Version 1 with every tab and parameter present (a null in an array arrives as null, whatever the types say).</summary>
    private static bool IsValid(Session session) =>
        session.Version == 1 && session.Tabs is not null
        && session.Tabs.All(t => t is { Id: not null, Source: not null, Title: not null, Text: not null, Parameters: not null }
            && t.Parameters.All(p => p is { Name: not null, Type: not null, Value: not null })
            && (t.Raw is null || (t.Raw.Headers is not null && t.Raw.Headers.All(h => h is { Name: not null, Value: not null })))
            && QueryOptionsDefaults.IsComplete(t.Options));
}
