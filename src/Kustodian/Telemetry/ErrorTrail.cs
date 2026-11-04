using System.Globalization;
using System.Text.RegularExpressions;

namespace Kustodian.Telemetry;

/// <summary>The last <see cref="Capacity"/> event codes (<c>run.start(graph)</c>, <c>engine.exit(1)</c>), each with the seconds since the
/// event before it. It holds codes only: anything that is not a code is dropped, so no value can reach a report through it.</summary>
public sealed partial class ErrorTrail(TimeProvider time)
{
    public const int Capacity = 20;
    private const int MaxLength = 64;

    private readonly Lock _gate = new();
    private readonly Queue<(string Code, DateTimeOffset At)> _events = new();

    [GeneratedRegex(@"^[a-z]+(\.[a-zA-Z]+)+(\([a-zA-Z0-9=.,-]{1,40}\))?$")]
    private static partial Regex CodePattern();

    /// <summary>Records <paramref name="code"/>. A string that is not a code is dropped without a trace (no <c>Debug.Fail</c>, which would
    /// crash the refusal test in Debug builds).</summary>
    public void Add(string code)
    {
        if (code.Length > MaxLength || !CodePattern().IsMatch(code))
            return;
        lock (_gate)
        {
            if (_events.Count == Capacity)
                _events.Dequeue();
            _events.Enqueue((code, time.GetUtcNow()));
        }
    }

    /// <summary>The codes, oldest first, each with the whole seconds since the event before it (<c>+0s</c> for the first).</summary>
    public string Render()
    {
        lock (_gate)
        {
            var parts = new List<string>(_events.Count);
            var previous = (DateTimeOffset?)null;
            foreach (var (code, at) in _events)
            {
                var seconds = previous is { } p ? (long)(at - p).TotalSeconds : 0;
                parts.Add(string.Create(CultureInfo.InvariantCulture, $"{code} +{seconds}s"));
                previous = at;
            }
            return string.Join("; ", parts);
        }
    }
}
