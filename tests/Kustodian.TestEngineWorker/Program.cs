using Kustodian.Engine;

namespace Kustodian.TestEngineWorker;

/// <summary>The engine worker as a program of its own, for the pool's tests: the same <see cref="EngineMain"/> the app runs
/// for <c>--engine</c>.</summary>
internal static class Program
{
    private static async Task<int> Main()
    {
        await using var input = Console.OpenStandardInput();
        await using var output = Console.OpenStandardOutput();
        return await EngineMain.RunAsync(input, output);
    }
}
