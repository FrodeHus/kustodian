using Kustodian.Graph.Engine;

namespace Kustodian.Engine.Tests;

public sealed class EngineMainTests
{
    private static readonly DateTimeOffset Now = new(2026, 10, 20, 0, 0, 0, TimeSpan.Zero);

    [Fact]
    public async Task Unhandled_exception_writes_a_crash_frame_then_exits()
    {
        var ct = TestContext.Current.CancellationToken;
        using var input = new MemoryStream();
        await EngineFrames.WriteAsync(input, new EngineRequest("print 1", Now, [], 10), ct);
        input.Position = 0;
        using var output = new MemoryStream();

        var exitCode = await EngineMain.ServeAsync(input, output,
            _ => throw new InvalidOperationException("outer", new ArgumentException("inner")));

        Assert.Equal(EngineExitCodes.Crashed, exitCode);
        output.Position = 0;
        var response = await EngineFrames.ReadAsync<EngineResponse>(output, 1 << 20, ct);
        Assert.Null(await EngineFrames.ReadAsync<EngineResponse>(output, 1 << 20, ct));
        var crash = Assert.IsType<EngineCrash>(response?.Crash);
        Assert.Equal(["System.InvalidOperationException", "System.ArgumentException"], crash.Exceptions.Select(e => e.TypeName));
        Assert.Equal(["outer", "inner"], crash.Exceptions.Select(e => e.Message));
        Assert.Contains(crash.Exceptions[0].Frames, f => f.Assembly == "Kustodian.Engine.Tests");
        // Runtime async: the serving loop's frame is the method itself, not a state machine's MoveNext.
        Assert.Contains(crash.Exceptions[0].Frames,
            f => f.Method == "Kustodian.Engine.EngineMain.ReadAllAsync" && f.Assembly == "Kustodian.Engine");
    }
}
