// The engine worker (spec 9). The app starts it with an empty environment and sends length-prefixed JSON frames on stdin: one
// EngineRequest, one EngineResponse back on stdout, until stdin ends. Nothing else is written to stdout; diagnostics go to
// stderr, which the app logs.
using System.Diagnostics;
using System.Globalization;
using System.Reflection;
using Kustodian.Graph.Engine;

namespace Kustodian.Engine;

public static class EngineMain
{
    // A request carries every fetched table as JSON: room for the fetch budget and its framing.
    private const int MaxRequestBytes = 512 * 1024 * 1024;

    /// <summary>Serves requests from <paramref name="input"/> until it ends, answering on <paramref name="output"/>. Returns
    /// the process exit code: 0 at the end of input, 2 for a malformed frame, <see cref="EngineExitCodes.OutOfMemory"/> when
    /// the query ran the GC heap past its hard limit, <see cref="EngineExitCodes.Crashed"/> after any other exception, which
    /// it reports in a last frame.</summary>
    public static int Run(Stream input, Stream output)
    {
        ArgumentNullException.ThrowIfNull(input);
        ArgumentNullException.ThrowIfNull(output);

        // Kusto.Language parses real and timespan literals in the current culture; the worker never depends on the machine's.
        CultureInfo.DefaultThreadCurrentCulture = CultureInfo.InvariantCulture;
        CultureInfo.DefaultThreadCurrentUICulture = CultureInfo.InvariantCulture;
        CultureInfo.CurrentCulture = CultureInfo.InvariantCulture;
        CultureInfo.CurrentUICulture = CultureInfo.InvariantCulture;

        // The pool caps the GC heap (DOTNET_GCHeapHardLimit). A query that runs past it, on this thread or any other, ends the
        // worker with an exit code that says so, so the app reports the query's memory rather than a crash. Anything else
        // unhandled is a crash, reported in a last frame.
        AppDomain.CurrentDomain.UnhandledException += (_, e) =>
        {
            if (e.ExceptionObject is not Exception ex)
                return;
            if (OutOfMemory.Is(ex))
                OutOfMemory.Exit();
            WriteCrash(output, ex);
            Environment.Exit(EngineExitCodes.Crashed);
        };

        // stdout carries frames only. KustoLoco has a console it may print to; anything written through Console goes to stderr.
        Console.SetOut(Console.Error);
        return Serve(input, output, EngineHandler.Handle);
    }

    /// <summary>The serving loop of <see cref="Run"/> with <paramref name="handle"/> answering each request; tests pass their
    /// own.</summary>
    internal static int Serve(Stream input, Stream output, Func<EngineRequest, EngineResponse> handle)
    {
        try
        {
            return ServeAsync(input, output, handle).GetAwaiter().GetResult();
        }
        catch (Exception e) when (OutOfMemory.Is(e))
        {
            OutOfMemory.Exit();
            return EngineExitCodes.OutOfMemory;
        }
        catch (Exception e)
        {
            WriteCrash(output, e);
            return EngineExitCodes.Crashed;
        }
    }

    private static async Task<int> ServeAsync(Stream input, Stream output, Func<EngineRequest, EngineResponse> handle)
    {
        try
        {
            while (await EngineFrames.ReadAsync<EngineRequest>(input, MaxRequestBytes, CancellationToken.None) is { } request)
                await EngineFrames.WriteAsync(output, handle(request), CancellationToken.None);
            return 0;
        }
        catch (Exception e) when (e is InvalidDataException or EngineFrameTooLargeException)
        {
            await Console.Error.WriteLineAsync($"Malformed request frame: {e.Message}");
            return 2;
        }
    }

    /// <summary>Writes the crash frame, best effort: a broken output, or one the crash left half written, loses it, and the
    /// app has the exit code alone.</summary>
    private static void WriteCrash(Stream output, Exception exception)
    {
        try
        {
            EngineFrames.WriteAsync(output, new EngineResponse(null, null, 0, 0, null, null, CrashOf(exception)), CancellationToken.None)
                .GetAwaiter().GetResult();
        }
        catch (Exception e)
        {
            Console.Error.WriteLine($"Couldn't write the crash frame: {e.GetType().FullName}");
        }
    }

    /// <summary>The exception, then its inner exceptions (an <see cref="AggregateException"/>'s all), at most 10.</summary>
    internal static EngineCrash CrashOf(Exception exception)
    {
        var exceptions = new List<EngineCrashException>();
        var pending = new Queue<Exception>();
        pending.Enqueue(exception);
        while (exceptions.Count < 10 && pending.TryDequeue(out var current))
        {
            var frames = new StackTrace(current).GetFrames()
                .Select(f => f.GetMethod())
                .OfType<MethodBase>()
                .Select(m => new EngineStackFrame(
                    m.DeclaringType is { } t ? $"{t.FullName}.{m.Name}" : m.Name, m.Module.Assembly.GetName().Name ?? ""))
                .ToList();
            exceptions.Add(new EngineCrashException(current.GetType().FullName ?? "", current.Message, frames));
            if (current is AggregateException aggregate)
                foreach (var inner in aggregate.InnerExceptions)
                    pending.Enqueue(inner);
            else if (current.InnerException is { } single)
                pending.Enqueue(single);
        }
        return new EngineCrash(exceptions);
    }
}

internal static class OutOfMemory
{
    /// <summary>An <see cref="OutOfMemoryException"/> (or KustoLoco's report of one), or one wrapped (by a task or a
    /// parallel loop).</summary>
    public static bool Is(Exception e) => e switch
    {
        OutOfMemoryException or QueryOutOfMemoryException => true,
        AggregateException aggregate => aggregate.Flatten().InnerExceptions.Any(Is),
        _ => e.InnerException is { } inner && Is(inner),
    };

    public static void Exit()
    {
        Console.Error.WriteLine("The query ran out of memory (GC heap hard limit).");
        Environment.Exit(EngineExitCodes.OutOfMemory);
    }
}
