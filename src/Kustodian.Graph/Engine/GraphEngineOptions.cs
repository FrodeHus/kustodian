namespace Kustodian.Graph.Engine;

/// <summary>The engine worker pool's limits (spec 9).</summary>
public sealed class GraphEngineOptions
{
    /// <summary>The most workers, started on demand; one execution each at a time.</summary>
    public int Workers { get; set; } = 2;

    /// <summary>The worker. A <c>.dll</c> runs on the dotnet host of the runtime the app runs on; anything else is started as
    /// an executable. By default the app itself, started with <see cref="WorkerArgs"/>.</summary>
    public string WorkerPath { get; set; } = Environment.ProcessPath ?? "";

    /// <summary>The arguments the worker is started with, after the <c>.dll</c> path when there is one. The app's own engine
    /// mode is <c>--engine</c>.</summary>
    public IReadOnlyList<string> WorkerArgs { get; set; } = ["--engine"];

    /// <summary>The longest an execution may take before its worker is killed.</summary>
    public TimeSpan Timeout { get; set; } = TimeSpan.FromSeconds(120);

    /// <summary>The working set above which a worker is killed (1 GiB by default), and its GC heap's hard limit.</summary>
    public long MemoryLimitBytes { get; set; } = 1L << 30;

    /// <summary>How long a run waits for a free worker before it fails busy.</summary>
    public TimeSpan WaitForWorker { get; set; } = TimeSpan.FromSeconds(10);

    /// <summary>The largest answer frame; a longer one kills the worker.</summary>
    public int MaxAnswerBytes { get; set; } = 100 << 20;

    /// <summary>How often a running worker's working set is checked.</summary>
    public TimeSpan MemoryPoll { get; set; } = TimeSpan.FromMilliseconds(250);

    /// <summary>Worker deaths in a minute the pool tolerates; one more and it stops starting workers for a minute.</summary>
    public int CrashLimitPerMinute { get; set; } = 10;
}
