using System.Collections.Concurrent;

namespace Kustodian.Graph.Tests.Run;

/// <summary>A clock whose timers fire at once, so a reader's waits (a throttled request's <c>Retry-After</c>) pass without time
/// passing. <see cref="Waits"/> are the waits asked for, in order.</summary>
public sealed class InstantTime : TimeProvider
{
    public ConcurrentQueue<TimeSpan> Waits { get; } = new();

    public override ITimer CreateTimer(TimerCallback callback, object? state, TimeSpan dueTime, TimeSpan period)
    {
        var timer = new Fired(callback, state);
        timer.Change(dueTime, period);
        if (dueTime != Timeout.InfiniteTimeSpan)
            Waits.Enqueue(dueTime);
        return timer;
    }

    private sealed class Fired(TimerCallback callback, object? state) : ITimer
    {
        public bool Change(TimeSpan dueTime, TimeSpan period)
        {
            // On the thread pool: the caller hasn't kept the timer yet when this returns.
            if (dueTime != Timeout.InfiniteTimeSpan)
                ThreadPool.QueueUserWorkItem(_ => callback(state));
            return true;
        }

        public void Dispose()
        {
        }

        public ValueTask DisposeAsync() => ValueTask.CompletedTask;
    }
}
