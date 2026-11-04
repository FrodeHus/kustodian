using Kustodian.Telemetry;

namespace Kustodian.App;

/// <summary>Reports what nothing else caught in the host process: an unhandled exception (kind <c>host.unhandled</c>), after which
/// the process ends, so the report gets up to <see cref="FlushWait"/> to go out; and an unobserved task exception (kind
/// <c>host.unobserved</c>), which is then marked observed. Both are unexpected; their messages go into the full report only.</summary>
public sealed class HostErrors(ErrorReporter reporter)
{
    public static readonly TimeSpan FlushWait = TimeSpan.FromSeconds(2);

    /// <summary>Hooks <see cref="OnUnhandled"/> and <see cref="OnUnobserved"/> to the process's events.</summary>
    public void Register()
    {
        AppDomain.CurrentDomain.UnhandledException += (_, e) =>
        {
            if (e.ExceptionObject is Exception ex)
                OnUnhandled(ex);
        };
        TaskScheduler.UnobservedTaskException += (_, e) => OnUnobserved(e);
    }

    /// <summary>Captures <paramref name="exception"/> and waits for the report to go out, for at most <see cref="FlushWait"/>.</summary>
    public string OnUnhandled(Exception exception)
    {
        var id = Capture("host.unhandled", exception);
        reporter.FlushAsync(FlushWait).GetAwaiter().GetResult();
        return id;
    }

    /// <summary>Captures the task's exception and marks it observed.</summary>
    public string OnUnobserved(UnobservedTaskExceptionEventArgs e)
    {
        var id = Capture("host.unobserved", e.Exception);
        e.SetObserved();
        return id;
    }

    private string Capture(string kind, Exception exception) =>
        reporter.Capture(new ErrorCapture(kind, true, ErrorScrubber.Of(exception), new ErrorFacts(Source: "host"),
        [
            new FullReportSection("message", "Message", exception.Message, false),
            new FullReportSection("exception", "Exception", exception.ToString(), false),
        ]));
}
