using System.Globalization;

namespace Kustodian.Graph.Engine;

/// <summary>Why the pool gave no answer (spec 9).</summary>
public enum GraphEngineFailure
{
    /// <summary>No worker came free in time, or the crash guard has paused the pool.</summary>
    Busy,

    /// <summary>No answer within the time limit; the worker was killed.</summary>
    TimedOut,

    /// <summary>The worker's working set went over the limit; it was killed.</summary>
    OutOfMemory,

    /// <summary>The worker died, or answered with a malformed frame.</summary>
    Crashed,

    /// <summary>The answer was over <see cref="GraphEngineOptions.MaxAnswerBytes"/>: the query's doing, so the worker was
    /// killed without counting as a crash.</summary>
    TooLarge,
}

/// <summary>A run the engine pool couldn't answer. <see cref="Exception.Message"/> is the text the user sees; a time-out
/// names the limit in whole seconds, rounded up (<paramref name="timeout"/>, 30 s when not given).</summary>
public sealed class GraphEngineException(GraphEngineFailure failure, TimeSpan? timeout = null)
    : Exception(MessageFor(failure, timeout ?? TimeSpan.FromSeconds(30)))
{
    public GraphEngineFailure Failure { get; } = failure;

    private static string MessageFor(GraphEngineFailure failure, TimeSpan timeout) => failure switch
    {
        GraphEngineFailure.Busy => "The server is busy, try again",
        GraphEngineFailure.TimedOut => string.Create(
            CultureInfo.InvariantCulture, $"Timed out after {(long)Math.Ceiling(timeout.TotalSeconds)} s"),
        GraphEngineFailure.OutOfMemory => "The query needed too much memory (it may multiply rows: check joins)",
        GraphEngineFailure.Crashed => "The query engine stopped unexpectedly",
        GraphEngineFailure.TooLarge => "The result was too large. Add a project or take to narrow it.",
        _ => throw new ArgumentOutOfRangeException(nameof(failure), failure, null),
    };
}
