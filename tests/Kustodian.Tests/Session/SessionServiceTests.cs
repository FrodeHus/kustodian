using Kustodian.Library;
using Kustodian.Sessions;
using Kustodian.Storage;

namespace Kustodian.Tests.Sessions;

public sealed class SessionServiceTests : IDisposable
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

    private SessionService NewService() => new(new JsonFileStore(_dir));

    private static SessionTab Tab(string id, string text = "users | take 5", string? savedId = null, IReadOnlyList<ParameterDef>? parameters = null) =>
        new(id, "graph", "Tab " + id, text, true, savedId, parameters ?? []);

    [Fact]
    public async Task Session_round_trip()
    {
        var parameters = new[] { new ParameterDef("days", "number", "30", true, ["7", "30"]) };
        var session = new Session(1, "b", [Tab("a"), Tab("b", savedId: "11111111-1111-1111-1111-111111111111", parameters: parameters)]);

        var dropped = await NewService().SaveAsync(session, Ct);
        var read = await NewService().GetAsync(Ct);

        Assert.Equal(0, dropped);
        Assert.False(read.Corrupt);
        Assert.Equal("b", read.Value.ActiveId);
        Assert.Equal(["a", "b"], read.Value.Tabs.Select(t => t.Id));
        Assert.Equal("users | take 5", read.Value.Tabs[0].Text);
        Assert.True(read.Value.Tabs[0].Dirty);
        Assert.Equal("11111111-1111-1111-1111-111111111111", read.Value.Tabs[1].SavedId);
        Assert.Equal(new ParameterDef("days", "number", "30", true, ["7", "30"]), read.Value.Tabs[1].Parameters.Single(),
            ParameterComparer.Instance);
    }

    [Fact]
    public async Task Missing_session_file_reads_as_an_empty_session()
    {
        var read = await NewService().GetAsync(Ct);

        Assert.False(read.Corrupt);
        Assert.Empty(read.Value.Tabs);
        Assert.Null(read.Value.ActiveId);
    }

    [Fact]
    public async Task Session_with_missing_fields_restores_with_defaults()
    {
        Directory.CreateDirectory(_dir);
        await File.WriteAllTextAsync(Path.Combine(_dir, "session.json"), """
            {"version":1,"activeId":"a","tabs":[
              {"id":"a","source":"graph","title":"One","text":"users","dirty":true,
               "parameters":[{"name":"days","value":"30"}]},
              {"id":"b"}]}
            """, Ct);

        var read = await NewService().GetAsync(Ct);

        Assert.False(read.Corrupt);
        var first = read.Value.Tabs[0];
        Assert.Null(first.SavedId);
        Assert.True(first.Dirty);
        var parameter = first.Parameters.Single();
        Assert.Equal("text", parameter.Type);
        Assert.False(parameter.Required);
        Assert.Equal("30", parameter.Value);
        var second = read.Value.Tabs[1];
        Assert.Empty(second.Parameters);
        Assert.Null(second.SavedId);
        Assert.False(second.Dirty);
        Assert.Equal("graph", second.Source);
        Assert.Equal("", second.Text);
    }

    [Fact]
    public async Task Session_over_tab_cap_drops_and_reports()
    {
        var tabs = Enumerable.Range(0, SessionService.MaxTabs + 3).Select(i => Tab("t" + i)).ToList();

        var dropped = await NewService().SaveAsync(new Session(1, "t0", tabs), Ct);
        var read = await NewService().GetAsync(Ct);

        Assert.Equal(3, dropped);
        Assert.Equal(SessionService.MaxTabs, read.Value.Tabs.Count);
        Assert.Equal("t0", read.Value.Tabs[0].Id);
    }

    [Fact]
    public async Task Session_tab_over_text_cap_is_dropped_and_active_moves_on()
    {
        var big = new string('x', SessionService.MaxTextBytes + 1);

        var dropped = await NewService().SaveAsync(new Session(1, "big", [Tab("a"), Tab("big", big)]), Ct);
        var read = await NewService().GetAsync(Ct);

        Assert.Equal(1, dropped);
        Assert.Equal(["a"], read.Value.Tabs.Select(t => t.Id));
        Assert.Null(read.Value.ActiveId);
    }

    [Fact]
    public async Task Corrupt_session_file_is_moved_aside_and_reads_as_empty()
    {
        Directory.CreateDirectory(_dir);
        await File.WriteAllTextAsync(Path.Combine(_dir, "session.json"), "{ not json", Ct);

        var read = await NewService().GetAsync(Ct);

        Assert.True(read.Corrupt);
        Assert.Empty(read.Value.Tabs);
        Assert.False(File.Exists(Path.Combine(_dir, "session.json")));
    }

    private static SessionTab RawTab(string id, RawTabRequest raw) => new(id, "raw", "Raw " + id, "me", false, null, [], null, raw);

    [Fact]
    public async Task Session_keeps_a_raw_tabs_version_and_headers_but_never_a_refused_header()
    {
        var raw = new RawTabRequest("v1.0",
        [
            new RawTabHeader("ConsistencyLevel", "eventual"),
            new RawTabHeader("Authorization", "Bearer secret-token"),
            new RawTabHeader("authorization", "Bearer secret-token"),
            new RawTabHeader("Host", "evil.example"),
            new RawTabHeader("Cookie", "a=b"),
            new RawTabHeader("Accept-Encoding", "gzip"),
            new RawTabHeader("Bad Name", "x"),
            new RawTabHeader("X-Split", "a\r\nAuthorization: Bearer secret-token"),
            new RawTabHeader("", "orphan"),
            new RawTabHeader(" Authorization ", "Bearer secret-token"),
            new RawTabHeader(" Prefer ", "odata.maxpagesize=5"),
        ]);

        await NewService().SaveAsync(new Session(1, "r", [RawTab("r", raw)]), Ct);
        var read = await NewService().GetAsync(Ct);
        var text = await File.ReadAllTextAsync(Path.Combine(_dir, "session.json"), Ct);

        var kept = read.Value.Tabs.Single().Raw;
        Assert.NotNull(kept);
        Assert.Equal("v1.0", kept.Version);
        Assert.Equal(["ConsistencyLevel", "Prefer"], kept.Headers.Select(h => h.Name));
        Assert.DoesNotContain("secret-token", text, StringComparison.Ordinal);
        Assert.DoesNotContain("authorization", text, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("evil.example", text, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Session_never_keeps_a_proxy_hop_by_hop_or_content_header()
    {
        var raw = new RawTabRequest("beta",
        [
            new RawTabHeader("Proxy-Authorization", "Basic proxy-secret"),
            new RawTabHeader(" proxy-authorization ", "Basic proxy-secret"),
            new RawTabHeader("Connection", "close"),
            new RawTabHeader("Transfer-Encoding", "chunked"),
            new RawTabHeader("Expect", "100-continue"),
            new RawTabHeader("Content-Type", "application/json"),
            new RawTabHeader("Last-Modified", "x"),
            new RawTabHeader("ConsistencyLevel", "eventual"),
        ]);

        await NewService().SaveAsync(new Session(1, "r", [RawTab("r", raw)]), Ct);
        var read = await NewService().GetAsync(Ct);
        var text = await File.ReadAllTextAsync(Path.Combine(_dir, "session.json"), Ct);

        Assert.Equal(["ConsistencyLevel"], read.Value.Tabs.Single().Raw!.Headers.Select(h => h.Name));
        Assert.DoesNotContain("proxy", text, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("Content-Type", text, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Session_raw_headers_are_capped_by_count_and_size_and_an_unknown_version_is_dropped()
    {
        var many = Enumerable.Range(0, 25).Select(i => new RawTabHeader($"X-H{i}", "v")).ToList();
        var big = new[] { new RawTabHeader("X-A", new string('a', 5000)), new RawTabHeader("X-B", new string('b', 5000)), new RawTabHeader("X-C", "c") };

        await NewService().SaveAsync(new Session(1, null, [RawTab("m", new RawTabRequest("v2", many)), RawTab("b", new RawTabRequest(null, big))]), Ct);
        var read = await NewService().GetAsync(Ct);

        var first = read.Value.Tabs[0].Raw!;
        Assert.Null(first.Version);
        Assert.Equal(20, first.Headers.Count);
        Assert.Equal("X-H19", first.Headers[^1].Name);
        // 8 KB in all: the second big header doesn't fit, the small one after it does.
        Assert.Equal(["X-A", "X-C"], read.Value.Tabs[1].Raw!.Headers.Select(h => h.Name));
    }

    [Fact]
    public async Task Session_raw_request_with_missing_fields_takes_defaults()
    {
        Directory.CreateDirectory(_dir);
        await File.WriteAllTextAsync(Path.Combine(_dir, "session.json"), """
            {"version":1,"tabs":[
              {"id":"r","source":"raw","raw":{"headers":[{"name":"Prefer"},{"value":"x"}]}},
              {"id":"g","source":"graph"},
              {"id":"e","source":"raw","raw":{}}]}
            """, Ct);

        var read = await NewService().GetAsync(Ct);

        Assert.False(read.Corrupt);
        var raw = read.Value.Tabs[0].Raw!;
        Assert.Null(raw.Version);
        Assert.Equal([("Prefer", ""), ("", "x")], raw.Headers.Select(h => (h.Name, h.Value)));
        Assert.Null(read.Value.Tabs[1].Raw);
        Assert.Empty(read.Value.Tabs[2].Raw!.Headers);
    }
}
