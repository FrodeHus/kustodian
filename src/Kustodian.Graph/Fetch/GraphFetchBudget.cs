namespace Kustodian.Graph.Fetch;

/// <summary>
/// The memory Graph answers take in this process at once, estimated (<see cref="EstimatedSizeFactor"/> times the bytes
/// Graph sent), 512 MB by default. A
/// <see cref="GraphFetchLease"/> reserves from it as pages arrive; when it is full a lease waits up to <c>patience</c>
/// (10 s) for another to finish.
/// </summary>
public sealed class GraphFetchBudget(long maxBytes = GraphFetchBudget.DefaultMaxBytes, TimeSpan? patience = null)
{
    public const long DefaultMaxBytes = 512L << 20;

    /// <summary>What a page of Graph's answer costs in memory, in multiples of its bytes: the bytes themselves, the JSON
    /// objects parsed from them, and the engine request frame serialized from those objects, all held until the engine has
    /// answered.</summary>
    public const int EstimatedSizeFactor = 3;

    private readonly Lock _gate = new();
    private readonly TimeSpan _patience = patience ?? TimeSpan.FromSeconds(10);
    private long _used;
    private TaskCompletionSource _released = NewSignal();

    private static TaskCompletionSource NewSignal() => new(TaskCreationOptions.RunContinuationsAsynchronously);

    /// <summary>The most estimated bytes the leases may hold together.</summary>
    public long MaxBytes => maxBytes;

    /// <summary>The estimated bytes the leases hold now.</summary>
    public long Used
    {
        get
        {
            lock (_gate)
                return _used;
        }
    }

    /// <summary>A lease for one run's reads, which may take at most the whole budget holds as Graph sent it
    /// (<see cref="MaxBytes"/> / <see cref="EstimatedSizeFactor"/>), so a lone run is told it is too large instead of waiting on
    /// itself.</summary>
    public GraphFetchLease Lease() => new(this, maxBytes / EstimatedSizeFactor);

    internal async Task ReserveAsync(long bytes, CancellationToken ct)
    {
        using var deadline = new CancellationTokenSource(_patience);
        while (true)
        {
            Task signal;
            lock (_gate)
            {
                if (_used + bytes <= maxBytes)
                {
                    _used += bytes;
                    return;
                }
                signal = _released.Task;
            }
            try
            {
                await signal.WaitAsync(deadline.Token).WaitAsync(ct);
            }
            catch (OperationCanceledException) when (deadline.IsCancellationRequested && !ct.IsCancellationRequested)
            {
                throw new GraphReadException(GraphReadFailure.Busy, "Other queries are fetching from Graph. Try again when they finish.");
            }
        }
    }

    internal void Release(long bytes)
    {
        TaskCompletionSource old;
        lock (_gate)
        {
            _used -= bytes;
            old = _released;
            _released = NewSignal();
        }
        old.TrySetResult();
    }
}

/// <summary>What one run's reads hold of the process budget. Dispose returns all of it.</summary>
public sealed class GraphFetchLease : IDisposable
{
    private readonly GraphFetchBudget _budget;
    private readonly long _maxRaw;
    private long _raw;
    private long _held;

    internal GraphFetchLease(GraphFetchBudget budget, long maxRaw) => (_budget, _maxRaw) = (budget, maxRaw);

    /// <summary>Takes <paramref name="bytes"/> more as Graph sent them: <c>TooLarge</c> over what the process budget can
    /// hold (raw bytes) or when this lease's estimate alone would pass the process budget, both at once; <c>Busy</c> only when
    /// other leases keep the process budget full.</summary>
    public async Task AddAsync(long bytes, CancellationToken ct)
    {
        var estimated = bytes * GraphFetchBudget.EstimatedSizeFactor;
        if (Interlocked.Read(ref _raw) + bytes > _maxRaw || Interlocked.Read(ref _held) + estimated > _budget.MaxBytes)
            throw new GraphReadException(GraphReadFailure.TooLarge,
                "Graph returned more than " + (_maxRaw >> 20).ToString(System.Globalization.CultureInfo.InvariantCulture)
                + " MB for this query. Add a `where` Graph can filter on (see the schema list).");
        await _budget.ReserveAsync(estimated, ct);
        Interlocked.Add(ref _raw, bytes);
        Interlocked.Add(ref _held, estimated);
    }

    public void Dispose()
    {
        Interlocked.Exchange(ref _raw, 0);
        var held = Interlocked.Exchange(ref _held, 0);
        if (held > 0)
            _budget.Release(held);
    }
}
