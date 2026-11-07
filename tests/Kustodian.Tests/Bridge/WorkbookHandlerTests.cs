using System.Text.Json;
using Kustodian.History;
using Kustodian.Messaging.Handlers;
using Kustodian.Storage;
using Kustodian.Workbooks;

namespace Kustodian.Tests.Bridge;

public sealed class WorkbookHandlerTests : IDisposable
{
    private const string Id = "6f1c2a52-0b0e-4d6c-9a43-6a3f1f0b7c11";
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "kustodian-tests-" + Guid.NewGuid().ToString("N"));
    private readonly Messaging.Bridge _bridge = new(_ => { });
    private readonly HistoryStore _history;

    public WorkbookHandlerTests()
    {
        _history = new HistoryStore(_dir, TimeProvider.System);
        new WorkbookHandler(new WorkbookService(new JsonFileStore(_dir), TimeProvider.System), _history).Register(_bridge);
    }

    public void Dispose()
    {
        _history.Dispose();
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

    private static string Workbook(string name = "Hygiene") =>
        $$$"""{"workbook":{"kind":"kustodian.workbook","version":1,"id":"{{{Id}}}","name":"{{{name}}}","folder":"Ops","widgets":[{"type":"markdown"}],"extra":5}}""";

    [Fact]
    public async Task Workbook_methods_round_trip_over_the_bridge()
    {
        var saved = (await CallAsync("workbook.save", Workbook())).GetProperty("result").GetProperty("workbook");
        Assert.Equal(Id, saved.GetProperty("id").GetString());
        Assert.Equal(5, saved.GetProperty("extra").GetInt32());
        Assert.True(saved.TryGetProperty("modifiedAt", out _));

        var got = (await CallAsync("workbook.get", $$"""{"id":"{{Id}}"}""")).GetProperty("result").GetProperty("workbook");
        Assert.Equal("Hygiene", got.GetProperty("name").GetString());

        var listed = (await CallAsync("workbook.list", "{}")).GetProperty("result");
        Assert.Equal(Id, listed.GetProperty("workbooks")[0].GetProperty("id").GetString());
        Assert.Equal(1, listed.GetProperty("workbooks")[0].GetProperty("widgets").GetInt32());
        Assert.Equal("Ops", listed.GetProperty("folders")[0].GetString());
        Assert.Equal(0, listed.GetProperty("skipped").GetInt32());

        Assert.Empty((await CallAsync("workbook.values.get", $$"""{"id":"{{Id}}"}""")).GetProperty("result").GetProperty("values").EnumerateObject());
        Assert.False((await CallAsync("workbook.values.save", $$$"""{"id":"{{{Id}}}","values":{"days":"7"}}""")).TryGetProperty("error", out _));
        var values = (await CallAsync("workbook.values.get", $$"""{"id":"{{Id}}"}""")).GetProperty("result").GetProperty("values");
        Assert.Equal("7", values.GetProperty("days").GetString());

        var deleted = await CallAsync("workbook.delete", $$"""{"id":"{{Id}}"}""");
        Assert.False(deleted.TryGetProperty("error", out _));
        Assert.Equal(JsonValueKind.Null, (await CallAsync("workbook.get", $$"""{"id":"{{Id}}"}""")).GetProperty("result").GetProperty("workbook").ValueKind);
        Assert.Equal(0, (await CallAsync("workbook.list", "{}")).GetProperty("result").GetProperty("workbooks").GetArrayLength());
    }

    [Fact]
    public async Task Workbook_get_of_an_unknown_id_answers_null()
    {
        var reply = await CallAsync("workbook.get", """{"id":"00000000-0000-0000-0000-000000000000"}""");

        Assert.Equal(JsonValueKind.Null, reply.GetProperty("result").GetProperty("workbook").ValueKind);
    }

    [Theory]
    [InlineData("""{}""", "The request has no workbook.")]
    [InlineData("""{"workbook":{"kind":"x"}}""", "This isn't a Kustodian workbook.")]
    public async Task Workbook_save_that_is_not_allowed_is_a_bad_request(string @params, string message)
    {
        var reply = await CallAsync("workbook.save", @params);

        Assert.Equal("bad_request", reply.GetProperty("error").GetProperty("code").GetString());
        Assert.Equal(message, reply.GetProperty("error").GetProperty("message").GetString());
    }

    [Theory]
    [InlineData("""{}""", "The request has no workbook.")]
    [InlineData("""{"workbook":{"kind":"kustodian.workbook","version":2}}""", "This workbook needs a newer Kustodian.")]
    public async Task Workbook_check_that_is_not_allowed_is_a_bad_request(string @params, string message)
    {
        var reply = await CallAsync("workbook.check", @params);

        Assert.Equal("bad_request", reply.GetProperty("error").GetProperty("code").GetString());
        Assert.Equal(message, reply.GetProperty("error").GetProperty("message").GetString());
    }

    [Fact]
    public async Task Workbook_check_over_the_bridge_answers_null_for_a_valid_workbook()
    {
        var reply = await CallAsync("workbook.check", Workbook());

        Assert.False(reply.TryGetProperty("error", out _));
        Assert.Equal(JsonValueKind.Null, reply.GetProperty("result").ValueKind);
    }

    [Fact]
    public async Task Workbook_calls_with_a_bad_id_are_a_bad_request()
    {
        foreach (var call in new[] { ("workbook.get", """{"id":"../x"}"""), ("workbook.delete", """{"id":"../x"}"""),
            ("workbook.values.get", """{"id":"../x"}"""), ("workbook.values.save", """{"id":"../x","values":{}}""") })
        {
            var reply = await CallAsync(call.Item1, call.Item2);
            Assert.Equal("bad_request", reply.GetProperty("error").GetProperty("code").GetString());
        }
    }
}
