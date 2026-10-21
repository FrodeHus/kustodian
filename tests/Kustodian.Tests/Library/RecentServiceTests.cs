using System.Text.Json;
using Kustodian.Graph.Query;
using Kustodian.Graph.Run;
using Kustodian.Graph.Schema;
using Kustodian.Library;
using Kustodian.Messaging.Handlers;
using Kustodian.Storage;

namespace Kustodian.Tests.Library;

public sealed class RecentServiceTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "kustodian-tests-" + Guid.NewGuid().ToString("N"));
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    public void Dispose()
    {
        if (Directory.Exists(_dir))
        {
            Directory.Delete(_dir, recursive: true);
        }
    }

    private RecentService NewService() => new(new JsonFileStore(_dir));

    private string RecentPath => Path.Combine(_dir, "recent.json");

    private static RecentRun Run(int n) => new($"run-{n}", "graph", $"users | take {n}", new Dictionary<string, string> { ["n"] = $"{n}" },
        new DateTimeOffset(2026, 10, 21, 8, 0, 0, TimeSpan.Zero).AddMinutes(n), 120 + n, n, "ok");

    [Fact]
    public async Task Recent_keeps_newest_100()
    {
        var service = NewService();
        for (var n = 1; n <= 105; n++)
        {
            await service.AddAsync(Run(n), Ct);
        }

        var runs = await NewService().ListAsync(Ct);

        Assert.Equal(100, runs.Count);
        Assert.Equal("run-105", runs[0].Id);
        Assert.Equal("run-6", runs[^1].Id);
        using var file = JsonDocument.Parse(await File.ReadAllTextAsync(RecentPath, Ct));
        Assert.Equal(1, file.RootElement.GetProperty("version").GetInt32());
        Assert.Equal(100, file.RootElement.GetProperty("runs").GetArrayLength());
    }

    [Fact]
    public async Task Recent_round_trips_a_run_and_clear_empties_it()
    {
        var service = NewService();
        await service.AddAsync(Run(7), Ct);

        var run = Assert.Single(await service.ListAsync(Ct));
        Assert.Equal(Run(7).Text, run.Text);
        Assert.Equal(Run(7).StartedAt, run.StartedAt);
        Assert.Equal(127, run.DurationMs);
        Assert.Equal(7, run.Rows);
        Assert.Equal("7", run.Parameters["n"]);

        await service.ClearAsync(Ct);

        Assert.Empty(await service.ListAsync(Ct));
        Assert.Empty(await NewService().ListAsync(Ct));
    }

    [Fact]
    public async Task Recent_run_missing_fields_loads_with_their_defaults()
    {
        await File.WriteAllTextAsync(Directory.CreateDirectory(_dir).FullName + "/recent.json", """
            {"version":1,"runs":[{"id":"a","source":"graph","text":"users","startedAt":"2026-10-21T08:00:00+00:00","outcome":"ok"}]}
            """, Ct);

        var run = Assert.Single(await NewService().ListAsync(Ct));

        Assert.Equal(0, run.DurationMs);
        Assert.Equal(0, run.Rows);
        Assert.NotNull(run.Parameters);
        Assert.Empty(run.Parameters);
        Assert.Equal("ok", run.Outcome);
        Assert.False(File.Exists(RecentPath + ".corrupt"));
    }

    [Theory]
    [InlineData("{ nope")]
    [InlineData("""{"version":1,"runs":[5]}""")]
    [InlineData("""{"version":1,"runs":[{"rows":"many"}]}""")]
    [InlineData("""{"version":2,"runs":[]}""")]
    public async Task Recent_file_that_cannot_be_read_is_moved_aside_and_starts_empty(string content)
    {
        await File.WriteAllTextAsync(Directory.CreateDirectory(_dir).FullName + "/recent.json", content, Ct);

        Assert.Empty(await NewService().ListAsync(Ct));

        Assert.True(File.Exists(RecentPath + ".corrupt"));
    }

    [Fact]
    public async Task Finished_run_is_recorded_in_recent_but_cancelled_is_not()
    {
        var recent = NewService();
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var bridge = new Messaging.Bridge(_ => { });
        new QueryHandler(GraphSchemaCatalog.Beta, () => Task.FromResult<string?>("acct"), async (_, kql, _, _, ct) =>
        {
            if (kql == "slow")
            {
                started.SetResult();
                await release.Task.WaitAsync(ct);
            }

            return new RunResult(RunOutcome.QueryError, "bad", null, [], [], 42, [], TimeSpan.FromMilliseconds(250));
        }, recent).Register(bridge);

        var finished = await bridge.HandleAsync(RunRequest("r1", "t1", "users"));
        var slow = bridge.HandleAsync(RunRequest("r2", "t2", "slow"));
        await started.Task.WaitAsync(TimeSpan.FromSeconds(10), Ct);
        await bridge.HandleAsync("""{"id":"c","method":"query.cancel","params":{"tabId":"t2"}}""");
        var cancelled = await slow.WaitAsync(TimeSpan.FromSeconds(10), Ct);

        Assert.Contains("\"result\"", finished);
        Assert.Contains("cancelled", cancelled);
        var run = Assert.Single(await recent.ListAsync(Ct));
        Assert.Equal("users", run.Text);
        Assert.Equal("graph", run.Source);
        Assert.Equal("queryError", run.Outcome);
        Assert.Equal(250, run.DurationMs);
        Assert.Equal(42, run.Rows);
        Assert.Equal("1", run.Parameters["n"]);
        Assert.True(Guid.TryParseExact(run.Id, "D", out _));
    }

    [Fact]
    public async Task Recent_write_failure_does_not_fail_the_run()
    {
        Directory.CreateDirectory(RecentPath);
        var bridge = new Messaging.Bridge(_ => { });
        new QueryHandler(GraphSchemaCatalog.Beta, () => Task.FromResult<string?>("acct"),
            (_, _, _, _, _) => Task.FromResult(new RunResult(RunOutcome.Ok, null, null, [], [], 0, [], TimeSpan.Zero)), NewService())
            .Register(bridge);

        var reply = await bridge.HandleAsync(RunRequest("r1", "t1", "users"));

        using var doc = JsonDocument.Parse(reply!);
        Assert.Equal("ok", doc.RootElement.GetProperty("result").GetProperty("outcome").GetString());
    }

    private static string RunRequest(string id, string tabId, string kql) => JsonSerializer.Serialize(new
    {
        id,
        method = "query.run",
        @params = new { tabId, source = "graph", kql, refresh = false, parameters = new Dictionary<string, string> { ["n"] = "1" } },
    });
}
