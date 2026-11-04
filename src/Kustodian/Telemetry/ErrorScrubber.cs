using System.Diagnostics;
using System.Text.RegularExpressions;
using Kustodian.Graph.Engine;

namespace Kustodian.Telemetry;

/// <summary>The privacy gate of automatic error reports: reduces an exception to type names and frames. It never reads a
/// message, <c>Data</c>, <c>Source</c>, <c>HelpLink</c> or <c>ToString()</c>, so nothing the user typed or the tenant returned
/// can pass through it.</summary>
public static partial class ErrorScrubber
{
    private const int MaxExceptions = 10;
    private static readonly ErrorFrame External = new("<external>", "");

    // Frames come only from our own code, KustoLoco, Kusto.Language and the runtime; anything else (plugins, tools) is external.
    private static readonly string[] KnownAssemblyPrefixes = ["Kustodian", "KustoLoco", "Kusto.Language", "System", "Microsoft"];

    [GeneratedRegex(@"^[A-Za-z_$][\w$]{0,63}$")]
    private static partial Regex JsName();

    // V8 (`at fn (url:l:c)`, `at url:l:c`) and WebKit/JavaScriptCore (`fn@url:l:c`, `@url:l:c`): WebView2, WKWebView, WebKitGTK.
    [GeneratedRegex(@"^\s*(?:at\s+(?:(?:async\s+|new\s+)?(?<fn>[^\s(]+)\s+\((?<url>.+):(?<line>\d+):(?<col>\d+)\)|(?<url>.+):(?<line>\d+):(?<col>\d+))|(?<fn>[^@\s]*)@(?<url>.+):(?<line>\d+):(?<col>\d+))\s*$")]
    private static partial Regex JsFrame();

    [GeneratedRegex(@"/assets/(?<file>[^/?#]+\.js)$")]
    private static partial Regex BundleFile();

    /// <summary>The exception, then its inner exceptions (an <see cref="AggregateException"/> flattened), at most 10.</summary>
    public static IReadOnlyList<ScrubbedException> Of(Exception exception)
    {
        var result = new List<ScrubbedException>();
        var pending = new Queue<Exception>();
        pending.Enqueue(exception);
        while (pending.Count > 0 && result.Count < MaxExceptions)
        {
            var current = pending.Dequeue();
            result.Add(new ScrubbedException(current.GetType().FullName ?? "", Collapse(FramesOf(current))));
            if (current is AggregateException aggregate)
                foreach (var inner in aggregate.InnerExceptions)
                    pending.Enqueue(inner);
            else if (current.InnerException is { } single)
                pending.Enqueue(single);
        }
        return result;
    }

    /// <summary>An engine worker's crash frame, by the same rules: type names and known frames, at most 10 exceptions. The
    /// messages are dropped.</summary>
    public static IReadOnlyList<ScrubbedException> Of(EngineCrash crash) =>
        [.. crash.Exceptions.Take(MaxExceptions)
            .Select(e => new ScrubbedException(e.TypeName, Collapse(e.Frames.Select(f => Frame(f.Method, f.Assembly)))))];

    /// <summary>A script error from the web UI: its name (an identifier, else <c>Error</c>) and the frames of its stack that
    /// point into the app's own bundle. The message is never read.</summary>
    public static IReadOnlyList<ScrubbedException> OfJs(string name, string? stack)
    {
        var frames = new List<ErrorFrame>();
        foreach (var line in (stack ?? "").Split('\n'))
        {
            var m = JsFrame().Match(line);
            if (!m.Success)
                continue;
            var file = BundleFile().Match(m.Groups["url"].Value);
            if (!file.Success)
            {
                frames.Add(External);
                continue;
            }
            var fn = m.Groups["fn"].Success && JsName().IsMatch(m.Groups["fn"].Value) ? m.Groups["fn"].Value : "<anonymous>";
            frames.Add(new ErrorFrame(fn, $"{file.Groups["file"].Value}:{m.Groups["line"].Value}:{m.Groups["col"].Value}"));
        }
        return [new ScrubbedException(JsName().IsMatch(name) ? name : "Error", Collapse(frames))];
    }

    /// <summary>One frame: the method and assembly as they are when the assembly is a known one, else the external marker.</summary>
    internal static ErrorFrame Frame(string? method, string? assembly) =>
        method is not null && assembly is not null && KnownAssemblyPrefixes.Any(p => assembly.StartsWith(p, StringComparison.Ordinal))
            ? new ErrorFrame(method, assembly)
            : External;

    private static IEnumerable<ErrorFrame> FramesOf(Exception exception) =>
        new StackTrace(exception).GetFrames().Select(f =>
        {
            var method = f.GetMethod();
            return Frame(method?.DeclaringType is { } t ? $"{t.FullName}.{method.Name}" : null, method?.Module.Assembly.GetName().Name);
        });

    // Consecutive external frames say nothing more than one does.
    private static List<ErrorFrame> Collapse(IEnumerable<ErrorFrame> frames)
    {
        var result = new List<ErrorFrame>();
        foreach (var frame in frames)
            if (frame != External || result.Count == 0 || result[^1] != External)
                result.Add(frame);
        return result;
    }
}
