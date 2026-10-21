using Kustodian.Engine;

namespace Kustodian.EngineWorker;

/// <summary>The engine worker as a program of its own, for the pool's tests: the same <see cref="EngineMain"/> the app runs
/// for <c>--engine</c>.</summary>
internal static class Program
{
    private static int Main()
    {
        using var input = Console.OpenStandardInput();
        using var output = Console.OpenStandardOutput();
        return EngineMain.Run(input, output);
    }
}
