using System.Text.Json;
using Kustodian.Graph.Query;
using Kustodian.Library;
using Kustodian.Messaging.Handlers;
using Kustodian.Storage;

namespace Kustodian.Tests.Bridge;

public sealed class LibraryHandlerTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "kustodian-tests-" + Guid.NewGuid().ToString("N"));
    private readonly Messaging.Bridge _bridge = new(_ => { });
    private readonly RecentService _recent;

    public LibraryHandlerTests()
    {
        var store = new JsonFileStore(_dir);
        _recent = new RecentService(store);
        new LibraryHandler(new LibraryService(store, TimeProvider.System), _recent).Register(_bridge);
    }

    public void Dispose()
    {
        if (Directory.Exists(_dir))
        {
            Directory.Delete(_dir, recursive: true);
        }
    }

    private async Task<JsonElement> CallAsync(string method, string @params)
    {
        var json = await _bridge.HandleAsync($$"""{"id":"x","method":"{{method}}","params":{{@params}}}""");
        Assert.NotNull(json);
        using var doc = JsonDocument.Parse(json);
        return doc.RootElement.Clone();
    }

    [Fact]
    public async Task Library_save_list_and_delete_round_trip_over_the_bridge()
    {
        var saved = (await CallAsync("library.save", """
            {"query":{"name":"Stale","folder":"Hygiene","source":"graph","text":"users","parameters":[{"name":"days","type":"number","value":"30","required":true,"choices":["7","30"]}]}}
            """)).GetProperty("result");
        var id = saved.GetProperty("id").GetString()!;

        var listed = (await CallAsync("library.list", "{}")).GetProperty("result");

        Assert.Equal("Stale", saved.GetProperty("name").GetString());
        Assert.Equal(1, saved.GetProperty("version").GetInt32());
        Assert.Equal(id, listed.GetProperty("queries")[0].GetProperty("id").GetString());
        Assert.Equal("Hygiene", listed.GetProperty("folders")[0].GetString());
        Assert.Equal(0, listed.GetProperty("skipped").GetInt32());
        var parameter = listed.GetProperty("queries")[0].GetProperty("parameters")[0];
        Assert.True(parameter.GetProperty("required").GetBoolean());
        Assert.Equal("30", parameter.GetProperty("choices")[1].GetString());

        var update = (await CallAsync("library.save", $$$"""{"query":{"id":"{{{id}}}","name":"Renamed","text":"groups"}}""")).GetProperty("result");
        Assert.Equal(id, update.GetProperty("id").GetString());
        Assert.Equal("Renamed", update.GetProperty("name").GetString());
        Assert.Equal(JsonValueKind.Null, update.GetProperty("folder").ValueKind);
        Assert.Equal("graph", update.GetProperty("source").GetString());
        Assert.Equal(0, update.GetProperty("parameters").GetArrayLength());

        var deleted = await CallAsync("library.delete", $$"""{"id":"{{id}}"}""");
        Assert.False(deleted.TryGetProperty("error", out _));
        Assert.Equal(0, (await CallAsync("library.list", "{}")).GetProperty("result").GetProperty("queries").GetArrayLength());
    }

    [Fact]
    public async Task Library_save_parameter_missing_fields_take_their_defaults()
    {
        var saved = (await CallAsync("library.save", """{"query":{"name":"n","parameters":[{"name":"p"}]}}""")).GetProperty("result");

        var parameter = saved.GetProperty("parameters")[0];
        Assert.Equal("text", parameter.GetProperty("type").GetString());
        Assert.False(parameter.GetProperty("required").GetBoolean());
        Assert.Equal(JsonValueKind.Null, parameter.GetProperty("choices").ValueKind);
    }

    [Theory]
    [InlineData("""{"query":{"name":"","text":"x"}}""", "The name must be 1 to 200 characters.")]
    [InlineData("""{"query":{"name":"n","folder":"a/b"}}""", "The folder must be 1 to 80 characters and have no /.")]
    [InlineData("""{"query":{"id":"nope","name":"n"}}""", "The saved query id isn't valid.")]
    [InlineData("""{"query":{"name":5}}""", "The request's params are not valid.")]
    [InlineData("""{}""", "The request has no query.")]
    public async Task Library_save_that_is_not_allowed_is_a_bad_request(string @params, string message)
    {
        var reply = await CallAsync("library.save", @params);

        Assert.Equal("bad_request", reply.GetProperty("error").GetProperty("code").GetString());
        Assert.Equal(message, reply.GetProperty("error").GetProperty("message").GetString());
    }

    [Fact]
    public async Task Library_delete_of_a_bad_id_is_a_bad_request()
    {
        var reply = await CallAsync("library.delete", """{"id":"../x"}""");

        Assert.Equal("bad_request", reply.GetProperty("error").GetProperty("code").GetString());
    }

    [Fact]
    public async Task Recent_list_and_clear_over_the_bridge()
    {
        await _recent.AddAsync(new RecentRun("a", "graph", "users", [new ParameterValue("days", "timespan", "7d", true)],
            new DateTimeOffset(2026, 10, 21, 8, 0, 0, TimeSpan.Zero), 10, 3, "ok"), TestContext.Current.CancellationToken);

        var runs = (await CallAsync("recent.list", "{}")).GetProperty("result").GetProperty("runs");
        Assert.Equal(1, runs.GetArrayLength());
        Assert.Equal("users", runs[0].GetProperty("text").GetString());
        Assert.Equal(10, runs[0].GetProperty("durationMs").GetInt64());
        Assert.Equal(3, runs[0].GetProperty("rows").GetInt32());
        var parameter = runs[0].GetProperty("parameters")[0];
        Assert.Equal("days", parameter.GetProperty("name").GetString());
        Assert.Equal("timespan", parameter.GetProperty("type").GetString());
        Assert.Equal("7d", parameter.GetProperty("value").GetString());
        Assert.True(parameter.GetProperty("required").GetBoolean());

        var cleared = await CallAsync("recent.clear", "{}");
        Assert.False(cleared.TryGetProperty("error", out _));
        Assert.Equal(0, (await CallAsync("recent.list", "{}")).GetProperty("result").GetProperty("runs").GetArrayLength());
    }
}
