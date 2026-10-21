using Microsoft.Extensions.Logging;

namespace Kustodian.App;

/// <summary>A minimal logger that writes to stderr. Nothing logged anywhere carries a token or an Authorization header.</summary>
public sealed class StderrLogger<T>(LogLevel minimum = LogLevel.Information) : ILogger<T>
{
    private static readonly string Category = typeof(T).Name;

    public IDisposable? BeginScope<TState>(TState state)
        where TState : notnull => null;

    public bool IsEnabled(LogLevel logLevel) => logLevel != LogLevel.None && logLevel >= minimum;

    public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception,
        Func<TState, Exception?, string> formatter)
    {
        if (!IsEnabled(logLevel))
        {
            return;
        }

        var line = $"{logLevel} {Category}: {formatter(state, exception)}";
        Console.Error.WriteLine(exception is null ? line : $"{line}{Environment.NewLine}{exception}");
    }
}
