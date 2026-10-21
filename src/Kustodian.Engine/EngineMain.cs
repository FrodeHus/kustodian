// The engine worker (spec 9). The app starts it with an empty environment and sends length-prefixed JSON frames on stdin: one
// EngineRequest, one EngineResponse back on stdout, until stdin ends. Nothing else is written to stdout; diagnostics go to
// stderr, which the app logs.
using System.Globalization;
using Kustodian.Graph.Engine;

namespace Kustodian.Engine;

public static class EngineMain
{
    // A request carries every fetched table as JSON: room for the fetch budget and its framing.
    private const int MaxRequestBytes = 512 * 1024 * 1024;

    /// <summary>Serves requests from <paramref name="input"/> until it ends, answering on <paramref name="output"/>. Returns
    /// the process exit code: 0 at the end of input, 2 for a malformed frame, <see cref="EngineExitCodes.OutOfMemory"/> when
    /// the query ran the GC heap past its hard limit.</summary>
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
        // worker with an exit code that says so, so the app reports the query's memory rather than a crash.
        AppDomain.CurrentDomain.UnhandledException += (_, e) =>
        {
            if (e.ExceptionObject is Exception ex && OutOfMemory.Is(ex))
                OutOfMemory.Exit();
        };

        // stdout carries frames only. KustoLoco has a console it may print to; anything written through Console goes to stderr.
        Console.SetOut(Console.Error);
        try
        {
            return ServeAsync(input, output).GetAwaiter().GetResult();
        }
        catch (Exception e) when (OutOfMemory.Is(e))
        {
            OutOfMemory.Exit();
            return EngineExitCodes.OutOfMemory;
        }
    }

    private static async Task<int> ServeAsync(Stream input, Stream output)
    {
        try
        {
            while (await EngineFrames.ReadAsync<EngineRequest>(input, MaxRequestBytes, CancellationToken.None) is { } request)
                await EngineFrames.WriteAsync(output, EngineHandler.Handle(request), CancellationToken.None);
            return 0;
        }
        catch (Exception e) when (e is InvalidDataException or EngineFrameTooLargeException)
        {
            await Console.Error.WriteLineAsync($"Malformed request frame: {e.Message}");
            return 2;
        }
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
