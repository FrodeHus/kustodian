using System.Net;
using System.Text;
using System.Text.Json;
using Kustodian.History;
using Kustodian.Library;
using Kustodian.Solutions;
using Kustodian.Storage;
using Kustodian.Workbooks;
using Microsoft.Extensions.Time.Testing;

namespace Kustodian.Tests.Solutions;

public sealed class SolutionServiceFetchTests : IDisposable
{
    private const string IndexUrl = SolutionService.BaseUrl + "index.json";
    private static readonly byte[] Readme = "# Hello"u8.ToArray();
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "kustodian-sol-" + Guid.NewGuid().ToString("N"));
    private readonly FakeTimeProvider _time = new(DateTimeOffset.Parse("2026-11-07T10:00:00Z", System.Globalization.CultureInfo.InvariantCulture));
    private readonly List<string> _requests = [];
    private readonly List<HistoryStore> _histories = [];
    private Func<string, HttpResponseMessage> _answer = _ => new HttpResponseMessage(HttpStatusCode.NotFound);
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    public void Dispose()
    {
        _histories.ForEach(h => h.Dispose());
        if (Directory.Exists(_dir))
        {
            Directory.Delete(_dir, true);
        }
    }

    private SolutionService Service(string appVersion = "1.0.0")
    {
        var store = new JsonFileStore(_dir);
        var http = new HttpClient(new Handler(url =>
        {
            _requests.Add(url);
            return _answer(url);
        }));
        var history = new HistoryStore(_dir, _time);
        _histories.Add(history);
        return new SolutionService(store, http, new LibraryService(store, _time), new WorkbookService(store, _time), history, _time,
            appVersion);
    }

    private static SolutionManifest Manifest(string id = "risky-signins", string min = "1.0.0") =>
        new(1, id, "Risky sign-ins", "1.0.0", "d", "a", "community", ["identity"], ["graph"], min, null,
            new SolutionContent([], [], []));

    private static IndexEntry Entry(SolutionManifest m, byte[]? readme = null, long? size = null) =>
        new(m, [new IndexFile("README.md", SolutionHash.Sha256(readme ?? Readme), size ?? (readme ?? Readme).Length)]);

    private static HttpResponseMessage Json(object o) =>
        new(HttpStatusCode.OK) { Content = new ByteArrayContent(JsonSerializer.SerializeToUtf8Bytes(o, JsonFileStore.Options)) };

    private static SolutionIndexDoc Doc(params IndexEntry[] entries) => new(1, entries);

    [Fact]
    public async Task ListFetchesAndCaches()
    {
        _answer = _ => Json(Doc(Entry(Manifest())));
        var svc = Service();

        var first = await svc.ListAsync(false, Ct);
        await svc.ListAsync(false, Ct);

        Assert.Equal([IndexUrl], _requests);
        Assert.False(first.Offline);
        Assert.Equal("risky-signins", Assert.Single(first.Solutions).Manifest.Id);
        Assert.True(File.Exists(Path.Combine(_dir, "solution-cache", "index.json")));

        _time.Advance(TimeSpan.FromMinutes(61));
        await svc.ListAsync(false, Ct);
        Assert.Equal(2, _requests.Count);

        await svc.ListAsync(true, Ct);
        Assert.Equal(3, _requests.Count);
    }

    [Fact]
    public async Task ListOfflineUsesCache()
    {
        _answer = _ => Json(Doc(Entry(Manifest())));
        var svc = Service();
        var fetched = (await svc.ListAsync(false, Ct)).FetchedAt;
        _time.Advance(TimeSpan.FromHours(2));
        _answer = _ => throw new HttpRequestException("down");

        var catalog = await svc.ListAsync(false, Ct);

        Assert.True(catalog.Offline);
        Assert.Equal(fetched, catalog.FetchedAt);
        Assert.Single(catalog.Solutions);
    }

    private static HttpResponseMessage Dropping() => new(HttpStatusCode.OK) { Content = new StreamContent(new DroppingStream()) };

    [Fact]
    public async Task ListWithADroppedBodyFallsBackToTheCache()
    {
        _answer = _ => Json(Doc(Entry(Manifest())));
        var svc = Service();
        await svc.ListAsync(false, Ct);
        _answer = _ => Dropping();

        var catalog = await svc.ListAsync(true, Ct);

        Assert.True(catalog.Offline);
        Assert.Single(catalog.Solutions);
    }

    [Fact]
    public async Task ADroppedBodyIsUnreachable()
    {
        _answer = _ => Dropping();
        var ex = await Assert.ThrowsAsync<SolutionRejectedException>(() => Service().ListAsync(false, Ct));
        Assert.Equal("Kustodian couldn't reach GitHub.", ex.Message);

        _answer = url => url == IndexUrl ? Json(Doc(Entry(Manifest()))) : Dropping();
        ex = await Assert.ThrowsAsync<SolutionRejectedException>(() => Service().GetAsync("risky-signins", Ct));
        Assert.Equal("Kustodian couldn't reach GitHub.", ex.Message);
    }

    [Fact]
    public async Task ListOfflineWithoutCacheThrows()
    {
        _answer = _ => throw new HttpRequestException("down");

        var ex = await Assert.ThrowsAsync<SolutionRejectedException>(() => Service().ListAsync(false, Ct));

        Assert.Equal("Kustodian couldn't reach GitHub.", ex.Message);
    }

    [Fact]
    public async Task ListDropsBadEntries()
    {
        var good = Entry(Manifest("good-one"));
        var badSupport = Entry(Manifest("bad-one") with { Support = "nobody" });
        var badFile = new IndexEntry(Manifest("bad-file"), [new IndexFile("README.md", "xyz", 3)]);
        var extra = new IndexEntry(Manifest("extra-file"),
            [.. Entry(Manifest("extra-file")).Files, new IndexFile("tools.json", SolutionHash.Sha256(Readme), 3)]);
        var missing = new IndexEntry(Manifest("no-files"), []);
        _answer = _ => Json(Doc(good, badSupport, badFile, extra, missing));

        var catalog = await Service().ListAsync(false, Ct);

        Assert.Equal(["good-one"], catalog.Solutions.Select(s => s.Manifest.Id));
    }

    [Fact]
    public async Task ListDropsEntriesWithNulls()
    {
        var good = Entry(Manifest("good-one"));
        const string Rest = """
            "name":"n","solutionVersion":"1.0.0","support":"community","minAppVersion":"1.0.0","categories":[],"sources":[],"description":"d","author":"a"
            """;
        var json = $$$"""
            {"version":1,"solutions":[
              {"manifest":null,"files":[]},
              {"manifest":{"id":"null-parts","name":"n"},"files":[{"path":null,"sha256":null,"size":1}]},
              {"manifest":{"id":"null-files",{{{Rest}}},"content":{"queries":[],"workbooks":[],"tools":[]}},"files":null},
              {"manifest":{"id":"null-item",{{{Rest}}},"content":{"queries":[null],"workbooks":[],"tools":[]}},"files":[]},
              {"manifest":{"id":"null-path",{{{Rest}}},"content":{"queries":[],"workbooks":[],"tools":[]}},"files":[{"path":null,"sha256":null,"size":1}]},
              {{{JsonSerializer.Serialize(good, JsonFileStore.Options)}}}
            ]}
            """;
        _answer = _ => new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(json) };

        var catalog = await Service().ListAsync(false, Ct);

        Assert.Equal(["good-one"], catalog.Solutions.Select(s => s.Manifest.Id));
    }

    [Fact]
    public async Task CompatibleFollowsMinAppVersion()
    {
        _answer = _ => Json(Doc(Entry(Manifest("needs-new", "1.1.0")), Entry(Manifest("works-now"))));

        var catalog = await Service("1.0.0").ListAsync(false, Ct);

        Assert.Equal([("needs-new", false), ("works-now", true)],
            catalog.Solutions.Select(s => (s.Manifest.Id, s.Compatible)).Order());
    }

    [Fact]
    public async Task IndexOverLimitIsRefused()
    {
        _answer = _ => new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(new byte[5 * 1024 * 1024]) };

        await Assert.ThrowsAsync<SolutionRejectedException>(() => Service().ListAsync(false, Ct));
    }

    [Fact]
    public async Task GetReturnsTheReadmeWhenTheHashMatches()
    {
        _answer = url => url == IndexUrl
            ? Json(Doc(Entry(Manifest())))
            : new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(Readme) };

        var (manifest, readme) = await Service().GetAsync("risky-signins", Ct);

        Assert.Equal("risky-signins", manifest.Id);
        Assert.Equal(Encoding.UTF8.GetString(Readme), readme);
        Assert.Equal(SolutionService.BaseUrl + "risky-signins/README.md", _requests[^1]);
    }

    [Theory]
    [InlineData("tampered")]
    [InlineData("a much longer body than the index promised")]
    public async Task GetChecksHash(string body)
    {
        _answer = url => url == IndexUrl
            ? Json(Doc(Entry(Manifest())))
            : new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(Encoding.UTF8.GetBytes(body)) };

        var ex = await Assert.ThrowsAsync<SolutionRejectedException>(() => Service().GetAsync("risky-signins", Ct));

        Assert.Equal("The download didn't match the catalog. Try again later.", ex.Message);
        Assert.Equal(SolutionService.BaseUrl + "risky-signins/README.md", _requests[^1]);
    }

    private sealed class DroppingStream : Stream
    {
        private bool _first = true;
        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
        public override void Flush() { }
        public override int Read(byte[] buffer, int offset, int count) => throw new IOException("connection dropped");
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();

        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        {
            if (!_first)
            {
                throw new IOException("connection dropped");
            }

            _first = false;
            buffer.Span[0] = (byte)'{';
            return ValueTask.FromResult(1);
        }
    }

    private sealed class Handler(Func<string, HttpResponseMessage> answer) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) =>
            Task.FromResult(answer(request.RequestUri!.ToString()));
    }
}
