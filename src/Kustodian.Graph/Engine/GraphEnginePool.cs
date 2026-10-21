using System.Collections;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using Microsoft.Extensions.Logging;

namespace Kustodian.Graph.Engine;

/// <summary>The pool's state: workers running, those executing, worker deaths in the last minute (all,
/// and the unexplained ones that feed the crash guard), whether the crash guard has paused starting workers, and the
/// workers' process ids.</summary>
public sealed record GraphEngineSnapshot(
    int Alive, int Busy, int KillsLastMinute, int CrashesLastMinute, bool Paused, IReadOnlyList<int> WorkerIds);

/// <summary>Engine worker processes the app can kill (spec 9). KustoLoco has no cancellation
/// and a join can multiply rows until memory runs out, so a query runs in a worker: killed with its process tree when it
/// takes longer than <see cref="GraphEngineOptions.Timeout"/>, its working set goes over
/// <see cref="GraphEngineOptions.MemoryLimitBytes"/> (its GC heap is capped at the same size, so a runaway join usually
/// fails inside it first), it answers with a malformed or oversized frame, or the run is cancelled. Workers start on
/// demand: none at construction, one more whenever a run finds none idle and fewer than
/// <see cref="GraphEngineOptions.Workers"/> exist; an idle worker is kept for the next run, and a killed one is replaced
/// only when a run needs it. More than <see cref="GraphEngineOptions.CrashLimitPerMinute"/> unexplained deaths (crashes,
/// not kills for time, memory, size or cancellation) in a minute pause starting workers for a minute.</summary>
public sealed class GraphEnginePool : IAsyncDisposable
{
    private static readonly TimeSpan Minute = TimeSpan.FromMinutes(1);
    private static readonly TimeSpan ExitWait = TimeSpan.FromSeconds(5);
    private const int MaxStderrLine = 500;

    private readonly GraphEngineOptions _options;
    private readonly ILogger<GraphEnginePool> _logger;
    private readonly TimeProvider _time;
    private readonly Lock _gate = new();
    // Every worker alive, and those of them waiting for a run. A run holds one of the slots from before it takes a worker
    // until it gives the worker back or kills it, so no more than Workers exist at once.
    private readonly List<Worker> _workers = [];
    private readonly Stack<Worker> _idle = new();
    private readonly SemaphoreSlim _slots;
    private readonly CancellationTokenSource _disposing = new();
    // Every worker death, and the unexplained ones (crashes), which alone feed the crash guard.
    private readonly Queue<DateTimeOffset> _kills = new();
    private readonly Queue<DateTimeOffset> _crashes = new();
    private DateTimeOffset? _pausedUntil;
    private bool _disposed;

    public GraphEnginePool(GraphEngineOptions options, ILogger<GraphEnginePool> logger, TimeProvider time)
    {
        _options = options;
        _logger = logger;
        _time = time;
        _slots = new SemaphoreSlim(Math.Max(1, _options.Workers));
    }

    /// <summary>Runs <paramref name="request"/> on a free worker and returns its answer (which may itself be an error or a
    /// refusal). Throws <see cref="GraphEngineException"/> when there is no answer, and
    /// <see cref="OperationCanceledException"/> when <paramref name="ct"/> is cancelled, which kills the worker.
    /// <paramref name="runTag"/> names the run in the log.</summary>
    public async Task<EngineResponse> RunAsync(EngineRequest request, string runTag, CancellationToken ct)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        var worker = await AcquireAsync(ct);
        return await ExecuteAsync(worker, request, runTag, _options.Timeout, ct);
    }

    /// <summary>The limits the pool runs with.</summary>
    public GraphEngineOptions Options => _options;

    public GraphEngineSnapshot Snapshot()
    {
        lock (_gate)
        {
            Prune(_kills);
            Prune(_crashes);
            return new GraphEngineSnapshot(
                _workers.Count, _workers.Count(w => w.Busy), _kills.Count, _crashes.Count, IsPaused(), _workers.Select(w => w.Id).ToList());
        }
    }

    /// <summary>Retires the idle workers that exited on their own (a crash each).</summary>
    private void RetireExited()
    {
        List<Worker> exited;
        lock (_gate)
        {
            exited = _idle.Where(w => w.Process.HasExited).ToList();
            if (exited.Count == 0)
                return;
            foreach (var worker in exited)
                Retire(worker, Death.Crash);
            // The stack enumerates from the top; pushing the survivors back bottom first keeps their order.
            var alive = _idle.Where(w => !w.Retired).Reverse().ToList();
            _idle.Clear();
            foreach (var worker in alive)
                _idle.Push(worker);
        }
        foreach (var worker in exited)
        {
            _logger.LogWarning("Graph engine worker {WorkerId} exited while idle (exit code {ExitCode})",
                worker.Id, worker.Process.ExitCode);
            worker.Process.Dispose();
        }
    }

    /// <summary>The worker's start: an empty environment apart from an allow list of the runtime's own settings (see
    /// <see cref="IsRuntimeSetting"/>; and, on Windows, <c>SystemRoot</c>, without which the runtime can't start), so no
    /// connection string or credential of the app reaches it, plus <c>DOTNET_GCHeapHardLimit</c> at
    /// <see cref="GraphEngineOptions.MemoryLimitBytes"/>. A <c>.dll</c> runs on the dotnet host of the runtime the app runs
    /// on, found from the runtime's directory, so neither <c>PATH</c> nor <c>DOTNET_ROOT</c> is needed to find it.</summary>
    internal ProcessStartInfo CreateStartInfo()
    {
        var path = Path.GetFullPath(_options.WorkerPath);
        var start = new ProcessStartInfo
        {
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
            WorkingDirectory = Path.GetDirectoryName(path) ?? AppContext.BaseDirectory,
        };
        if (!path.EndsWith(".dll", StringComparison.OrdinalIgnoreCase))
            start.FileName = path;
        else if (DotnetHost() is { } host)
        {
            start.FileName = host;
            start.ArgumentList.Add(path);
        }
        else
            // A self-contained app has no dotnet host; the worker's own apphost sits next to its dll.
            start.FileName = Path.ChangeExtension(path, OperatingSystem.IsWindows() ? ".exe" : null);
        foreach (var arg in _options.WorkerArgs)
            start.ArgumentList.Add(arg);

        start.Environment.Clear();
        foreach (DictionaryEntry variable in Environment.GetEnvironmentVariables())
        {
            var name = (string)variable.Key;
            if (IsRuntimeSetting(name))
                start.Environment[name] = (string?)variable.Value;
        }
        if (OperatingSystem.IsWindows())
            start.Environment["SystemRoot"] = Environment.GetEnvironmentVariable("SystemRoot");
        // The GC heap is capped at the working-set limit (in hexadecimal, as the runtime reads it), so a runaway query fails
        // inside the worker; the working-set watch stays as the backstop for memory outside the GC heap.
        start.Environment["DOTNET_GCHeapHardLimit"] = "0x" + _options.MemoryLimitBytes.ToString("X", CultureInfo.InvariantCulture);
        return start;
    }

    /// <summary>The variables the worker inherits: where the runtime is (<c>DOTNET_ROOT</c>, <c>DOTNET_ROOT_X64</c>, …), the
    /// garbage collector's settings (<c>DOTNET_gc…</c>, <c>DOTNET_GC…</c>) and globalization's
    /// (<c>DOTNET_SYSTEM_GLOBALIZATION_…</c>). Never a name with <c>__</c>: that is configuration
    /// (<c>DOTNET_ConnectionStrings__db</c> binds as <c>ConnectionStrings:db</c>), not the runtime's.</summary>
    internal static bool IsRuntimeSetting(string name) =>
        !name.Contains("__", StringComparison.Ordinal)
        && (name == "DOTNET_ROOT"
            || name.StartsWith("DOTNET_ROOT_", StringComparison.Ordinal)
            || name.StartsWith("DOTNET_gc", StringComparison.Ordinal)
            || name.StartsWith("DOTNET_GC", StringComparison.Ordinal)
            || name.StartsWith("DOTNET_SYSTEM_GLOBALIZATION_", StringComparison.Ordinal));

    public async ValueTask DisposeAsync()
    {
        List<Worker> workers;
        lock (_gate)
        {
            if (_disposed)
                return;
            _disposed = true;
            _disposing.Cancel();
            _idle.Clear();
            workers = [.. _workers];
            foreach (var worker in workers)
                Retire(worker, Death.None);
        }
        await Task.WhenAll(workers.Select(KillAsync));
    }

    /// <summary>A slot, and a worker for it: an idle one if there is one, else a newly started one. Waits up to
    /// <see cref="GraphEngineOptions.WaitForWorker"/> for a slot, then fails busy; fails busy at once while the crash guard
    /// pauses the pool, and as crashed when no worker can start.</summary>
    private async Task<Worker> AcquireAsync(CancellationToken ct)
    {
        RetireExited();
        if (Snapshot().Paused)
            throw new GraphEngineException(GraphEngineFailure.Busy);

        using var waited = new CancellationTokenSource(_options.WaitForWorker, _time);
        using var wait = CancellationTokenSource.CreateLinkedTokenSource(ct, waited.Token, _disposing.Token);
        try
        {
            await _slots.WaitAsync(wait.Token);
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            ObjectDisposedException.ThrowIf(_disposing.IsCancellationRequested, this);
            throw new GraphEngineException(GraphEngineFailure.Busy);
        }

        var failure = GraphEngineFailure.Crashed;
        List<Worker> exited = [];
        lock (_gate)
        {
            if (_disposed)
                throw new ObjectDisposedException(nameof(GraphEnginePool));
            while (_idle.TryPop(out var idle))
            {
                if (idle.Retired)
                    continue;
                if (!idle.Process.HasExited)
                {
                    idle.Busy = true;
                    return idle;
                }
                // It died while idle: an unexplained death.
                Retire(idle, Death.Crash);
                exited.Add(idle);
            }
            if (IsPaused())
                failure = GraphEngineFailure.Busy;
            else if (Start() is { } started)
            {
                started.Busy = true;
                _workers.Add(started);
                LogExited(exited);
                return started;
            }
        }
        LogExited(exited);
        ReleaseSlot();
        throw new GraphEngineException(failure);
    }

    private void LogExited(List<Worker> exited)
    {
        foreach (var worker in exited)
        {
            _logger.LogWarning("Graph engine worker {WorkerId} exited while idle (exit code {ExitCode})", worker.Id, worker.Process.ExitCode);
            worker.Process.Dispose();
        }
    }

    /// <summary>Gives a run's slot back. After disposal no one waits for one.</summary>
    private void ReleaseSlot()
    {
        lock (_gate)
        {
            if (!_disposed)
                _slots.Release();
        }
    }

    private async Task<EngineResponse> ExecuteAsync(
        Worker worker, EngineRequest request, string runTag, TimeSpan limit, CancellationToken ct)
    {
        using var stop = CancellationTokenSource.CreateLinkedTokenSource(ct);
        var timeout = Task.Delay(limit, _time, stop.Token);
        var memory = WatchMemoryAsync(worker, stop.Token);
        var exchange = ExchangeAsync(worker, request, stop.Token);
        var first = await Task.WhenAny(exchange, memory, timeout);

        if (first == exchange && exchange.IsCompletedSuccessfully && exchange.Result is { } response && !ct.IsCancellationRequested)
        {
            await stop.CancelAsync();
            lock (_gate)
            {
                worker.Busy = false;
                if (!worker.Retired)
                    _idle.Push(worker);
            }
            ReleaseSlot();
            return response;
        }

        GraphEngineFailure? failure;
        string reason;
        if (ct.IsCancellationRequested)
            (failure, reason) = (null, "the run was cancelled");
        else if (first == memory && memory.IsCompletedSuccessfully)
            (failure, reason) = (GraphEngineFailure.OutOfMemory, $"working set over {_options.MemoryLimitBytes} bytes");
        else if (first == timeout && timeout.IsCompletedSuccessfully)
            (failure, reason) = (GraphEngineFailure.TimedOut, $"no answer within {limit}");
        else if (first == exchange && exchange.Exception?.GetBaseException() is EngineFrameTooLargeException)
            // A well-formed answer, just larger than allowed: the query asked for too much.
            (failure, reason) = (GraphEngineFailure.TooLarge, $"its answer was over {_options.MaxAnswerBytes} bytes");
        else if (first == memory)
            // The watcher itself failed: nothing says the query was at fault.
            (failure, reason) = (GraphEngineFailure.Crashed, $"the memory watch failed: {memory.Exception?.GetBaseException().Message}");
        else if (first == exchange && exchange.IsCompletedSuccessfully && await RanOutOfHeapAsync(worker))
            (failure, reason) = (GraphEngineFailure.OutOfMemory, $"its GC heap went over {_options.MemoryLimitBytes} bytes");
        else
            (failure, reason) = (GraphEngineFailure.Crashed, exchange.Exception?.GetBaseException().Message ?? "it closed its output");

        await stop.CancelAsync();
        bool retired;
        // Time, memory, answer size and cancellation are the query's doing and don't feed the crash guard; only unexplained
        // deaths do.
        lock (_gate)
            retired = Retire(worker, failure == GraphEngineFailure.Crashed ? Death.Crash : Death.Kill);
        if (retired)
        {
            _logger.LogWarning("Killed graph engine worker {WorkerId} for run {RunTag}: {Reason}", worker.Id, runTag, reason);
            await KillAsync(worker);
        }
        // The next run that finds no idle worker starts one.
        ReleaseSlot();
        try
        {
            await exchange;
        }
        catch (Exception e) when (e is IOException or InvalidDataException or OperationCanceledException or ObjectDisposedException)
        {
            // The worker is gone; its half-finished exchange has nothing more to say.
        }

        ct.ThrowIfCancellationRequested();
        throw new GraphEngineException(failure ?? GraphEngineFailure.Crashed, limit);
    }

    /// <summary>Whether the worker exited because its GC heap hit <c>DOTNET_GCHeapHardLimit</c>: it says so with
    /// <see cref="EngineExitCodes.OutOfMemory"/>. Asked only when its output closed without an answer; waits briefly for the
    /// exit, since the output closes first.</summary>
    private async Task<bool> RanOutOfHeapAsync(Worker worker)
    {
        try
        {
            await worker.Process.WaitForExitAsync().WaitAsync(ExitWait);
            return worker.Process.ExitCode == EngineExitCodes.OutOfMemory;
        }
        catch (Exception e) when (e is TimeoutException or InvalidOperationException)
        {
            return false;
        }
    }

    private async Task<EngineResponse?> ExchangeAsync(Worker worker, EngineRequest request, CancellationToken ct)
    {
        await EngineFrames.WriteAsync(worker.Input, request, ct);
        return await EngineFrames.ReadAsync<EngineResponse>(worker.Output, _options.MaxAnswerBytes, ct);
    }

    /// <summary>Completes when the worker's working set goes over the limit; never when it exits (the exchange sees that).</summary>
    private async Task WatchMemoryAsync(Worker worker, CancellationToken ct)
    {
        using var timer = new PeriodicTimer(_options.MemoryPoll, _time);
        while (await timer.WaitForNextTickAsync(ct))
        {
            long workingSet;
            try
            {
                worker.Process.Refresh();
                if (worker.Process.HasExited)
                    break;
                workingSet = worker.Process.WorkingSet64;
            }
            catch (InvalidOperationException)
            {
                // It exited between the checks.
                break;
            }
            if (workingSet > _options.MemoryLimitBytes)
                return;
        }
        await Task.Delay(Timeout.Infinite, ct);
    }

    /// <summary>Takes the worker out of the pool (under <see cref="_gate"/>), at most once; false if it already was. A
    /// crash past the crash limit pauses starting workers for a minute.</summary>
    private bool Retire(Worker worker, Death death)
    {
        if (worker.Retired)
            return false;
        worker.Retired = true;
        _workers.Remove(worker);
        if (death == Death.None)
            return true;

        _kills.Enqueue(_time.GetUtcNow());
        Prune(_kills);
        if (death != Death.Crash)
            return true;
        _crashes.Enqueue(_time.GetUtcNow());
        Prune(_crashes);
        if (_crashes.Count > _options.CrashLimitPerMinute && !IsPaused())
        {
            _pausedUntil = _time.GetUtcNow() + Minute;
            _logger.LogError("Graph engine workers crashed {Crashes} times in a minute; not starting workers until {PausedUntil}",
                _crashes.Count, _pausedUntil);
        }
        return true;
    }

    private async Task KillAsync(Worker worker)
    {
        try
        {
            worker.Process.Kill(entireProcessTree: true);
        }
        catch (InvalidOperationException)
        {
            // It had exited already.
        }
        catch (Win32Exception e)
        {
            _logger.LogError(e, "Couldn't kill graph engine worker {WorkerId}", worker.Id);
        }
        try
        {
            await worker.Process.WaitForExitAsync().WaitAsync(ExitWait);
        }
        catch (TimeoutException)
        {
            _logger.LogError("Graph engine worker {WorkerId} didn't exit within {ExitWait} of being killed", worker.Id, ExitWait);
        }
        worker.Process.Dispose();
    }

    private Worker? Start()
    {
        // The dotnet host would start without the worker's dll and exit at once; a missing worker is a failed start.
        if (!File.Exists(_options.WorkerPath))
        {
            _logger.LogError("Couldn't start a graph engine worker: {WorkerPath} doesn't exist", _options.WorkerPath);
            return null;
        }
        var process = new Process { StartInfo = CreateStartInfo(), EnableRaisingEvents = true };
        try
        {
            process.Start();
        }
        catch (Win32Exception e)
        {
            _logger.LogError(e, "Couldn't start a graph engine worker from {WorkerPath}", _options.WorkerPath);
            process.Dispose();
            return null;
        }
        var id = process.Id;
        // The worker's diagnostics (KustoLoco may print query details): at Debug, each line cut to MaxStderrLine characters.
        process.ErrorDataReceived += (_, line) =>
        {
            if (line.Data is { } text && _logger.IsEnabled(LogLevel.Debug))
                _logger.LogDebug("Graph engine worker {WorkerId}: {Line}", id,
                    text.Length > MaxStderrLine ? text[..MaxStderrLine] : text);
        };
        process.BeginErrorReadLine();
        return new Worker(process, id);
    }

    private bool IsPaused()
    {
        if (_pausedUntil is { } until && _time.GetUtcNow() >= until)
            _pausedUntil = null;
        return _pausedUntil is not null;
    }

    private void Prune(Queue<DateTimeOffset> deaths)
    {
        var since = _time.GetUtcNow() - Minute;
        while (deaths.TryPeek(out var death) && death <= since)
            deaths.Dequeue();
    }

    private enum Death
    {
        /// <summary>Retired by the pool itself (disposal).</summary>
        None,

        /// <summary>Killed for the query's doing: time, memory, size or cancellation.</summary>
        Kill,

        /// <summary>Unexplained: a malformed or missing answer, or an exit on its own.</summary>
        Crash,
    }

    private static string? DotnetHost()
    {
        // The runtime lives in <root>/shared/Microsoft.NETCore.App/<version>/; the host is <root>/dotnet.
        var root = Path.GetFullPath(Path.Combine(RuntimeEnvironment.GetRuntimeDirectory(), "..", "..", ".."));
        var host = Path.Combine(root, OperatingSystem.IsWindows() ? "dotnet.exe" : "dotnet");
        return File.Exists(host) ? host : null;
    }

    private sealed class Worker(Process process, int id)
    {
        public Process Process { get; } = process;
        public int Id { get; } = id;
        public Stream Input { get; } = process.StandardInput.BaseStream;
        public Stream Output { get; } = process.StandardOutput.BaseStream;
        public bool Busy { get; set; }
        public bool Retired { get; set; }
    }
}
