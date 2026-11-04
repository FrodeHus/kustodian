using Kustodian.Telemetry;
using Microsoft.Extensions.Time.Testing;

namespace Kustodian.Tests.Telemetry;

/// <summary>What the trail of recent event codes keeps: codes and the seconds between them, the last 20, and nothing that is not a
/// code.</summary>
public sealed class ErrorTrailTests
{
    private readonly FakeTimeProvider _time = new(new DateTimeOffset(2026, 11, 4, 12, 0, 0, TimeSpan.Zero));

    [Fact]
    public void Render_lists_codes_with_seconds_since_the_previous_event()
    {
        var trail = new ErrorTrail(_time);

        trail.Add("run.start(graph)");
        _time.Advance(TimeSpan.FromSeconds(2));
        trail.Add("run.error(consentNeeded)");

        Assert.Equal("run.start(graph) +0s; run.error(consentNeeded) +2s", trail.Render());
    }

    [Fact]
    public void Keeps_the_last_twenty()
    {
        var trail = new ErrorTrail(_time);

        for (var i = 0; i < ErrorTrail.Capacity + 5; i++)
            trail.Add($"run.start(s{i})");

        Assert.Equal(string.Join("; ", Enumerable.Range(5, ErrorTrail.Capacity).Select(i => $"run.start(s{i}) +0s")), trail.Render());
    }

    [Fact]
    public void Refuses_anything_that_is_not_a_code()
    {
        var trail = new ErrorTrail(_time);

        trail.Add("run.error(adele.vance@contoso.com)");
        trail.Add("x");
        trail.Add(new string('a', 65));
        trail.Add("run.start(graph) users | take 1");

        Assert.Equal("", trail.Render());
    }
}
