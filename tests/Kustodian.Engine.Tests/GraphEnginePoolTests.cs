using System.Diagnostics;
using System.Text.Json.Nodes;
using Kustodian.Graph.Engine;
using Microsoft.Extensions.Logging.Abstractions;

namespace Kustodian.Engine.Tests;

/// <summary>The pool against the real worker, Kustodian.TestEngineWorker, copied into engine-worker/ under the test output.
/// Every test disposes its pool, which kills its workers.</summary>
public sealed class GraphEnginePoolTests
{
    private static readonly DateTimeOffset Now = new(2026, 10, 20, 0, 0, 0, TimeSpan.Zero);

    // Catastrophic regex backtracking: about 1.6^60 paths to try, so hours at any speed a laptop or a container has, in a
    // few kilobytes of memory. (The brief's "range x from 1 to 100000000000 step 1 | count" doesn't do: KustoLoco builds
    // the range in memory, so it's killed for memory within a second, not for time.)
    internal static readonly string SlowQuery = $"print r = '{new string('a', 60)}b' matches regex '^(a|aa)+$'";

    /// <summary>The worker the test project copies next to itself, started on the dotnet host, without the app's
    /// <c>--engine</c> argument.</summary>
    private static readonly string WorkerDll = Path.Combine(AppContext.BaseDirectory, "engine-worker", "Kustodian.TestEngineWorker.dll");

    private static GraphEnginePool Pool(Action<GraphEngineOptions>? configure = null)
    {
        var options = new GraphEngineOptions { Workers = 1, WorkerPath = WorkerDll, WorkerArgs = [] };
        configure?.Invoke(options);
        return new GraphEnginePool(options, NullLogger<GraphEnginePool>.Instance, TimeProvider.System);
    }

    private static EngineRequest Query(string kql, params EngineTable[] tables) => new(kql, Now, tables, 10_000);

    /// <summary>Starts the pool's worker (workers start on demand) and returns its process id.</summary>
    private static async Task<int> WarmAsync(GraphEnginePool pool)
    {
        await pool.RunAsync(Query("print 1"), "run-warm", TestContext.Current.CancellationToken);
        return Assert.Single(pool.Snapshot().WorkerIds);
    }

    private static bool IsGone(int pid)
    {
        try
        {
            using var process = Process.GetProcessById(pid);
            return process.HasExited;
        }
        catch (ArgumentException)
        {
            return true;
        }
    }

    private static async Task<GraphEngineFailure> FailureOf(Task task)
    {
        var e = await Assert.ThrowsAsync<GraphEngineException>(() => task);
        return e.Failure;
    }

    [Fact]
    public async Task No_worker_starts_until_a_run_needs_one()
    {
        await using var pool = Pool();

        Assert.Equal(0, pool.Snapshot().Alive);
        await pool.RunAsync(Query("print 1"), "run-1", TestContext.Current.CancellationToken);

        Assert.Equal(1, pool.Snapshot().Alive);
    }

    [Fact]
    public async Task Starts_another_worker_only_while_every_worker_is_busy()
    {
        await using var pool = Pool(o => o.Workers = 2);
        var ct = TestContext.Current.CancellationToken;
        await pool.RunAsync(Query("print 1"), "run-1", ct);
        await pool.RunAsync(Query("print 2"), "run-2", ct);
        Assert.Equal(1, pool.Snapshot().Alive);   // the idle worker was reused

        using var cancel = CancellationTokenSource.CreateLinkedTokenSource(ct);
        var running = pool.RunAsync(Query(SlowQuery), "run-long", cancel.Token);
        while (pool.Snapshot().Busy == 0)
            await Task.Delay(10, ct);
        var answer = await pool.RunAsync(Query("print 3"), "run-3", ct);

        Assert.Null(answer.Error);
        Assert.Equal(2, pool.Snapshot().Alive);
        await cancel.CancelAsync();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => running);
    }

    [Fact]
    public async Task Never_starts_more_than_the_configured_workers()
    {
        await using var pool = Pool(o => o.WaitForWorker = TimeSpan.FromMilliseconds(200));
        var ct = TestContext.Current.CancellationToken;
        using var cancel = CancellationTokenSource.CreateLinkedTokenSource(ct);
        var running = pool.RunAsync(Query(SlowQuery), "run-long", cancel.Token);
        while (pool.Snapshot().Busy == 0)
            await Task.Delay(10, ct);

        Assert.Equal(GraphEngineFailure.Busy, await FailureOf(pool.RunAsync(Query("print 1"), "run-waiting", ct)));
        Assert.Equal(1, pool.Snapshot().Alive);
        await cancel.CancelAsync();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => running);
    }

    [Fact]
    public async Task Worker_gets_the_memory_limit_as_its_gc_heap_hard_limit()
    {
        await using var pool = Pool(o => o.MemoryLimitBytes = 512L * 1024 * 1024);

        var start = pool.CreateStartInfo();

        // .NET reads GCHeapHardLimit as hexadecimal.
        Assert.Equal("0x20000000", start.Environment["DOTNET_GCHeapHardLimit"]);
    }

    [Fact]
    public void Default_options_match_spec()
    {
        var options = new GraphEngineOptions();

        Assert.Equal(2, options.Workers);
        Assert.Equal(TimeSpan.FromSeconds(120), options.Timeout);
        Assert.Equal(1L << 30, options.MemoryLimitBytes);
        Assert.Equal(["--engine"], options.WorkerArgs);
        Assert.Equal(Environment.ProcessPath, options.WorkerPath);
    }

    [Fact]
    public async Task Worker_args_are_passed_for_a_dll_and_for_an_executable()
    {
        await using var dll = Pool(o => o.WorkerArgs = ["--engine", "--x"]);
        await using var exe = Pool(o =>
        {
            o.WorkerPath = Path.Combine(Path.GetTempPath(), "some-worker");
            o.WorkerArgs = ["--engine"];
        });

        Assert.Equal([Path.GetFullPath(WorkerDll), "--engine", "--x"], dll.CreateStartInfo().ArgumentList);
        Assert.Equal(["--engine"], exe.CreateStartInfo().ArgumentList);
    }

    [Fact]
    public async Task Dispose_kills_running_workers()
    {
        var pool = Pool();
        var ct = TestContext.Current.CancellationToken;
        var worker = await WarmAsync(pool);
        var running = pool.RunAsync(Query(SlowQuery), "run-long", ct);
        while (pool.Snapshot().Busy == 0)
            await Task.Delay(10, ct);

        await pool.DisposeAsync();

        var clock = Stopwatch.StartNew();
        while (!IsGone(worker) && clock.Elapsed < TimeSpan.FromSeconds(5))
            await Task.Delay(20, ct);
        Assert.True(IsGone(worker), "The worker is still running after the pool was disposed.");
        var e = await Record.ExceptionAsync(() => running.WaitAsync(TimeSpan.FromSeconds(5), ct));
        Assert.True(e is OperationCanceledException or GraphEngineException, $"RunAsync ended with {e?.GetType().Name ?? "an answer"}.");
    }

    [Fact]
    public async Task Clean_answer_reuses_the_worker()
    {
        await using var pool = Pool();

        var first = await pool.RunAsync(Query("print x = 1"), "run-1", TestContext.Current.CancellationToken);
        var workerAfterFirst = Assert.Single(pool.Snapshot().WorkerIds);
        var second = await pool.RunAsync(Query("print x = 2"), "run-2", TestContext.Current.CancellationToken);

        Assert.Null(first.Error);
        Assert.Equal(1, first.Rows![0][0].GetInt64());
        Assert.Equal(2, second.Rows![0][0].GetInt64());
        Assert.Equal(workerAfterFirst, Assert.Single(pool.Snapshot().WorkerIds));
    }

    [Fact]
    public async Task A_throwing_progress_keeps_no_slot_or_worker_and_killed_comes_after_cleanup()
    {
        await using var pool = Pool(o =>
        {
            o.Timeout = TimeSpan.FromSeconds(1);
            o.WaitForWorker = TimeSpan.FromMilliseconds(200);
        });
        var progress = new ThrowingProgress(pool);

        // Every event throws; each run still ends as it would have, and frees its slot (one worker, one slot: a leaked slot
        // would fail the next run busy).
        var first = await pool.RunAsync(Query("print x = 1"), "run-1", progress, TestContext.Current.CancellationToken);
        var worker = Assert.Single(pool.Snapshot().WorkerIds);
        var second = await pool.RunAsync(Query("print x = 2"), "run-2", progress, TestContext.Current.CancellationToken);
        var failure = await FailureOf(pool.RunAsync(Query(SlowQuery), "run-slow", progress, TestContext.Current.CancellationToken));
        var third = await pool.RunAsync(Query("print x = 3"), "run-3", progress, TestContext.Current.CancellationToken);

        Assert.Equal(1, first.Rows![0][0].GetInt64());
        Assert.Equal(2, second.Rows![0][0].GetInt64());
        Assert.Equal(GraphEngineFailure.TimedOut, failure);
        Assert.Equal(3, third.Rows![0][0].GetInt64());
        Assert.True(IsGone(worker));
        Assert.Equal(0, pool.Snapshot().Busy);
        Assert.Equal(["start", "done", "start", "done", "start", "killed", "start", "done"], progress.Events.Select(e => e.Info.Event));
        // When killed is reported the worker is out of the pool and its slot is free.
        var killed = Assert.Single(progress.Events, e => e.Info.Event == "killed");
        Assert.Equal("timeout", killed.Info.Reason);
        Assert.DoesNotContain(worker, killed.Snapshot.WorkerIds);
        Assert.Equal(0, killed.Snapshot.Busy);
    }

    /// <summary>Records each event with the pool's state at that moment, then throws.</summary>
    private sealed class ThrowingProgress(GraphEnginePool pool) : IProgress<EngineRunInfo>
    {
        public List<(EngineRunInfo Info, GraphEngineSnapshot Snapshot)> Events { get; } = [];

        public void Report(EngineRunInfo value)
        {
            Events.Add((value, pool.Snapshot()));
            throw new InvalidOperationException("The progress failed.");
        }
    }

    [Fact]
    public async Task Error_answer_is_a_clean_answer()
    {
        await using var pool = Pool();
        var worker = await WarmAsync(pool);

        var answer = await pool.RunAsync(Query("print x = no_such_function()"), "run-error", TestContext.Current.CancellationToken);

        Assert.NotNull(answer.Error);
        Assert.Equal(worker, Assert.Single(pool.Snapshot().WorkerIds));
        Assert.Equal(0, pool.Snapshot().KillsLastMinute);
    }

    [Fact]
    public async Task Slow_query_is_killed_at_the_time_limit()
    {
        await using var pool = Pool(o => o.Timeout = TimeSpan.FromSeconds(1));
        var worker = await WarmAsync(pool);

        var clock = Stopwatch.StartNew();
        var failure = await FailureOf(pool.RunAsync(Query(SlowQuery), "run-slow", TestContext.Current.CancellationToken));

        Assert.Equal(GraphEngineFailure.TimedOut, failure);
        Assert.InRange(clock.Elapsed, TimeSpan.FromSeconds(1), TimeSpan.FromSeconds(3));
        Assert.True(IsGone(worker));
    }

    [Fact]
    public async Task Row_multiplying_join_is_killed_at_the_memory_limit()
    {
        await using var pool = Pool(o => o.MemoryLimitBytes = 200L * 1024 * 1024);

        var failure = await FailureOf(pool.RunAsync(JoinRequest(), "run-join", TestContext.Current.CancellationToken));

        Assert.Equal(GraphEngineFailure.OutOfMemory, failure);
    }

    [Fact]
    public async Task Join_past_the_gc_heap_limit_is_out_of_memory_not_a_crash()
    {
        // The working-set watch never looks: only the worker's GC heap limit can stop the join.
        await using var pool = Pool(o =>
        {
            o.MemoryLimitBytes = 200L * 1024 * 1024;
            o.MemoryPoll = TimeSpan.FromHours(1);
        });

        var failure = await FailureOf(pool.RunAsync(JoinRequest(), "run-join", TestContext.Current.CancellationToken));

        Assert.Equal(GraphEngineFailure.OutOfMemory, failure);
        Assert.Equal(0, pool.Snapshot().CrashesLastMinute);
        Assert.Equal(1, pool.Snapshot().KillsLastMinute);
    }

    // 3,000 rows joined to themselves on one key is 9,000,000 rows: far past 200 MB, killed long before the machine notices
    // (about 0.6 s on a laptop). A worker that has answered a small query sits at about 115 MB.
    private static EngineRequest JoinRequest()
    {
        var rows = Enumerable.Range(1, 3_000)
            .Select(i => new JsonObject { ["id"] = i, ["name"] = $"application number {i}" })
            .ToList();
        var table = new EngineTable("apps", [new EngineColumn("id", "long"), new EngineColumn("name", "string")], rows);
        return Query("apps | extend k = 1 | join kind=inner (apps | extend k = 1) on k | summarize count() by name, name1", table);
    }

    [Fact]
    public async Task Next_query_after_a_kill_gets_a_fresh_worker()
    {
        await using var pool = Pool(o => o.Timeout = TimeSpan.FromSeconds(1));
        var killed = await WarmAsync(pool);
        await FailureOf(pool.RunAsync(Query(SlowQuery), "run-slow", TestContext.Current.CancellationToken));

        var answer = await pool.RunAsync(Query("print 1"), "run-next", TestContext.Current.CancellationToken);

        Assert.Null(answer.Error);
        Assert.Equal(1, answer.Rows![0][0].GetInt64());
        Assert.NotEqual(killed, Assert.Single(pool.Snapshot().WorkerIds));
    }

    [Fact]
    public async Task Cancellation_kills_the_worker()
    {
        await using var pool = Pool();
        var worker = await WarmAsync(pool);
        using var cancel = CancellationTokenSource.CreateLinkedTokenSource(TestContext.Current.CancellationToken);
        cancel.CancelAfter(TimeSpan.FromMilliseconds(500));

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => pool.RunAsync(Query(SlowQuery), "run-cancel", cancel.Token));

        Assert.True(IsGone(worker));
    }

    [Fact]
    public async Task Waits_for_a_free_worker_then_fails_busy()
    {
        await using var pool = Pool(o => o.WaitForWorker = TimeSpan.FromMilliseconds(200));
        var running = pool.RunAsync(Query(SlowQuery), "run-long", TestContext.Current.CancellationToken);
        while (pool.Snapshot().Busy == 0)
            await Task.Delay(10, TestContext.Current.CancellationToken);

        var clock = Stopwatch.StartNew();
        var failure = await FailureOf(pool.RunAsync(Query("print 1"), "run-waiting", TestContext.Current.CancellationToken));

        Assert.Equal(GraphEngineFailure.Busy, failure);
        Assert.True(clock.Elapsed >= TimeSpan.FromMilliseconds(190), $"Failed after {clock.Elapsed}, without waiting.");
        await pool.DisposeAsync();
        await Assert.ThrowsAsync<GraphEngineException>(() => running);
    }


    [Fact]
    public async Task Time_memory_and_cancellation_kills_do_not_pause_the_pool()
    {
        // The query's own fault, not the worker's: a hunter's runaway join across many runs mustn't pause the pool for
        // everyone. Twelve kills (one for time, one for memory, ten cancellations) against a crash limit of two.
        await using var pool = Pool(o =>
        {
            o.Timeout = TimeSpan.FromSeconds(2);
            o.MemoryLimitBytes = 200L * 1024 * 1024;
            o.CrashLimitPerMinute = 2;
        });
        var ct = TestContext.Current.CancellationToken;
        Assert.Equal(GraphEngineFailure.TimedOut, await FailureOf(pool.RunAsync(Query(SlowQuery), "run-slow", ct)));
        Assert.Equal(GraphEngineFailure.OutOfMemory, await FailureOf(pool.RunAsync(JoinRequest(), "run-join", ct)));
        for (var i = 0; i < 10; i++)
        {
            using var cancel = CancellationTokenSource.CreateLinkedTokenSource(ct);
            cancel.CancelAfter(TimeSpan.FromMilliseconds(100));
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => pool.RunAsync(Query(SlowQuery), $"run-cancel-{i}", cancel.Token));
        }

        var answer = await pool.RunAsync(Query("print 1"), "run-after", ct);

        Assert.Null(answer.Error);
        var snapshot = pool.Snapshot();
        Assert.False(snapshot.Paused);
        Assert.Equal(12, snapshot.KillsLastMinute);
        Assert.Equal(0, snapshot.CrashesLastMinute);
    }

    [Fact]
    public async Task Crash_guard_pauses_after_too_many_crashes()
    {
        using var garbage = StandInWorker.Create(StandInWorker.GarbageAnswer);
        await using var pool = Pool(o =>
        {
            o.WorkerPath = garbage.Path;
            o.CrashLimitPerMinute = 2;
        });
        for (var i = 0; i < 3; i++)
            Assert.Equal(GraphEngineFailure.Crashed,
                await FailureOf(pool.RunAsync(Query("print 1"), $"run-{i}", TestContext.Current.CancellationToken)));

        var failure = await FailureOf(pool.RunAsync(Query("print 1"), "run-after", TestContext.Current.CancellationToken));

        Assert.Equal(GraphEngineFailure.Busy, failure);
        var snapshot = pool.Snapshot();
        Assert.True(snapshot.Paused);
        Assert.Equal(3, snapshot.CrashesLastMinute);
        Assert.Equal(0, snapshot.Alive);
    }

    [Fact]
    public async Task An_answer_over_the_limit_is_the_querys_doing_not_a_crash()
    {
        await using var pool = Pool(o =>
        {
            o.MaxAnswerBytes = 4096;
            o.CrashLimitPerMinute = 0;
        });

        var e = await Assert.ThrowsAsync<GraphEngineException>(
            () => pool.RunAsync(Query("range x from 1 to 5000 step 1"), "run-big", TestContext.Current.CancellationToken));

        Assert.Equal(GraphEngineFailure.TooLarge, e.Failure);
        Assert.Equal("The result was too large. Add a project or take to narrow it.", e.Message);
        var snapshot = pool.Snapshot();
        Assert.Equal(0, snapshot.CrashesLastMinute);
        Assert.Equal(1, snapshot.KillsLastMinute);
        Assert.False(snapshot.Paused);
        // The next query gets a fresh worker.
        Assert.Null((await pool.RunAsync(Query("print 1"), "run-next", TestContext.Current.CancellationToken)).Error);
    }

    [Fact]
    public async Task Worker_stderr_is_logged_at_debug_cut_to_500_characters()
    {
        using var noisy = StandInWorker.Create($"echo '{new string('e', 2000)}' >&2\n/bin/cat > /dev/null");
        var logger = new RecordingLogger();
        await using var pool = new GraphEnginePool(
            new GraphEngineOptions { Workers = 1, WorkerPath = noisy.Path, WorkerArgs = [], Timeout = TimeSpan.FromSeconds(1) },
            logger, TimeProvider.System);

        await Assert.ThrowsAsync<GraphEngineException>(
            () => pool.RunAsync(Query("print 1"), "run-noisy", TestContext.Current.CancellationToken));

        var line = Assert.Single(logger.Entries, e => e.Message.Contains("eeee", StringComparison.Ordinal));
        Assert.Equal(Microsoft.Extensions.Logging.LogLevel.Debug, line.Level);
        Assert.True(line.Message.Length < 600, $"{line.Message.Length} characters logged");
        Assert.Contains(new string('e', 500), line.Message);
        Assert.DoesNotContain(new string('e', 501), line.Message);
    }

    [Fact]
    public async Task Malformed_answer_is_a_crash()
    {
        using var garbage = StandInWorker.Create(StandInWorker.GarbageAnswer);
        await using var pool = Pool(o => o.WorkerPath = garbage.Path);

        var failure = await FailureOf(pool.RunAsync(Query("print 1"), "run-garbage", TestContext.Current.CancellationToken));

        Assert.Equal(GraphEngineFailure.Crashed, failure);
    }

    [Fact]
    public async Task Worker_starts_with_an_empty_environment()
    {
        string[] planted = ["ConnectionStrings__db", "DOTNET_ConnectionStrings__db", "DOTNET_SECRET", "DOTNET_gcServer"];
        foreach (var name in planted)
            Environment.SetEnvironmentVariable(name, name == "DOTNET_gcServer" ? "0" : "secret");
        try
        {
            await using var pool = Pool();

            var start = pool.CreateStartInfo();

            Assert.DoesNotContain("ConnectionStrings__db", start.Environment.Keys);
            Assert.DoesNotContain("DOTNET_ConnectionStrings__db", start.Environment.Keys);
            Assert.DoesNotContain("DOTNET_SECRET", start.Environment.Keys);
            Assert.Equal("0", start.Environment["DOTNET_gcServer"]);
            Assert.All(start.Environment.Keys, name => Assert.True(
                name.StartsWith("DOTNET_", StringComparison.Ordinal) || (OperatingSystem.IsWindows() && name == "SystemRoot"),
                $"{name} is passed to the worker."));
            // And the worker runs with it.
            var answer = await pool.RunAsync(Query("print 1"), "run-env", TestContext.Current.CancellationToken);
            Assert.Null(answer.Error);
        }
        finally
        {
            foreach (var name in planted)
                Environment.SetEnvironmentVariable(name, null);
        }
    }

    [Fact]
    public async Task Timed_out_message_names_the_configured_limit()
    {
        await using var pool = Pool(o => o.Timeout = TimeSpan.FromSeconds(1));

        var e = await Assert.ThrowsAsync<GraphEngineException>(
            () => pool.RunAsync(Query(SlowQuery), "run-slow", TestContext.Current.CancellationToken));

        Assert.Equal("Timed out after 1 s", e.Message);
    }

    [Fact]
    public void Failure_messages_are_the_specs()
    {
        Assert.Equal("Another query is using the engine. Try again when it finishes.", new GraphEngineException(GraphEngineFailure.Busy).Message);
        Assert.Equal("Timed out after 30 s", new GraphEngineException(GraphEngineFailure.TimedOut).Message);
        Assert.Equal("Timed out after 30 s", new GraphEngineException(GraphEngineFailure.TimedOut, TimeSpan.FromSeconds(30)).Message);
        Assert.Equal("Timed out after 45 s", new GraphEngineException(GraphEngineFailure.TimedOut, TimeSpan.FromSeconds(45)).Message);
        Assert.Equal("Timed out after 2 s", new GraphEngineException(GraphEngineFailure.TimedOut, TimeSpan.FromMilliseconds(1500)).Message);
        Assert.Equal("The query needed too much memory (it may multiply rows: check joins)",
            new GraphEngineException(GraphEngineFailure.OutOfMemory).Message);
        Assert.Equal("The query engine stopped unexpectedly", new GraphEngineException(GraphEngineFailure.Crashed).Message);
        Assert.Equal("The result was too large. Add a project or take to narrow it.", new GraphEngineException(GraphEngineFailure.TooLarge).Message);
    }
}

/// <summary>Keeps what the pool logs, for the tests that look at it.</summary>
internal sealed class RecordingLogger : Microsoft.Extensions.Logging.ILogger<GraphEnginePool>
{
    private readonly List<(Microsoft.Extensions.Logging.LogLevel Level, string Message)> _entries = [];

    public IReadOnlyList<(Microsoft.Extensions.Logging.LogLevel Level, string Message)> Entries
    {
        get
        {
            lock (_entries)
                return [.. _entries];
        }
    }

    public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;

    public bool IsEnabled(Microsoft.Extensions.Logging.LogLevel logLevel) => true;

    public void Log<TState>(Microsoft.Extensions.Logging.LogLevel logLevel, Microsoft.Extensions.Logging.EventId eventId, TState state,
        Exception? exception, Func<TState, Exception?, string> formatter)
    {
        lock (_entries)
            _entries.Add((logLevel, formatter(state, exception)));
    }
}

/// <summary>A shell script standing in for the worker, in its own temporary folder. Skips the test on Windows. To hang,
/// a script runs <c>/bin/cat &gt; /dev/null</c> without <c>exec</c>, so the shell keeps the pool's stdout pipe open (an
/// exec'd cat would close it, which reads as a crash).</summary>
internal sealed class StandInWorker : IDisposable
{
    private readonly DirectoryInfo _directory;

    private StandInWorker(DirectoryInfo directory, string path)
    {
        _directory = directory;
        Path = path;
    }

    public string Path { get; }

    /// <summary>Answers with a malformed frame (a 7-byte frame that isn't JSON), then hangs.</summary>
    public const string GarbageAnswer = "printf '\\000\\000\\000\\007garbage'\n/bin/cat > /dev/null";

    public static StandInWorker Create(string body)
    {
        Assert.SkipWhen(OperatingSystem.IsWindows(), "The stand-in worker is a shell script.");
        var directory = Directory.CreateTempSubdirectory("kustodian-engine-test-");
        var path = System.IO.Path.Combine(directory.FullName, "stand-in-worker.sh");
        File.WriteAllText(path, $"#!/bin/sh\n{body}\n");
        if (!OperatingSystem.IsWindows())
            File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        return new StandInWorker(directory, path);
    }

    public void Dispose() => _directory.Delete(recursive: true);
}
