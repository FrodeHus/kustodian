using System.Text.Json;
using Kustodian.App;
using Kustodian.Auth;
using Kustodian.Messaging;
using Kustodian.Messaging.Handlers;
using Kustodian.Settings;
using Kustodian.Storage;

namespace Kustodian.Tests.Settings;

public sealed class SettingsServiceTests : IDisposable
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

    private SettingsService NewService() => new(new JsonFileStore(_dir));

    private string SettingsPath => Path.Combine(_dir, "settings.json");

    [Fact]
    public async Task Settings_default_when_file_missing()
    {
        var settings = await NewService().GetAsync(Ct);

        Assert.Equal(AppSettings.Default, settings);
        Assert.Equal(1, settings.Version);
        Assert.Equal("dark", settings.Theme);
        Assert.Equal("beta", settings.RawDefaultVersion);
        Assert.Equal(new SignInDefaults(null, null), settings.SignIn);
        Assert.Equal(new LimitSettings(50_000, 512, 120, 1024, 2, 2_000, 30, 50_000), settings.Limits);
        Assert.False(File.Exists(SettingsPath));
    }

    [Fact]
    public async Task Settings_out_of_range_is_refused_with_named_setting()
    {
        var bridge = new Messaging.Bridge(_ => { });
        new SettingsHandler(NewService(), LimitSettings.Default).Register(bridge);
        var settings = AppSettings.Default with { Limits = LimitSettings.Default with { EngineWorkers = 0 } };

        var reply = Parse(await bridge.HandleAsync(Set("s", settings)));

        Assert.Equal("bad_request", reply.GetProperty("error").GetProperty("code").GetString());
        Assert.Equal("Engine workers must be between 1 and 8.", reply.GetProperty("error").GetProperty("message").GetString());
        Assert.False(File.Exists(SettingsPath));
    }

    [Theory]
    [InlineData(nameof(LimitSettings.GraphObjectsPerTable), 999, "Graph objects per table must be between 1,000 and 1,000,000.")]
    [InlineData(nameof(LimitSettings.GraphObjectsPerTable), 1_000_001, "Graph objects per table must be between 1,000 and 1,000,000.")]
    [InlineData(nameof(LimitSettings.FetchBudgetMb), 63, "Graph fetch budget per run (MB) must be between 64 and 8,192.")]
    [InlineData(nameof(LimitSettings.EngineTimeoutSeconds), 3_601, "Engine timeout (seconds) must be between 10 and 3,600.")]
    [InlineData(nameof(LimitSettings.EngineHeapMb), 255, "Engine heap limit per worker (MB) must be between 256 and 16,384.")]
    [InlineData(nameof(LimitSettings.EngineWorkers), 9, "Engine workers must be between 1 and 8.")]
    [InlineData(nameof(LimitSettings.PerObjectReadsPerTable), -1, "Per-object reads per table must be between 0 and 20,000.")]
    [InlineData(nameof(LimitSettings.PerObjectCacheMinutes), 1_441, "Per-object cache (minutes) must be between 0 and 1,440.")]
    [InlineData(nameof(LimitSettings.GraphRowsPerRun), 999, "Rows returned per Graph run must be between 1,000 and 1,000,000.")]
    public async Task Each_limit_out_of_range_names_its_setting_and_range(string setting, int value, string message)
    {
        var limits = setting switch
        {
            nameof(LimitSettings.GraphObjectsPerTable) => LimitSettings.Default with { GraphObjectsPerTable = value },
            nameof(LimitSettings.FetchBudgetMb) => LimitSettings.Default with { FetchBudgetMb = value },
            nameof(LimitSettings.EngineTimeoutSeconds) => LimitSettings.Default with { EngineTimeoutSeconds = value },
            nameof(LimitSettings.EngineHeapMb) => LimitSettings.Default with { EngineHeapMb = value },
            nameof(LimitSettings.EngineWorkers) => LimitSettings.Default with { EngineWorkers = value },
            nameof(LimitSettings.PerObjectReadsPerTable) => LimitSettings.Default with { PerObjectReadsPerTable = value },
            nameof(LimitSettings.PerObjectCacheMinutes) => LimitSettings.Default with { PerObjectCacheMinutes = value },
            _ => LimitSettings.Default with { GraphRowsPerRun = value },
        };

        var ex = await Assert.ThrowsAsync<SettingsRejectedException>(() =>
            NewService().SetAsync(AppSettings.Default with { Limits = limits }, Ct));

        Assert.Equal(message, ex.Message);
    }

    [Fact]
    public async Task Limits_at_the_ends_of_their_ranges_are_accepted()
    {
        var low = new LimitSettings(1_000, 64, 10, 256, 1, 0, 0, 1_000);
        var high = new LimitSettings(1_000_000, 8_192, 3_600, 16_384, 8, 20_000, 1_440, 1_000_000);
        var service = NewService();

        Assert.Equal(low, (await service.SetAsync(AppSettings.Default with { Limits = low }, Ct)).Limits);
        Assert.Equal(high, (await service.SetAsync(AppSettings.Default with { Limits = high }, Ct)).Limits);
    }

    [Theory]
    [InlineData("blue", "beta", "Theme must be dark, light or system.")]
    [InlineData("light", "v2.0", "The raw request version must be beta or v1.0.")]
    public async Task Theme_and_raw_version_outside_their_choices_are_refused(string theme, string version, string message)
    {
        var ex = await Assert.ThrowsAsync<SettingsRejectedException>(() =>
            NewService().SetAsync(AppSettings.Default with { Theme = theme, RawDefaultVersion = version }, Ct));

        Assert.Equal(message, ex.Message);
    }

    [Fact]
    public async Task Settings_round_trip_and_version_is_1()
    {
        var wanted = new AppSettings(7, "light", "v1.0", new SignInDefaults("11111111-1111-1111-1111-111111111111", "contoso.com"),
            new LimitSettings(100_000, 1_024, 300, 2_048, 4, 500, 10, 20_000));

        var stored = await NewService().SetAsync(wanted, Ct);
        var read = await NewService().GetAsync(Ct);

        Assert.Equal(wanted with { Version = 1 }, stored);
        Assert.Equal(stored, read);
        using var file = JsonDocument.Parse(await File.ReadAllTextAsync(SettingsPath, Ct));
        Assert.Equal(1, file.RootElement.GetProperty("version").GetInt32());
        Assert.Equal("light", file.RootElement.GetProperty("theme").GetString());
        Assert.Equal(4, file.RootElement.GetProperty("limits").GetProperty("engineWorkers").GetInt32());
    }

    [Theory]
    [InlineData("{ not json")]
    [InlineData("""{"version":1,"theme":"dark","rawDefaultVersion":"beta","signIn":{},"limits":{"engineWorkers":0}}""")]
    [InlineData("""{"version":2,"theme":"dark","rawDefaultVersion":"beta","signIn":{},"limits":{}}""")]
    [InlineData("[1, 2]")]
    [InlineData("""{"limits":{"engineWorkers":"many"}}""")]
    public async Task Corrupt_settings_file_is_moved_aside_and_defaults_used(string content)
    {
        Directory.CreateDirectory(_dir);
        await File.WriteAllTextAsync(SettingsPath, content, Ct);

        var settings = await NewService().GetAsync(Ct);

        Assert.Equal(AppSettings.Default, settings);
        Assert.False(File.Exists(SettingsPath));
        Assert.Equal(content, await File.ReadAllTextAsync(SettingsPath + ".corrupt", Ct));
    }

    [Fact]
    public async Task Settings_set_and_get_answer_with_the_settings_and_whether_a_restart_is_needed()
    {
        var bridge = new Messaging.Bridge(_ => { });
        new SettingsHandler(NewService(), LimitSettings.Default).Register(bridge);

        var unchanged = Parse(await bridge.HandleAsync(Set("a", AppSettings.Default with { Theme = "system" }))).GetProperty("result");
        var changed = Parse(await bridge.HandleAsync(Set("b",
            AppSettings.Default with { Limits = LimitSettings.Default with { EngineWorkers = 4 } }))).GetProperty("result");
        var got = Parse(await bridge.HandleAsync("""{"id":"c","method":"settings.get","params":{}}""")).GetProperty("result");

        Assert.Equal(["settings", "limitsAppliedAt", "restartNeeded", "corrupt", "unreadable"], unchanged.EnumerateObject().Select(p => p.Name));
        Assert.False(unchanged.GetProperty("corrupt").GetBoolean());
        Assert.False(got.GetProperty("corrupt").GetBoolean());
        Assert.Equal("system", unchanged.GetProperty("settings").GetProperty("theme").GetString());
        Assert.Equal("startup", unchanged.GetProperty("limitsAppliedAt").GetString());
        Assert.False(unchanged.GetProperty("restartNeeded").GetBoolean());
        Assert.True(changed.GetProperty("restartNeeded").GetBoolean());
        Assert.Equal(4, got.GetProperty("settings").GetProperty("limits").GetProperty("engineWorkers").GetInt32());
        Assert.True(got.GetProperty("restartNeeded").GetBoolean());
    }

    [Fact]
    public async Task Settings_get_says_corrupt_for_the_session_when_the_file_was_moved_aside_at_startup()
    {
        Directory.CreateDirectory(_dir);
        await File.WriteAllTextAsync(SettingsPath, "{ not json", Ct);
        var service = NewService();
        var startup = await service.GetAsync(Ct);
        var bridge = new Messaging.Bridge(_ => { });
        new SettingsHandler(service, startup.Limits).Register(bridge);

        var first = Parse(await bridge.HandleAsync("""{"id":"a","method":"settings.get","params":{}}""")).GetProperty("result");
        var set = Parse(await bridge.HandleAsync(Set("b", AppSettings.Default with { Theme = "light" }))).GetProperty("result");
        var after = Parse(await bridge.HandleAsync("""{"id":"c","method":"settings.get","params":{}}""")).GetProperty("result");

        Assert.True(first.GetProperty("corrupt").GetBoolean());
        Assert.Equal("dark", first.GetProperty("settings").GetProperty("theme").GetString());
        Assert.True(set.GetProperty("corrupt").GetBoolean());
        Assert.Equal("light", after.GetProperty("settings").GetProperty("theme").GetString());
        Assert.True(after.GetProperty("corrupt").GetBoolean());
    }

    [Fact]
    public async Task A_settings_file_that_cant_be_opened_starts_with_the_defaults_and_says_so()
    {
        Directory.CreateDirectory(_dir);
        await File.WriteAllTextAsync(SettingsPath, """{"version":1,"theme":"light"}""", Ct);
        var service = NewService();
        AppSettings startup;
        // Held open exclusively: opening it to read fails with an IOException, on every platform .NET locks files on.
        await using (new FileStream(SettingsPath, FileMode.Open, FileAccess.ReadWrite, FileShare.None))
        {
            startup = await service.GetAsync(Ct);
        }

        var bridge = new Messaging.Bridge(_ => { });
        new SettingsHandler(service, startup.Limits).Register(bridge);
        var got = Parse(await bridge.HandleAsync("""{"id":"a","method":"settings.get","params":{}}""")).GetProperty("result");

        Assert.Equal(AppSettings.Default, startup);
        Assert.True(service.Unreadable);
        Assert.False(service.MovedAside);
        Assert.True(got.GetProperty("unreadable").GetBoolean());
        Assert.False(got.GetProperty("corrupt").GetBoolean());
        // Once it can be read again it is: nothing was moved aside or overwritten.
        Assert.Equal("light", got.GetProperty("settings").GetProperty("theme").GetString());
    }

    [Fact]
    public async Task Settings_set_without_settings_is_a_bad_request()
    {
        var bridge = new Messaging.Bridge(_ => { });
        new SettingsHandler(NewService(), LimitSettings.Default).Register(bridge);

        var missing = Parse(await bridge.HandleAsync("""{"id":"a","method":"settings.set","params":{}}"""));
        var notAnObject = Parse(await bridge.HandleAsync("""{"id":"b","method":"settings.set","params":{"settings":3}}"""));
        var wrongType = Parse(await bridge.HandleAsync(
            """{"id":"c","method":"settings.set","params":{"settings":{"limits":{"engineWorkers":"many"}}}}"""));

        Assert.Equal("bad_request", missing.GetProperty("error").GetProperty("code").GetString());
        Assert.Equal("bad_request", notAnObject.GetProperty("error").GetProperty("code").GetString());
        Assert.Equal("bad_request", wrongType.GetProperty("error").GetProperty("code").GetString());
        Assert.False(File.Exists(SettingsPath));
    }

    [Fact]
    public async Task Settings_file_missing_fields_loads_them_with_defaults()
    {
        Directory.CreateDirectory(_dir);
        const string content = """{"version":1,"theme":"light","limits":{"graphObjectsPerTable":100000,"engineWorkers":4}}""";
        await File.WriteAllTextAsync(SettingsPath, content, Ct);
        var service = NewService();

        var settings = await service.GetAsync(Ct);

        Assert.Equal(2_000, settings.Limits.PerObjectReadsPerTable);
        Assert.Equal(30, settings.Limits.PerObjectCacheMinutes);
        Assert.Equal(100_000, settings.Limits.GraphObjectsPerTable);
        Assert.Equal(4, settings.Limits.EngineWorkers);
        Assert.Equal(AppSettings.Default with
        {
            Theme = "light",
            Limits = LimitSettings.Default with { GraphObjectsPerTable = 100_000, EngineWorkers = 4 },
        }, settings);
        Assert.False(service.MovedAside);
        Assert.Equal(content, await File.ReadAllTextAsync(SettingsPath, Ct));
    }

    [Fact]
    public async Task Arg_rows_setting_default_range_and_missing_field_default()
    {
        Assert.Equal(50_000, LimitSettings.Default.ArgRowsPerRun);
        // Positional limits written before the setting existed take its default.
        Assert.Equal(50_000, new LimitSettings(100_000, 1_024, 300, 2_048, 4, 500, 10, 20_000).ArgRowsPerRun);

        var service = NewService();
        foreach (var refused in new[] { 999, 1_000_001 })
        {
            var ex = await Assert.ThrowsAsync<SettingsRejectedException>(() =>
                service.SetAsync(AppSettings.Default with { Limits = LimitSettings.Default with { ArgRowsPerRun = refused } }, Ct));
            Assert.Equal("ARG rows per run must be between 1,000 and 1,000,000.", ex.Message);
        }

        foreach (var accepted in new[] { 1_000, 1_000_000 })
        {
            var stored = await service.SetAsync(AppSettings.Default with { Limits = LimitSettings.Default with { ArgRowsPerRun = accepted } }, Ct);
            Assert.Equal(accepted, stored.Limits.ArgRowsPerRun);
            using var file = JsonDocument.Parse(await File.ReadAllTextAsync(SettingsPath, Ct));
            Assert.Equal(accepted, file.RootElement.GetProperty("limits").GetProperty("argRowsPerRun").GetInt32());
        }

        // A settings file from before the setting: every other limit as written, ARG rows per run its default.
        const string content = """
            {"version":1,"theme":"dark","rawDefaultVersion":"beta","signIn":{"clientId":null,"tenant":null},
             "limits":{"graphObjectsPerTable":50000,"fetchBudgetMb":512,"engineTimeoutSeconds":120,"engineHeapMb":1024,
                       "engineWorkers":2,"perObjectReadsPerTable":2000,"perObjectCacheMinutes":30,"graphRowsPerRun":40000}}
            """;
        await File.WriteAllTextAsync(SettingsPath, content, Ct);
        var reader = NewService();

        var read = await reader.GetAsync(Ct);

        Assert.False(reader.MovedAside);
        Assert.Equal(LimitSettings.Default with { GraphRowsPerRun = 40_000 }, read.Limits);
        Assert.Equal(50_000, read.Limits.ArgRowsPerRun);
    }

    [Fact]
    public async Task Settings_set_with_partial_limits_keeps_the_defaults_for_the_missing_ones()
    {
        var bridge = new Messaging.Bridge(_ => { });
        new SettingsHandler(NewService(), LimitSettings.Default).Register(bridge);

        var result = Parse(await bridge.HandleAsync(
            """{"id":"a","method":"settings.set","params":{"settings":{"theme":"system","limits":{"engineWorkers":3,"perObjectCacheMinutes":null}}}}"""))
            .GetProperty("result");
        var stored = await NewService().GetAsync(Ct);

        var expected = AppSettings.Default with { Theme = "system", Limits = LimitSettings.Default with { EngineWorkers = 3 } };
        Assert.Equal(expected, stored);
        Assert.Equal(2_000, stored.Limits.PerObjectReadsPerTable);
        Assert.Equal(30, stored.Limits.PerObjectCacheMinutes);
        Assert.Equal(3, result.GetProperty("settings").GetProperty("limits").GetProperty("engineWorkers").GetInt32());
        Assert.Equal(30, result.GetProperty("settings").GetProperty("limits").GetProperty("perObjectCacheMinutes").GetInt32());
        Assert.Equal("beta", result.GetProperty("settings").GetProperty("rawDefaultVersion").GetString());
    }

    [Fact]
    public void Limit_settings_become_graph_limits_and_engine_options()
    {
        var limits = new LimitSettings(100_000, 1_024, 300, 2_048, 4, 500, 10, 20_000);
        var options = new Graph.Engine.GraphEngineOptions();

        var graph = SettingsService.ToGraphLimits(limits);
        SettingsService.Apply(limits, options);

        Assert.Equal(100_000, graph.ObjectsPerTable);
        Assert.Equal(1_024L << 20, graph.FetchBudgetBytes);
        Assert.Equal(500, graph.PerObjectReadsPerTable);
        Assert.Equal(TimeSpan.FromMinutes(10), graph.PerObjectCacheTtl);
        Assert.Equal(20_000, graph.RowsPerRun);
        Assert.Equal(TimeSpan.FromSeconds(300), options.Timeout);
        Assert.Equal(2_048L << 20, options.MemoryLimitBytes);
        Assert.Equal(4, options.Workers);
        Assert.Equal(Graph.Run.GraphLimits.Default, SettingsService.ToGraphLimits(LimitSettings.Default));
    }

    [Fact]
    public async Task Limits_are_read_once_at_startup()
    {
        var store = new JsonFileStore(_dir);
        var settings = new SettingsService(store);
        var a = await settings.SetAsync(AppSettings.Default with
        {
            Limits = new LimitSettings(10_000, 256, 60, 512, 3, 100, 5, 5_000),
        }, Ct);
        var startup = await settings.GetAsync(Ct);
        var accounts = new AccountService(_ => throw new InvalidOperationException("No sign-in in this test."), store);
        await using var services = AppServices.Build(startup, settings, accounts, new MemoryOnly("test"),
            new EngineCommand("worker", []), store, TimeProvider.System);
        var bridge = new Messaging.Bridge(_ => { });
        services.Register(bridge);

        await settings.SetAsync(a with { Limits = LimitSettings.Default }, Ct);
        var got = Parse(await bridge.HandleAsync("""{"id":"g","method":"settings.get","params":{}}""")).GetProperty("result");

        var expected = SettingsService.ToGraphLimits(a.Limits);
        Assert.Equal(expected, services.Limits);
        Assert.Equal(expected, services.Runner.Limits);
        Assert.Equal(256L << 20, services.Budget.MaxBytes);
        Assert.Equal(3, services.Pool.Options.Workers);
        Assert.Equal(TimeSpan.FromSeconds(60), services.Pool.Options.Timeout);
        Assert.Equal(512L << 20, services.Pool.Options.MemoryLimitBytes);
        Assert.Equal("worker", services.Pool.Options.WorkerPath);
        Assert.Equal(50_000, got.GetProperty("settings").GetProperty("limits").GetProperty("graphObjectsPerTable").GetInt32());
        Assert.True(got.GetProperty("restartNeeded").GetBoolean());
    }

    private static string Set(string id, AppSettings settings)
        => JsonSerializer.Serialize(new { id, method = "settings.set", @params = new { settings } }, BridgeJson.Options);

    private static JsonElement Parse(string? json)
    {
        Assert.NotNull(json);
        using var doc = JsonDocument.Parse(json);
        return doc.RootElement.Clone();
    }
}
