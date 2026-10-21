namespace Kustodian.Graph.Run;

/// <summary>A step of a run, for the UI's progress line. <paramref name="Stage"/> is one of <c>planning</c>, <c>fetching</c>,
/// <c>probing</c>, <c>per-object</c> or <c>engine</c>.</summary>
public sealed record RunEvent(string Stage, string Detail);
