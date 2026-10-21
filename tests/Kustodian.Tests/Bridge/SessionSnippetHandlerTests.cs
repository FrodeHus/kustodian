using System.Text.Json;
using Kustodian.Messaging.Handlers;
using Kustodian.Sessions;
using Kustodian.Snippets;
using Kustodian.Storage;

namespace Kustodian.Tests.Bridge;

public sealed class SessionSnippetHandlerTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "kustodian-tests-" + Guid.NewGuid().ToString("N"));
    private readonly Messaging.Bridge _bridge = new(_ => { });
    private readonly Kustodian.Files.AllowedFilePaths _allowed = new();

    public SessionSnippetHandlerTests()
    {
        var store = new JsonFileStore(_dir);
        new SessionHandler(new SessionService(store), _allowed).Register(_bridge);
        new SnippetHandler(new SnippetService(store)).Register(_bridge);
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
    public async Task Session_save_fills_missing_tab_fields_and_get_returns_it()
    {
        var saved = (await CallAsync("session.save", """{"session":{"activeId":"a","tabs":[{"id":"a","text":"users"}]}}""")).GetProperty("result");
        var got = (await CallAsync("session.get", "{}")).GetProperty("result");

        Assert.Equal(0, saved.GetProperty("dropped").GetInt32());
        Assert.False(got.GetProperty("corrupt").GetBoolean());
        var tab = got.GetProperty("session").GetProperty("tabs")[0];
        Assert.Equal("users", tab.GetProperty("text").GetString());
        Assert.Equal("graph", tab.GetProperty("source").GetString());
        Assert.Equal(0, tab.GetProperty("parameters").GetArrayLength());
    }

    [Fact]
    public async Task Session_save_keeps_only_approved_file_paths()
    {
        var approved = Path.Combine(_dir, "ok.kql");
        _allowed.Add(approved);
        var tabs = $$$"""[{"id":"a","filePath":{{{JsonSerializer.Serialize(approved)}}}},{"id":"b","filePath":"/etc/passwd"}]""";

        await CallAsync("session.save", $$$"""{"session":{"tabs":{{{tabs}}}}}""");
        var got = (await CallAsync("session.get", "{}")).GetProperty("result").GetProperty("session").GetProperty("tabs");

        Assert.Equal(approved, got[0].GetProperty("filePath").GetString());
        Assert.Equal(JsonValueKind.Null, got[1].GetProperty("filePath").ValueKind);
    }

    [Fact]
    public async Task Snippets_list_save_and_delete_over_the_bridge()
    {
        var saved = (await CallAsync("snippets.save", """{"snippet":{"name":"Mine","text":"users"}}""")).GetProperty("result");
        var listed = (await CallAsync("snippets.list", "{}")).GetProperty("result").GetProperty("snippets");

        Assert.True(listed[0].GetProperty("builtIn").GetBoolean());
        Assert.Contains(listed.EnumerateArray(), s => s.GetProperty("id").GetString() == saved.GetProperty("id").GetString());

        var builtInId = listed[0].GetProperty("id").GetString();
        var refused = await CallAsync("snippets.delete", $$"""{"id":"{{builtInId}}"}""");
        Assert.Equal("bad_request", refused.GetProperty("error").GetProperty("code").GetString());

        await CallAsync("snippets.delete", $$"""{"id":"{{saved.GetProperty("id").GetString()}}"}""");
        var after = (await CallAsync("snippets.list", "{}")).GetProperty("result").GetProperty("snippets");
        Assert.DoesNotContain(after.EnumerateArray(), s => !s.GetProperty("builtIn").GetBoolean());
    }
}
