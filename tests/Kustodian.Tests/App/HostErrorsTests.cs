using Kustodian.App;
using Kustodian.Telemetry;
using Kustodian.Tests.Telemetry;

namespace Kustodian.Tests.App;

/// <summary>What nothing else caught in the host: reported as unexpected, by the methods the process's events call.</summary>
public sealed class HostErrorsTests : IDisposable
{
    private const string Connection = "InstrumentationKey=key-1;IngestionEndpoint=https://ingest.example/";

    private readonly Recorder _posted = new();
    private readonly HttpClient _http;
    private readonly ErrorReporter _reporter;

    public HostErrorsTests()
    {
        _http = new HttpClient(_posted);
        _reporter = new ErrorReporter(new AppInsightsTelemetry(_http, Connection, TimeProvider.System), _ => Task.FromResult(true),
            new ErrorTrail(TimeProvider.System), TimeProvider.System);
    }

    public void Dispose() => _http.Dispose();

    [Fact]
    public void Unhandled_exception_is_reported_before_the_process_ends()
    {
        var id = new HostErrors(_reporter).OnUnhandled(new InvalidOperationException("alice@contoso.com"));

        // OnUnhandled waited for the send: it is already out.
        var posted = Assert.Single(_posted.Bodies);
        Assert.Contains("host.unhandled", posted, StringComparison.Ordinal);
        Assert.DoesNotContain("alice@contoso.com", posted, StringComparison.Ordinal);
        Assert.Equal("host.unhandled", _reporter.Details(id)?.Kind);
    }

    [Fact]
    public async Task Unobserved_task_exception_is_reported_and_observed()
    {
        var e = new UnobservedTaskExceptionEventArgs(new AggregateException(new InvalidOperationException("lost")));

        var id = new HostErrors(_reporter).OnUnobserved(e);
        await _reporter.FlushAsync(TimeSpan.FromSeconds(5));

        Assert.True(e.Observed);
        Assert.Equal("host.unobserved", _reporter.Details(id)?.Kind);
        Assert.Contains("host.unobserved", Assert.Single(_posted.Bodies), StringComparison.Ordinal);
    }
}
