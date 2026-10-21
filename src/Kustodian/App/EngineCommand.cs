namespace Kustodian.App;

/// <summary>How the engine pool starts a worker: the app itself in engine mode.</summary>
public sealed record EngineCommand(string WorkerPath, IReadOnlyList<string> WorkerArgs)
{
    /// <summary>When the app runs on the dotnet host (<c>dotnet Kustodian.dll</c>), the worker is the entry assembly's
    /// <c>.dll</c>, which the pool runs on the same host; otherwise it is the process's own executable. Either way with
    /// <c>--engine</c>.</summary>
    public static EngineCommand Resolve(string? processPath, string entryAssemblyPath)
    {
        var worker = processPath is null || string.Equals(FileName(processPath), "dotnet", StringComparison.OrdinalIgnoreCase)
            ? entryAssemblyPath
            : processPath;
        return new EngineCommand(worker, [EntryPoint.EngineFlag]);
    }

    /// <summary>The file name without extension, for Windows and Unix paths alike, whatever platform this runs on.</summary>
    private static string FileName(string path)
    {
        var name = path[(path.LastIndexOfAny(['/', '\\']) + 1)..];
        var dot = name.LastIndexOf('.');
        return dot > 0 ? name[..dot] : name;
    }
}
