namespace Kustodian.App;

/// <summary>What the process does, chosen from its arguments before anything else loads.</summary>
public static class EntryPoint
{
    public const string EngineFlag = "--engine";
    public const string VersionFlag = "--version";

    /// <summary>With <c>--engine</c> the process is an engine worker and runs <paramref name="runEngine"/> only; with
    /// <c>--version</c> it runs <paramref name="printVersion"/> only; otherwise it runs <paramref name="openWindow"/>. Returns
    /// the process exit code.</summary>
    public static int Dispatch(string[] args, Func<int> runEngine, Func<int> openWindow, Func<int> printVersion) =>
        args.Length > 0 && args[0] == EngineFlag ? runEngine()
        : args.Length > 0 && args[0] == VersionFlag ? printVersion()
        : openWindow();
}
