using System.Globalization;
using Kustodian.Graph.Engine;
using Kustodian.Graph.Run;
using Kustodian.Storage;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

namespace Kustodian.Settings;

/// <summary>The app's settings (spec 6.11 and 9), as <c>settings.json</c> holds them and the UI edits them.
/// <see cref="Theme"/> is <c>dark</c>, <c>light</c> or <c>system</c>; <see cref="RawDefaultVersion"/> is the Graph version the
/// raw request tab starts with, <c>beta</c> or <c>v1.0</c>.</summary>
public sealed record AppSettings(int Version, string Theme, string RawDefaultVersion, SignInDefaults SignIn, LimitSettings Limits)
{
    public const int CurrentVersion = 1;

    public static AppSettings Default { get; } = new(CurrentVersion, "dark", "beta", new SignInDefaults(null, null), LimitSettings.Default);
}

/// <summary>The client ID and tenant the sign-in screen offers for "My own app registration", when set.</summary>
public sealed record SignInDefaults(string? ClientId, string? Tenant);

/// <summary>The limits (spec 9), in the units the UI shows. They apply when the app starts.</summary>
public sealed record LimitSettings(int GraphObjectsPerTable, int FetchBudgetMb, int EngineTimeoutSeconds, int EngineHeapMb,
    int EngineWorkers, int PerObjectReadsPerTable, int PerObjectCacheMinutes, int GraphRowsPerRun)
{
    public static LimitSettings Default { get; } = new(50_000, 512, 120, 1024, 2, 2_000, 30, 50_000);
}

/// <summary>Settings that were refused; the message names the setting and what it may be.</summary>
public sealed class SettingsRejectedException(string message) : Exception(message);

/// <summary>
/// Owns <c>settings.json</c>: reads it (the defaults when it is missing; a corrupt or invalid file is moved aside, the defaults
/// are used and a warning is logged) and writes it after checking every value is in range. <see cref="MovedAside"/> says a read
/// found the file corrupt; it stays true for the rest of the session, so the UI can say the defaults are in use. A file that
/// can't be opened or moved aside at all (an I/O error, no permission) reads as the defaults too, never an error, so the app
/// still starts; <see cref="Unreadable"/> says so for the rest of the session.
/// </summary>
public sealed class SettingsService(JsonFileStore store, ILogger<SettingsService>? logger = null)
{
    public const string FileName = "settings.json";

    private static readonly string[] Themes = ["dark", "light", "system"];
    private static readonly string[] RawVersions = ["beta", "v1.0"];
    private const long BytesPerMegabyte = 1L << 20;

    private sealed record Range(string Name, int Min, int Max, Func<LimitSettings, int> Value);

    private static readonly Range[] Ranges =
    [
        new("Graph objects per table", 1_000, 1_000_000, l => l.GraphObjectsPerTable),
        new("Graph fetch budget per run (MB)", 64, 8_192, l => l.FetchBudgetMb),
        new("Engine timeout (seconds)", 10, 3_600, l => l.EngineTimeoutSeconds),
        new("Engine heap limit per worker (MB)", 256, 16_384, l => l.EngineHeapMb),
        new("Engine workers", 1, 8, l => l.EngineWorkers),
        new("Per-object reads per table", 0, 20_000, l => l.PerObjectReadsPerTable),
        new("Per-object cache (minutes)", 0, 1_440, l => l.PerObjectCacheMinutes),
        new("Rows returned per Graph run", 1_000, 1_000_000, l => l.GraphRowsPerRun),
    ];

    private readonly UserDataFile<AppSettings> _file = new(store, FileName, () => AppSettings.Default, s => Problem(s) is null);
    private readonly ILogger<SettingsService> _log = logger ?? NullLogger<SettingsService>.Instance;
    private volatile bool _movedAside;
    private volatile bool _unreadable;

    /// <summary>Whether a read this session found <c>settings.json</c> corrupt and moved it aside. The app reads the settings
    /// first at startup, so this is true from then on when the file it started with was corrupt.</summary>
    public bool MovedAside => _movedAside;

    /// <summary>Whether a read this session couldn't open <c>settings.json</c>, or couldn't move a corrupt one aside, so the
    /// defaults were used.</summary>
    public bool Unreadable => _unreadable;

    public async Task<AppSettings> GetAsync(CancellationToken ct = default)
    {
        UserDataRead<AppSettings> read;
        try
        {
            read = await _file.ReadAsync(ct);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            _unreadable = true;
            _log.LogWarning("{File} could not be read ({Error}); the default settings are used", FileName, ex.GetType().Name);
            return AppSettings.Default;
        }

        if (read.Corrupt)
        {
            _movedAside = true;
            _log.LogWarning("{File} could not be read; it was moved aside and the default settings are used", FileName);
        }

        return read.Value;
    }

    /// <summary>Checks <paramref name="value"/>, writes it as version 1 and returns what was stored. Throws
    /// <see cref="SettingsRejectedException"/> for a value out of range, and writes nothing then.</summary>
    public async Task<AppSettings> SetAsync(AppSettings value, CancellationToken ct = default)
    {
        var stored = value with { Version = AppSettings.CurrentVersion };
        if (Problem(stored) is { } problem)
        {
            throw new SettingsRejectedException(problem);
        }

        await _file.WriteAsync(stored, ct);
        return stored;
    }

    public static GraphLimits ToGraphLimits(LimitSettings limits) => new()
    {
        ObjectsPerTable = limits.GraphObjectsPerTable,
        FetchBudgetBytes = limits.FetchBudgetMb * BytesPerMegabyte,
        PerObjectReadsPerTable = limits.PerObjectReadsPerTable,
        PerObjectCacheTtl = TimeSpan.FromMinutes(limits.PerObjectCacheMinutes),
        RowsPerRun = limits.GraphRowsPerRun,
    };

    /// <summary>Sets the engine pool's timeout, heap limit and worker count from <paramref name="limits"/>.</summary>
    public static void Apply(LimitSettings limits, GraphEngineOptions options)
    {
        options.Timeout = TimeSpan.FromSeconds(limits.EngineTimeoutSeconds);
        options.MemoryLimitBytes = limits.EngineHeapMb * BytesPerMegabyte;
        options.Workers = limits.EngineWorkers;
    }

    /// <summary>What is wrong with <paramref name="settings"/>, as the user is told it, or null when nothing is. Parts missing
    /// from the JSON arrive as null, whatever the types say.</summary>
    private static string? Problem(AppSettings? settings)
    {
        if (settings?.SignIn is null || settings.Limits is null)
        {
            return "The settings are incomplete.";
        }

        if (settings.Version != AppSettings.CurrentVersion)
        {
            return "The settings are of an unknown version.";
        }

        if (!Themes.Contains(settings.Theme, StringComparer.Ordinal))
        {
            return "Theme must be dark, light or system.";
        }

        if (!RawVersions.Contains(settings.RawDefaultVersion, StringComparer.Ordinal))
        {
            return "The raw request version must be beta or v1.0.";
        }

        foreach (var range in Ranges)
        {
            var value = range.Value(settings.Limits);
            if (value < range.Min || value > range.Max)
            {
                return string.Create(CultureInfo.InvariantCulture, $"{range.Name} must be between {range.Min:N0} and {range.Max:N0}.");
            }
        }

        return null;
    }
}
