using System.Globalization;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;

namespace Kustodian.Telemetry;

/// <summary>What is known about an error beyond its exceptions, each sent in an automatic report when set. <see cref="Source"/> is
/// one of <c>graph</c>, <c>hunting</c>, <c>arg</c>, <c>logs</c>, <c>ui</c> or <c>host</c>.</summary>
public sealed record ErrorFacts(string? Source = null, int? ExitCode = null, int? PeakMemoryMb = null, int? MemoryLimitMb = null,
    int? WorkerUptimeS = null, int? CrashesLastMinute = null, bool? Paused = null);

/// <summary>One section of a full report, shown in the "Send details" dialog and sent as one property. Only an editable section
/// may be sent changed.</summary>
public sealed record FullReportSection(string Key, string Title, string Text, bool Editable);

/// <summary>An error as the app shows it: its kind (<c>engine.crash</c>, <c>bridge.failed</c>), whether it is a bug
/// (<paramref name="Unexpected"/>, so it sends an automatic report), its scrubbed exceptions, its facts, and the material only a
/// full report may hold.</summary>
public sealed record ErrorCapture(string Kind, bool Unexpected, IReadOnlyList<ScrubbedException> Exceptions, ErrorFacts Facts,
    IReadOnlyList<FullReportSection> Details);

/// <summary>The full report of one error, as the dialog shows it.</summary>
public sealed record FullReport(string ReportId, string Kind, IReadOnlyList<FullReportSection> Sections);

/// <summary>
/// Gives every error the app shows a report ID, and keeps its full-report material in memory: the last 10 unexpected and 20
/// expected errors, each for 30 minutes, so common expected errors can't push out crash material. An unexpected error also sends
/// an automatic report when the user opted in (<paramref name="enabled"/>): types, frames, facts and the trail, never a message.
/// A problem (kind, type and top known frame) is reported once a session, and at most 20 reports are sent a session. A full
/// report is sent only by <see cref="SendAsync"/>. Sends are started, never awaited by the caller, and never throw.
/// </summary>
public sealed class ErrorReporter(AppInsightsTelemetry telemetry, Func<CancellationToken, Task<bool>> enabled, ErrorTrail trail,
    TimeProvider time)
{
    public const string FullReportEvent = "Kustodian.FullErrorReport";

    private const string Alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    private const int MaxSection = 8192;
    private const string CutMark = "… (cut)";
    private const int MaxReports = 20;
    private static readonly TimeSpan Kept = TimeSpan.FromMinutes(30);
    private static readonly string[] UiKeys = ["query", "message", "uiStack"];
    private static readonly string Os = OsName(RuntimeInformation.OSDescription);

    private readonly Lock _gate = new();
    private readonly List<Entry> _unexpected = [];
    private readonly List<Entry> _expected = [];
    private readonly HashSet<string> _reported = [];
    private readonly HashSet<Task> _pending = [];

    private sealed record Entry(string Id, string Kind, DateTimeOffset At, IReadOnlyList<FullReportSection> Sections);

    /// <summary>Whether a report can be sent at all: false in a build without an Application Insights connection string.</summary>
    public bool CanSend => telemetry.Configured;

    /// <summary>Keeps <paramref name="capture"/>'s material, starts its automatic report if it has one, and returns its new ID.
    /// It never throws: if keeping the material fails, the ID is still returned (and the full report is simply unavailable).</summary>
    public string Capture(ErrorCapture capture)
    {
        var id = RandomNumberGenerator.GetString(Alphabet, 8);
        try
        {
            Keep(id, capture);
        }
        catch (Exception)
        {
            // Reporting an error must never become a second error in the caller's catch block.
        }
        return id;
    }

    private void Keep(string id, ErrorCapture capture)
    {
        var trailText = trail.Render();
        var properties = Properties(id, capture, trailText);
        var report = new StringBuilder();
        foreach (var (key, value) in properties.Where(p => p.Key != "trail"))
            report.Append(key).Append(": ").AppendLine(value);
        foreach (var e in capture.Exceptions)
        {
            report.AppendLine().AppendLine(e.TypeName);
            foreach (var f in e.Frames)
                report.Append("  at ").Append(f.Method).Append(f.Assembly.Length > 0 ? $" ({f.Assembly})" : "").AppendLine();
        }
        var sections = capture.Details
            .Append(new FullReportSection("report", "Automatic report", report.ToString().TrimEnd(), false))
            .Append(new FullReportSection("trail", "Recent events", trailText, false))
            .Select(s => s with { Text = Cut(s.Text) })
            .ToList();

        lock (_gate)
        {
            var store = capture.Unexpected ? _unexpected : _expected;
            if (store.Count == (capture.Unexpected ? 10 : 20))
                store.RemoveAt(0);
            store.Add(new Entry(id, capture.Kind, time.GetUtcNow(), sections));
        }

        if (capture.Unexpected)
            Start(async () =>
            {
                if (!telemetry.Configured || !await enabled(CancellationToken.None))
                    return;
                var top = capture.Exceptions.FirstOrDefault();
                var problem = string.Join('|', capture.Kind, top?.TypeName,
                    top?.Frames.FirstOrDefault(f => f.Method != "<external>")?.Method);
                lock (_gate)
                {
                    if (_reported.Count >= MaxReports || !_reported.Add(problem))
                        return;
                }
                await telemetry.TrackExceptionAsync(capture.Kind, capture.Exceptions, properties, CancellationToken.None);
            });
    }

    /// <summary>The full report of <paramref name="reportId"/>, or null when it is unknown or older than 30 minutes.</summary>
    public FullReport? Details(string reportId) => Find(reportId) is { } e ? new FullReport(e.Id, e.Kind, e.Sections) : null;

    /// <summary>
    /// Sends the full report of <paramref name="reportId"/> with the given sections, which may leave sections out but may change
    /// only editable ones (each cut to fit); otherwise returns false and sends nothing. For a report no longer kept it sends only
    /// the UI's own sections (<c>query</c>, <c>message</c>, <c>uiStack</c>). It doesn't depend on automatic reports being enabled:
    /// the user asked for this one.
    /// </summary>
    public Task<bool> SendAsync(string reportId, IReadOnlyDictionary<string, string> sections, CancellationToken ct)
    {
        if (reportId.Length != 8 || !reportId.All(c => Alphabet.Contains(c, StringComparison.Ordinal)))
            return Task.FromResult(false);

        var properties = new Dictionary<string, string> { ["reportId"] = reportId };
        if (Find(reportId) is { } entry)
        {
            properties["kind"] = entry.Kind;
            foreach (var (key, text) in sections)
            {
                var shown = entry.Sections.FirstOrDefault(s => s.Key == key);
                if (shown is null || (!shown.Editable && text != shown.Text))
                    return Task.FromResult(false);
                properties[key] = Cut(text);
            }
        }
        else
        {
            foreach (var (key, text) in sections.Where(s => UiKeys.Contains(s.Key)))
                properties[key] = Cut(text);
        }

        Start(() => telemetry.TrackEventAsync(FullReportEvent, properties, CancellationToken.None));
        return Task.FromResult(true);
    }

    /// <summary>Waits for the sends started so far, for at most <paramref name="wait"/>.</summary>
    public async Task FlushAsync(TimeSpan wait)
    {
        Task[] pending;
        lock (_gate)
            pending = [.. _pending];
        try
        {
            await Task.WhenAll(pending).WaitAsync(wait, time);
        }
        catch (TimeoutException)
        {
            // The rest are dropped: exiting matters more than telemetry.
        }
    }

    /// <summary>Runs <paramref name="send"/> off the caller's thread, tracked for <see cref="FlushAsync"/>, swallowing any failure.</summary>
    private void Start(Func<Task> send)
    {
        var task = Task.Run(async () =>
        {
            try
            {
                await send();
            }
            catch (Exception)
            {
                // Telemetry never fails what the user is doing; the report is dropped.
            }
        });
        lock (_gate)
            _pending.Add(task);
        task.ContinueWith(t => { lock (_gate) _pending.Remove(t); }, CancellationToken.None,
            TaskContinuationOptions.ExecuteSynchronously, TaskScheduler.Default);
    }

    private Entry? Find(string reportId)
    {
        var now = time.GetUtcNow();
        lock (_gate)
        {
            _unexpected.RemoveAll(e => now - e.At >= Kept);
            _expected.RemoveAll(e => now - e.At >= Kept);
            return _unexpected.Concat(_expected).FirstOrDefault(e => e.Id == reportId);
        }
    }

    /// <summary>The automatic report's properties, in the order they are sent.</summary>
    private static Dictionary<string, string> Properties(string id, ErrorCapture capture, string trailText)
    {
        var f = capture.Facts;
        var properties = new Dictionary<string, string>
        {
            ["reportId"] = id,
            ["kind"] = capture.Kind,
            ["os"] = Os,
            ["arch"] = RuntimeInformation.OSArchitecture.ToString(),
            ["runtime"] = Environment.Version.ToString(),
            ["trail"] = trailText,
        };
        if (f.Source is { } source)
            properties["source"] = source;
        foreach (var (key, value) in new (string, int?)[]
                 {
                     ("exitCode", f.ExitCode), ("peakMemoryMb", f.PeakMemoryMb), ("memoryLimitMb", f.MemoryLimitMb),
                     ("workerUptimeS", f.WorkerUptimeS), ("crashesLastMinute", f.CrashesLastMinute),
                 })
        {
            if (value is { } v)
                properties[key] = v.ToString(CultureInfo.InvariantCulture);
        }
        if (f.Paused is { } paused)
            properties["paused"] = paused ? "true" : "false";
        return properties;
    }

    /// <summary>The OS name and version: the words up to the first with a digit in it, at most three (<c>Darwin 25.6.0</c>,
    /// <c>Microsoft Windows 10.0.26100</c>), so no kernel build string or host name that follows.</summary>
    private static string OsName(string description)
    {
        var words = description.Split(' ', StringSplitOptions.RemoveEmptyEntries);
        var version = Array.FindIndex(words, w => w.Any(char.IsAsciiDigit));
        return string.Join(' ', words.Take(version is >= 0 and < 3 ? version + 1 : 2));
    }

    /// <summary><paramref name="text"/> cut to Application Insights' 8,192 characters per property, ending with the cut mark.</summary>
    private static string Cut(string text)
    {
        if (text.Length <= MaxSection)
            return text;
        var end = MaxSection - CutMark.Length;
        if (char.IsHighSurrogate(text[end - 1]))
            end--;
        return string.Concat(text.AsSpan(0, end), CutMark);
    }
}
