using System.Text;
using System.Text.Json;
using Kustodian.Files;
using Kustodian.Messaging.Handlers;

namespace Kustodian.Tests.Files;

public sealed class FileHandlerTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "kustodian-tests-" + Guid.NewGuid().ToString("N"));
    private readonly FakeDialogs _dialogs = new();
    private readonly Messaging.Bridge _bridge = new(_ => { });

    public FileHandlerTests()
    {
        Directory.CreateDirectory(_dir);
        new FileHandler(_dialogs).Register(_bridge);
    }

    public void Dispose() => Directory.Delete(_dir, recursive: true);

    private async Task<JsonElement> CallAsync(string method, string @params)
    {
        var json = await _bridge.HandleAsync($$"""{"id":"x","method":"{{method}}","params":{{@params}}}""");
        Assert.NotNull(json);
        using var doc = JsonDocument.Parse(json);
        return doc.RootElement.Clone();
    }

    [Fact]
    public async Task Open_returns_text_and_name()
    {
        var path = Path.Combine(_dir, "users.kql");
        await File.WriteAllBytesAsync(path, [.. Encoding.UTF8.GetPreamble(), .. Encoding.UTF8.GetBytes("users | take 5 // æøå")], TestContext.Current.CancellationToken);
        _dialogs.Open = path;

        var reply = await CallAsync("file.open", """{"filters":[{"name":"KQL","extensions":["kql"]}]}""");

        var result = reply.GetProperty("result");
        Assert.Equal(path, result.GetProperty("path").GetString());
        Assert.Equal("users.kql", result.GetProperty("name").GetString());
        Assert.Equal("users | take 5 // æøå", result.GetProperty("text").GetString());
        var filter = Assert.Single(_dialogs.OpenFilters!);
        Assert.Equal("KQL", filter.Name);
        Assert.Equal(["kql"], filter.Extensions);
    }

    [Fact]
    public async Task Open_cancelled_returns_null()
    {
        var reply = await CallAsync("file.open", "{}");

        Assert.Equal(JsonValueKind.Null, reply.GetProperty("result").ValueKind);
    }

    [Fact]
    public async Task Open_over_5mb_is_refused()
    {
        var path = Path.Combine(_dir, "big.kql");
        await File.WriteAllBytesAsync(path, new byte[(5 * 1024 * 1024) + 1], TestContext.Current.CancellationToken);
        _dialogs.Open = path;

        var reply = await CallAsync("file.open", "{}");

        var error = reply.GetProperty("error");
        Assert.Equal("bad_request", error.GetProperty("code").GetString());
        Assert.Equal("Files over 5 MB can't be opened.", error.GetProperty("message").GetString());
    }

    [Fact]
    public async Task Open_refuses_text_that_is_not_utf8()
    {
        var path = Path.Combine(_dir, "latin.kql");
        await File.WriteAllBytesAsync(path, [0x61, 0xE6, 0xF8], TestContext.Current.CancellationToken);
        _dialogs.Open = path;

        var reply = await CallAsync("file.open", "{}");

        Assert.Equal("bad_request", reply.GetProperty("error").GetProperty("code").GetString());
    }

    [Fact]
    public async Task Save_with_existing_path_skips_dialog()
    {
        var path = Path.Combine(_dir, "q.kql");
        await File.WriteAllTextAsync(path, "old", TestContext.Current.CancellationToken);

        var reply = await CallAsync("file.saveAs", $$"""{"suggestedName":"x.kql","content":"new","path":{{JsonSerializer.Serialize(path)}}}""");

        Assert.Equal(0, _dialogs.SaveCalls);
        Assert.Equal("new", await File.ReadAllTextAsync(path, TestContext.Current.CancellationToken));
        Assert.Equal("q.kql", reply.GetProperty("result").GetProperty("name").GetString());
    }

    [Fact]
    public async Task Save_with_a_path_that_is_gone_asks_where()
    {
        _dialogs.Save = Path.Combine(_dir, "chosen.kql");

        var reply = await CallAsync("file.saveAs",
            $$"""{"suggestedName":"x.kql","content":"hi","path":{{JsonSerializer.Serialize(Path.Combine(_dir, "gone.kql"))}}}""");

        Assert.Equal(1, _dialogs.SaveCalls);
        Assert.Equal("x.kql", _dialogs.SavedName);
        Assert.Equal("hi", await File.ReadAllTextAsync(_dialogs.Save, TestContext.Current.CancellationToken));
        Assert.Equal(_dialogs.Save, reply.GetProperty("result").GetProperty("path").GetString());
    }

    [Fact]
    public async Task Save_cancelled_returns_null()
    {
        var reply = await CallAsync("file.saveAs", """{"suggestedName":"x.kql","content":"hi"}""");

        Assert.Equal(JsonValueKind.Null, reply.GetProperty("result").ValueKind);
        Assert.Empty(Directory.GetFiles(_dir));
    }

    [Fact]
    public async Task Save_is_atomic_and_overwrites()
    {
        var path = Path.Combine(_dir, "q.kql");
        await File.WriteAllTextAsync(path, "old content that is longer", TestContext.Current.CancellationToken);
        _dialogs.Save = path;

        await CallAsync("file.saveAs", """{"suggestedName":"q.kql","content":"new"}""");

        Assert.Equal("new", await File.ReadAllTextAsync(path, TestContext.Current.CancellationToken));
        Assert.Equal([path], Directory.GetFiles(_dir));
        Assert.Equal("new"u8.ToArray(), await File.ReadAllBytesAsync(path, TestContext.Current.CancellationToken));
    }

    [Fact]
    public async Task Save_without_content_is_a_bad_request()
    {
        _dialogs.Save = Path.Combine(_dir, "q.kql");

        var reply = await CallAsync("file.saveAs", """{"suggestedName":"q.kql"}""");

        Assert.Equal("bad_request", reply.GetProperty("error").GetProperty("code").GetString());
        Assert.Equal(0, _dialogs.SaveCalls);
    }

    [Fact]
    public async Task Photino_dialogs_before_the_window_exists_fail()
    {
        var dialogs = new PhotinoFileDialogs(new WindowHolder());

        var ex = await Assert.ThrowsAsync<Messaging.BridgeException>(() => dialogs.OpenAsync("Open", []));

        Assert.Equal("failed", ex.Code);
        Assert.Equal("The window isn't ready yet.", ex.Message);
    }

    private sealed class FakeDialogs : IFileDialogs
    {
        public string? Open { get; set; }

        public string? Save { get; set; }

        public IReadOnlyList<FileFilter>? OpenFilters { get; private set; }

        public int SaveCalls { get; private set; }

        public string? SavedName { get; private set; }

        public Task<string?> OpenAsync(string title, IReadOnlyList<FileFilter> filters)
        {
            OpenFilters = filters;
            return Task.FromResult(Open);
        }

        public Task<string?> SaveAsync(string title, string suggestedName, IReadOnlyList<FileFilter> filters)
        {
            SaveCalls++;
            SavedName = suggestedName;
            return Task.FromResult(Save);
        }
    }
}
