using System.Text.Json;
using Kustodian.History;
using Kustodian.Messaging.Handlers;
using Kustodian.Storage;
using Kustodian.Workbooks;
using Microsoft.Extensions.Time.Testing;

namespace Kustodian.Tests.Bridge;

public sealed class HistoryHandlerTests : IDisposable
{
    private const string Id = "6f1c2a52-0b0e-4d6c-9a43-6a3f1f0b7c11";
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "kustodian-tests-" + Guid.NewGuid().ToString("N"));
    private readonly FakeTimeProvider _time = new(new DateTimeOffset(2026, 11, 6, 8, 0, 0, TimeSpan.Zero));
    private readonly Messaging.Bridge _bridge = new(_ => { });
    private readonly HistoryStore _history;

    public HistoryHandlerTests()
    {
        _history = new HistoryStore(_dir, _time);
        new WorkbookHandler(new WorkbookService(new JsonFileStore(_dir), _time), _history).Register(_bridge);
        new HistoryHandler(_history).Register(_bridge);
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


    private static string Record(string workbook = Id, string widget = "w1", string mode = "rows", int retention = 30,
        string keys = "[\"id\"]", string source = "graph", string columns = """[{"name":"id","type":"string"}]""") =>
        $$"""
        {"workbookId":"{{workbook}}","widgetId":"{{widget}}",
         "query":{"source":"{{source}}","text":"users","options":null,"parameters":[]},
         "setting":{"mode":"{{mode}}","interval":"run","retentionDays":{{retention}},"keys":{{keys}}},
         "label":"Users","columns":{{columns}},"rows":[["a"],["b"]]}
        """;

    [Theory]
    [InlineData("not-a-guid", "w1", "rows", 30, "[\"id\"]", "graph", null)]
    [InlineData(Id, "0123456789012345678901234567890123456789012345678901234567890123456789", "rows", 30, "[\"id\"]", "graph", null)]
    [InlineData(Id, "w 1", "rows", 30, "[\"id\"]", "graph", null)]
    [InlineData(Id, "w1", "other", 30, "[\"id\"]", "graph", null)]
    [InlineData(Id, "w1", "rows", 31, "[\"id\"]", "graph", null)]
    [InlineData(Id, "w1", "rows", 30, "[]", "graph", null)]
    [InlineData(Id, "w1", "rows", 30, "[\"nope\"]", "graph", null)]
    [InlineData(Id, "w1", "values", 30, "[\"nope\"]", "graph", null)]
    [InlineData(Id, "w1", "rows", 30, "[\"id\"]", "sql", null)]
    [InlineData(Id, "w1", "rows", 30, "[\"b\"]", "graph", """[{"name":"id","type":"string"},{"name":"b","type":"string"}]""")]
    public async Task Record_refuses_a_bad_request(string workbook, string widget, string mode, int retention, string keys, string source,
        string? columns)
    {
        var reply = await CallAsync("history.record", Record(workbook, widget, mode, retention, keys, source,
            columns ?? """[{"name":"id","type":"string"}]"""));

        Assert.Equal("bad_request", reply.GetProperty("error").GetProperty("code").GetString());
        var series = await CallAsync("history.series", $$"""{"workbookId":"{{Id}}","widgetId":"w1"}""");
        Assert.Equal(0, series.GetProperty("result").GetArrayLength());
    }

    [Fact]
    public async Task Changes_refuses_a_since_that_is_not_an_instant()
    {
        var reply = await CallAsync("history.changes", $$"""
            {"workbookId":"{{Id}}","widgetId":"w1","query":{"source":"graph","text":"u","options":null,"parameters":[]},
             "setting":{"mode":"rows","interval":"run","retentionDays":30,"keys":["id"]},"since":"yesterday"}
            """);

        Assert.Equal("bad_request", reply.GetProperty("error").GetProperty("code").GetString());
    }

    [Fact]
    public async Task Deleting_a_workbook_deletes_its_history()
    {
        await CallAsync("workbook.save", $$$"""{"workbook":{"kind":"kustodian.workbook","version":1,"id":"{{{Id}}}","name":"W","widgets":[]}}""");
        Assert.True((await CallAsync("history.record", Record())).GetProperty("result").GetProperty("recorded").GetBoolean());
        Assert.Equal(1, (await CallAsync("history.series", $$"""{"workbookId":"{{Id}}","widgetId":"w1"}""")).GetProperty("result").GetArrayLength());

        await CallAsync("workbook.delete", $$"""{"id":"{{Id}}"}""");

        Assert.Equal(0, (await CallAsync("history.series", $$"""{"workbookId":"{{Id}}","widgetId":"w1"}""")).GetProperty("result").GetArrayLength());
    }

    [Fact]
    public async Task Answers_round_trip_in_camel_case()
    {
        await CallAsync("history.record", Record());
        _time.Advance(TimeSpan.FromHours(1));
        await CallAsync("history.record", Record());

        var changes = (await CallAsync("history.changes", $$"""
            {"workbookId":"{{Id}}","widgetId":"w1","query":{"source":"graph","text":"users","options":null,"parameters":[]},
             "setting":{"mode":"rows","interval":"run","retentionDays":30,"keys":["id"]},"since":"2026-11-01T00:00:00Z"}
            """)).GetProperty("result");

        Assert.Equal(2, changes.GetProperty("newCount").GetInt32());
        var row = changes.GetProperty("new")[0];
        Assert.True(DateTimeOffset.TryParse(row.GetProperty("firstSeen").GetString(), out _));
        Assert.Equal(JsonValueKind.Null, row.GetProperty("gone").ValueKind);
        Assert.Equal(JsonValueKind.String, row.GetProperty("values")[0].ValueKind);

        var cleared = await CallAsync("history.clear", $$"""{"workbookId":"{{Id}}","widgetId":"w1"}""");
        Assert.False(cleared.TryGetProperty("error", out _));
    }
}
