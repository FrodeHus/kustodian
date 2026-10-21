using System.Threading.Channels;

namespace Kustodian.App;

/// <summary>Hands messages from the UI to <c>handle</c> one at a time, in arrival order, off the UI thread. Each handling is
/// started (run up to its first await) before the next message is taken, so a <c>query.cancel</c> sent right after a
/// <c>query.run</c> finds that run; the handlings themselves then run concurrently.</summary>
public sealed class MessagePump
{
    private readonly Channel<string> _queue = Channel.CreateUnbounded<string>(new UnboundedChannelOptions { SingleReader = true });
    private readonly Task _loop;

    public MessagePump(Func<string, Task> handle) =>
        _loop = Task.Run(async () =>
        {
            await foreach (var message in _queue.Reader.ReadAllAsync())
            {
                _ = handle(message);
            }
        });

    public void Post(string message) => _queue.Writer.TryWrite(message);

    /// <summary>Takes no more messages and returns when those already posted have been handed on.</summary>
    public Task CompleteAsync()
    {
        _queue.Writer.TryComplete();
        return _loop;
    }
}
