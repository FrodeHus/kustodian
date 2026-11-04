namespace Kustodian.Telemetry;

/// <summary>One stack frame of an automatic report: the method's full name and its assembly's name, and nothing else (no file,
/// line or argument).</summary>
public sealed record ErrorFrame(string Method, string Assembly);

/// <summary>An exception reduced to what an automatic report may hold: its type name and its frames, never its message.</summary>
public sealed record ScrubbedException(string TypeName, IReadOnlyList<ErrorFrame> Frames);
