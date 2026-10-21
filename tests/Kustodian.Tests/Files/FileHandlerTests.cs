using System.Text;
using System.Text.Json;
using Kustodian.Files;
using Kustodian.Messaging.Handlers;
using Kustodian.Sessions;
using Kustodian.Storage;

namespace Kustodian.Tests.Files;

public sealed class FileHandlerTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "kustodian-tests-" + Guid.NewGuid().ToString("N"));
    private readonly FakeDialogs _dialogs = new();
    private readonly AllowedFilePaths _allowed = new();
    private readonly Messaging.Bridge _bridge = new(_ => { });

    public FileHandlerTests()
    {
        Directory.CreateDirectory(_dir);
        new FileHandler(_dialogs, _allowed).Register(_bridge);
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
        _allowed.Add(path);

        var reply = await CallAsync("file.saveAs", $$"""{"suggestedName":"x.kql","content":"new","path":{{JsonSerializer.Serialize(path)}}}""");

        Assert.Equal(0, _dialogs.SaveCalls);
        Assert.Equal("new", await File.ReadAllTextAsync(path, TestContext.Current.CancellationToken));
        Assert.Equal("q.kql", reply.GetProperty("result").GetProperty("name").GetString());
    }

    [Fact]
    public async Task Save_with_a_path_outside_the_allowed_set_shows_the_dialog_and_leaves_the_file()
    {
        var outside = Path.Combine(_dir, "outside.txt");
        await File.WriteAllTextAsync(outside, "precious", TestContext.Current.CancellationToken);

        var reply = await CallAsync("file.saveAs",
            $$"""{"suggestedName":"x.kql","content":"new","path":{{JsonSerializer.Serialize(outside)}}}""");

        Assert.Equal(1, _dialogs.SaveCalls);
        Assert.Equal("precious", await File.ReadAllTextAsync(outside, TestContext.Current.CancellationToken));
        Assert.Equal(JsonValueKind.Null, reply.GetProperty("result").ValueKind);
    }

    [Fact]
    public async Task A_path_the_dialog_returned_is_then_saved_to_without_a_dialog()
    {
        var path = Path.Combine(_dir, "chosen.kql");
        _dialogs.Save = path;
        await CallAsync("file.saveAs", """{"suggestedName":"chosen.kql","content":"one"}""");

        await CallAsync("file.saveAs", $$"""{"suggestedName":"chosen.kql","content":"two","path":{{JsonSerializer.Serialize(path)}}}""");

        Assert.Equal(1, _dialogs.SaveCalls);
        Assert.Equal("two", await File.ReadAllTextAsync(path, TestContext.Current.CancellationToken));
    }

    [Fact]
    public async Task A_path_from_a_file_open_is_allowed()
    {
        var path = Path.Combine(_dir, "opened.kql");
        await File.WriteAllTextAsync(path, "old", TestContext.Current.CancellationToken);
        _dialogs.Open = path;
        await CallAsync("file.open", "{}");

        await CallAsync("file.saveAs", $$"""{"suggestedName":"x.kql","content":"new","path":{{JsonSerializer.Serialize(path)}}}""");

        Assert.Equal(0, _dialogs.SaveCalls);
        Assert.Equal("new", await File.ReadAllTextAsync(path, TestContext.Current.CancellationToken));
    }

    [Fact]
    public async Task A_path_from_the_saved_session_is_allowed()
    {
        var path = Path.Combine(_dir, "tabfile.kql");
        await File.WriteAllTextAsync(path, "old", TestContext.Current.CancellationToken);
        var sessions = new SessionService(new JsonFileStore(_dir));
        await sessions.SaveAsync(new Session(1, "a", [new SessionTab("a", "graph", "t", "x", false, null, [], path)]),
            TestContext.Current.CancellationToken);
        var bridge = new Messaging.Bridge(_ => { });
        new FileHandler(_dialogs, new AllowedFilePaths(sessions)).Register(bridge);

        await bridge.HandleAsync($$$"""{"id":"x","method":"file.saveAs","params":{"suggestedName":"x.kql","content":"new","path":{{{JsonSerializer.Serialize(path)}}}}}""");

        Assert.Equal(0, _dialogs.SaveCalls);
        Assert.Equal("new", await File.ReadAllTextAsync(path, TestContext.Current.CancellationToken));
    }

    [Fact]
    public async Task Save_adds_the_first_filter_extension_when_the_chosen_name_has_none()
    {
        _dialogs.Save = Path.Combine(_dir, "foo");

        var reply = await CallAsync("file.saveAs",
            """{"suggestedName":"foo","content":"hi","filters":[{"name":"KQL","extensions":["*.kql","txt"]}]}""");

        var expected = Path.Combine(_dir, "foo.kql");
        Assert.Equal("hi", await File.ReadAllTextAsync(expected, TestContext.Current.CancellationToken));
        Assert.Equal(expected, reply.GetProperty("result").GetProperty("path").GetString());
        Assert.Equal("foo.kql", reply.GetProperty("result").GetProperty("name").GetString());
    }

    [Theory]
    [InlineData("""[{"name":"All","extensions":["*"]}]""")]
    [InlineData("""[{"name":"None","extensions":[]}]""")]
    [InlineData("[]")]
    public async Task Save_adds_no_extension_without_a_usable_filter(string filters)
    {
        _dialogs.Save = Path.Combine(_dir, "foo");

        var reply = await CallAsync("file.saveAs", $$"""{"suggestedName":"foo","content":"hi","filters":{{filters}}}""");

        Assert.Equal("foo", reply.GetProperty("result").GetProperty("name").GetString());
    }

    [Theory]
    [InlineData("x/../../../.zshrc")]
    [InlineData("k\\u0000ql")]
    [InlineData("..")]
    [InlineData("averyveryverylongextension")]
    public async Task Save_adds_no_extension_that_is_not_plain_letters_and_digits(string extension)
    {
        var chosen = Path.Combine(_dir, "foo");
        _dialogs.Save = chosen;

        var reply = await CallAsync("file.saveAs", $$"""{"suggestedName":"foo","content":"hi","filters":[{"name":"X","extensions":["{{extension}}"]}]}""");

        Assert.Equal(chosen, reply.GetProperty("result").GetProperty("path").GetString());
        Assert.Equal("hi", await File.ReadAllTextAsync(chosen, TestContext.Current.CancellationToken));
        Assert.Equal([chosen], Directory.GetFileSystemEntries(_dir));
    }

    [Fact]
    public async Task Save_does_not_double_the_dot_of_a_name_ending_in_one()
    {
        _dialogs.Save = Path.Combine(_dir, "foo.");

        var reply = await CallAsync("file.saveAs", """{"suggestedName":"foo","content":"hi","filters":[{"name":"KQL","extensions":["kql"]}]}""");

        Assert.DoesNotContain("..", reply.GetProperty("result").GetProperty("name").GetString());
    }

    [Fact]
    public async Task A_file_open_refused_for_its_size_does_not_become_writable()
    {
        var path = Path.Combine(_dir, "big.kql");
        await File.WriteAllBytesAsync(path, new byte[(5 * 1024 * 1024) + 1], TestContext.Current.CancellationToken);
        _dialogs.Open = path;
        await CallAsync("file.open", "{}");

        await CallAsync("file.saveAs", $$"""{"suggestedName":"x.kql","content":"new","path":{{JsonSerializer.Serialize(path)}}}""");

        Assert.Equal(1, _dialogs.SaveCalls);
        Assert.Equal(5 * 1024 * 1024L + 1, new FileInfo(path).Length);
    }

    [Fact]
    public async Task A_file_open_refused_as_not_utf8_does_not_become_writable()
    {
        var path = Path.Combine(_dir, "latin.kql");
        await File.WriteAllBytesAsync(path, [0x61, 0xE6, 0xF8], TestContext.Current.CancellationToken);
        _dialogs.Open = path;
        await CallAsync("file.open", "{}");

        await CallAsync("file.saveAs", $$"""{"suggestedName":"x.kql","content":"new","path":{{JsonSerializer.Serialize(path)}}}""");

        Assert.Equal(1, _dialogs.SaveCalls);
        Assert.Equal([0x61, 0xE6, 0xF8], await File.ReadAllBytesAsync(path, TestContext.Current.CancellationToken));
    }

    [Fact]
    public async Task An_unreadable_session_seeds_nothing_and_does_not_fault()
    {
        if (OperatingSystem.IsWindows())
        {
            Assert.Skip("File modes are Unix only.");
            return;
        }

        var sessionFile = Path.Combine(_dir, SessionService.FileName);
        await File.WriteAllTextAsync(sessionFile, "{}", TestContext.Current.CancellationToken);
        File.SetUnixFileMode(sessionFile, UnixFileMode.None);
        try
        {
            var allowed = new AllowedFilePaths(new SessionService(new JsonFileStore(_dir)));

            Assert.False(await allowed.ContainsAsync(Path.Combine(_dir, "a.kql")));
            allowed.Add(Path.Combine(_dir, "a.kql"));
            Assert.True(await allowed.ContainsAsync(Path.Combine(_dir, "a.kql")));
        }
        finally
        {
            File.SetUnixFileMode(sessionFile, UnixFileMode.UserRead | UnixFileMode.UserWrite);
        }
    }

    [Fact]
    public async Task Save_that_cannot_replace_the_target_fails_and_leaves_it_and_no_temp_file()
    {
        var target = Path.Combine(_dir, "q.kql");
        Directory.CreateDirectory(target);
        await File.WriteAllTextAsync(Path.Combine(target, "inner.txt"), "keep", TestContext.Current.CancellationToken);
        _dialogs.Save = target;

        var reply = await CallAsync("file.saveAs", """{"suggestedName":"q.kql","content":"new"}""");

        Assert.Equal("failed", reply.GetProperty("error").GetProperty("code").GetString());
        Assert.Equal("keep", await File.ReadAllTextAsync(Path.Combine(target, "inner.txt"), TestContext.Current.CancellationToken));
        Assert.Equal([target], Directory.GetFileSystemEntries(_dir));
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
