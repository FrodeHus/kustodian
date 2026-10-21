using System.Globalization;

namespace Kustodian.Graph.Run;

/// <summary>One line of a run's diagnostics log (spec 6.10). <paramref name="AtMs"/> is when it happened, in milliseconds since
/// the run started; <paramref name="Kind"/> is one of the <see cref="DiagnosticKinds"/>. A request's <paramref name="Detail"/> is
/// its method and URL relative to the Graph version (<c>GET applications?$select=…</c>), never a header; its
/// <paramref name="Status"/>, <paramref name="DurationMs"/> and <paramref name="Bytes"/> (the response body) are null when there
/// is none.</summary>
public sealed record DiagnosticEntry(long AtMs, string Kind, string Detail, int? Status, long? DurationMs, long? Bytes);

/// <summary>The kinds of <see cref="DiagnosticEntry"/>.</summary>
public static class DiagnosticKinds
{
    /// <summary>A list page, or any request not otherwise tagged.</summary>
    public const string Request = "request";

    /// <summary>Items Graph answered with 429, and its <c>Retry-After</c>.</summary>
    public const string Throttled = "throttled";

    /// <summary>Throttled items sent again.</summary>
    public const string Retry = "retry";

    /// <summary>A probe request, and the columns probing dropped and why.</summary>
    public const string Probe = "probe";

    /// <summary>A <c>$batch</c> of one-object reads, and what they read.</summary>
    public const string PerObject = "per-object";

    /// <summary>Values taken from the per-object cache instead of Graph.</summary>
    public const string Cache = "cache";

    /// <summary>An engine worker's start, answer or kill.</summary>
    public const string Engine = "engine";
}

/// <summary>
/// One run's diagnostics log, with the run's id. Safe to add to from the run's parallel reads. Keeps at most
/// <see cref="MaxEntries"/> entries; after that one final entry says how many more there were. Requests carry it on
/// <see cref="HttpRequestMessage.Options"/> (<see cref="RunDiagnosticsRequest.ForRun"/>), and the HTTP pipeline logs each request
/// it sends into it. Nothing in it is a token or a header. The run's id is <paramref name="runId"/> when that is a GUID in
/// <c>D</c> format (the UI names its runs, so it can tell their progress apart from the first event), otherwise a new one.
/// </summary>
public sealed class RunDiagnostics(TimeProvider time, string? runId = null)
{
    public const int MaxEntries = 5_000;

    /// <summary>The run's log on a request.</summary>
    public static readonly HttpRequestOptionsKey<RunDiagnostics> Key = new("Kustodian.RunDiagnostics");

    private readonly long _started = time.GetTimestamp();
    private readonly Lock _gate = new();
    private readonly List<DiagnosticEntry> _entries = [];
    private DiagnosticEntry? _firstDropped;
    private long _lastDroppedAt;
    private int _dropped;

    public string RunId { get; } = IsRunId(runId) ? runId! : Guid.NewGuid().ToString("D");

    /// <summary>Whether <paramref name="id"/> can be a run's id: a GUID in <c>D</c> format.</summary>
    public static bool IsRunId(string? id) => Guid.TryParseExact(id, "D", out _);

    /// <summary>Milliseconds since the run started.</summary>
    public long NowMs => (long)time.GetElapsedTime(_started).TotalMilliseconds;

    public void Add(DiagnosticEntry entry) => Track(entry);

    /// <summary>Adds <paramref name="entry"/> and returns its place, for <see cref="SetBytes"/>; -1 when it was over the cap.</summary>
    public int Track(DiagnosticEntry entry)
    {
        lock (_gate)
        {
            if (_entries.Count < MaxEntries)
            {
                _entries.Add(entry);
                return _entries.Count - 1;
            }
            _firstDropped ??= entry;
            _lastDroppedAt = Math.Max(_lastDroppedAt, entry.AtMs);
            _dropped++;
            return -1;
        }
    }

    /// <summary>Sets the body size of the entry at <paramref name="index"/> (from <see cref="Track"/>) when it has none yet.</summary>
    public void SetBytes(int index, long bytes)
    {
        lock (_gate)
        {
            if (index >= 0 && index < _entries.Count && _entries[index].Bytes is null)
                _entries[index] = _entries[index] with { Bytes = bytes };
        }
    }

    /// <summary>The entries in time order, then the note on how many more there were, if any.</summary>
    public IReadOnlyList<DiagnosticEntry> Entries
    {
        get
        {
            lock (_gate)
            {
                var ordered = _entries.OrderBy(e => e.AtMs).ToList();
                if (_firstDropped is { } first)
                    ordered.Add(new DiagnosticEntry(_lastDroppedAt, first.Kind,
                        _dropped.ToString("N0", CultureInfo.InvariantCulture) + " more entries not shown", null, null, null));
                return ordered;
            }
        }
    }
}

/// <summary>The run's log on a request, as <see cref="Fetch.GraphRequestAccount"/> carries the account.</summary>
public static class RunDiagnosticsRequest
{
    /// <summary>What kind of request it is, for its entry (<see cref="DiagnosticKinds"/>).</summary>
    public static readonly HttpRequestOptionsKey<string> KindKey = new("Kustodian.RunDiagnostics.Kind");

    /// <summary>Where the request's entry is in the log, so the reader can add the body size the response didn't state.</summary>
    private static readonly HttpRequestOptionsKey<int> EntryKey = new("Kustodian.RunDiagnostics.Entry");

    /// <summary>Marks <paramref name="request"/> as made for the run that <paramref name="diagnostics"/> logs (nothing when null),
    /// as a request of <paramref name="kind"/>, and returns it.</summary>
    public static HttpRequestMessage ForRun(this HttpRequestMessage request, RunDiagnostics? diagnostics, string kind = DiagnosticKinds.Request)
    {
        if (diagnostics is not null)
        {
            request.Options.Set(RunDiagnostics.Key, diagnostics);
            request.Options.Set(KindKey, kind);
        }
        return request;
    }

    /// <summary>The run's log on <paramref name="request"/>, or null.</summary>
    public static RunDiagnostics? DiagnosticsOf(HttpRequestMessage request)
        => request.Options.TryGetValue(RunDiagnostics.Key, out var diagnostics) ? diagnostics : null;

    /// <summary>The kind of <paramref name="request"/>; <see cref="DiagnosticKinds.Request"/> when it has none.</summary>
    public static string KindOf(HttpRequestMessage request)
        => request.Options.TryGetValue(KindKey, out var kind) && !string.IsNullOrEmpty(kind) ? kind : DiagnosticKinds.Request;

    /// <summary>Logs <paramref name="entry"/> as <paramref name="request"/>'s, so <see cref="RecordBytes"/> can find it.</summary>
    public static void LogRequest(this HttpRequestMessage request, RunDiagnostics diagnostics, DiagnosticEntry entry)
        => request.Options.Set(EntryKey, diagnostics.Track(entry));

    /// <summary>The body size the reader read for <paramref name="request"/>, for its entry when the response didn't state
    /// one (no <c>Content-Length</c>).</summary>
    public static void RecordBytes(this HttpRequestMessage request, long bytes)
    {
        if (DiagnosticsOf(request) is { } diagnostics && request.Options.TryGetValue(EntryKey, out var index))
            diagnostics.SetBytes(index, bytes);
    }
}
