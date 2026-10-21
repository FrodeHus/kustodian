using System.Collections.Concurrent;
using System.Net;
using System.Text;
using System.Text.Json;
using Kustodian.App;
using Kustodian.Auth;
using Kustodian.Graph.Run;
using Kustodian.Messaging.Handlers;
using Kustodian.Raw;

namespace Kustodian.Tests.Raw;

/// <summary>Raw Graph GETs through the bridge: the real token handler and request log over a fake Graph, as
/// <see cref="GraphHttp"/> chains them, so every guard is seen from what actually reaches the wire.</summary>
public sealed class RawRequestServiceTests : IDisposable
{
    private const string Account = "account-1";
    private const int TenMb = 10 * 1024 * 1024;
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private readonly FakeGraph _graph = new();
    private readonly Tokens _tokens = new();
    private readonly HttpClient _http;

    public RawRequestServiceTests()
    {
        _http = new HttpClient(new GraphAuthHandler(_tokens) { InnerHandler = new DiagnosticsHandler { InnerHandler = _graph } })
        {
            BaseAddress = GraphHttp.BaseAddress,
        };
    }

    public void Dispose() => _http.Dispose();

    [Theory]
    [InlineData("beta")]
    [InlineData("v1.0")]
    public async Task Get_builds_graph_url_for_version(string version)
    {
        var result = await SendAsync(new { version, path = "users?$top=5", headers = new { } });

        var request = Assert.Single(_graph.Requests);
        Assert.Equal(HttpMethod.Get, request.Method);
        Assert.Equal($"https://graph.microsoft.com/{version}/users?$top=5", request.Uri.AbsoluteUri);
        Assert.Equal(200, result.GetProperty("status").GetInt32());
        Assert.Equal("""{"value":[]}""", result.GetProperty("body").GetString());
        Assert.False(result.GetProperty("truncated").GetBoolean());
        Assert.Equal(JsonValueKind.Null, result.GetProperty("nextLink").ValueKind);
        Assert.True(result.GetProperty("durationMs").GetInt64() >= 0);
    }

    [Theory]
    [InlineData("//evil.example/x")]
    [InlineData("https://evil.example")]
    [InlineData("..%2fme")]
    [InlineData("/me")]
    [InlineData("\\\\x")]
    [InlineData("\\me")]
    [InlineData("me\\..\\..\\x")]
    [InlineData("users\\x")]
    [InlineData("..")]
    [InlineData("me/../../v1.0/me")]
    [InlineData("%2e%2e/me")]
    [InlineData("%2E%2E%2Fv1.0%2Fme")]
    [InlineData("me/%2e%2e/%2e%2e/x")]
    [InlineData("%252e%252e/me")]
    [InlineData("%25252e%25252e/me")]
    [InlineData("me#/x")]
    [InlineData("me?x=1#frag")]
    [InlineData("users?$filter=a://b")]
    [InlineData("mailto:x")]
    [InlineData("me\r\nHost: evil.example")]
    [InlineData("me\tx")]
    [InlineData("")]
    public async Task Path_that_leaves_graph_is_refused(string path)
    {
        var error = await SendErrorAsync(new { version = "beta", path, headers = new { } });

        Assert.Equal("bad_request", error.GetProperty("code").GetString());
        Assert.Empty(_graph.Requests);
    }

    [Theory]
    [InlineData("@evil.example/x", "/beta/@evil.example/x")]
    [InlineData("me%2fx", "/beta/me%2fx")]
    [InlineData("users?$filter=displayName eq 'a?b'", "/beta/users")]
    [InlineData("users/a%3Fb", "/beta/users/a%3Fb")]
    public async Task Odd_paths_that_stay_on_graph_go_to_graph(string path, string absolutePath)
    {
        await SendAsync(new { version = "beta", path, headers = new { } });

        var uri = Assert.Single(_graph.Requests).Uri;
        Assert.Equal(("https", "graph.microsoft.com", absolutePath), (uri.Scheme, uri.Host, uri.AbsolutePath));
    }

    [Theory]
    [InlineData("v2")]
    [InlineData("Beta")]
    [InlineData("beta/..")]
    [InlineData("")]
    public async Task Version_other_than_beta_or_v1_is_refused(string version)
    {
        var error = await SendErrorAsync(new { version, path = "me", headers = new { } });

        Assert.Equal("bad_request", error.GetProperty("code").GetString());
        Assert.Empty(_graph.Requests);
    }

    [Fact]
    public async Task Missing_version_or_path_is_refused()
    {
        Assert.Equal("bad_request", (await SendErrorAsync(new { path = "me" })).GetProperty("code").GetString());
        Assert.Equal("bad_request", (await SendErrorAsync(new { version = "beta" })).GetProperty("code").GetString());
        Assert.Empty(_graph.Requests);
    }

    [Theory]
    [InlineData("Authorization")]
    [InlineData("authorization")]
    [InlineData("AUTHORIZATION")]
    [InlineData("Host")]
    [InlineData("host")]
    [InlineData("Cookie")]
    [InlineData("COOKIE")]
    public async Task Authorization_header_is_refused(string name)
    {
        var error = await SendErrorAsync(new
        {
            version = "beta",
            path = "me",
            headers = new Dictionary<string, string> { [name] = "Bearer page-token" },
        });

        Assert.Equal("bad_request", error.GetProperty("code").GetString());
        Assert.Empty(_graph.Requests);
        Assert.DoesNotContain("page-token", error.GetRawText(), StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("X-Test\r\nAuthorization", "x")]
    [InlineData("X-Test\n", "x")]
    [InlineData("X-Test", "a\r\nAuthorization: Bearer x")]
    [InlineData("X-Test", "a\nb")]
    [InlineData("X-Test", "a\rb")]
    [InlineData("X-Test", "a\0b")]
    [InlineData("Bad Name", "x")]
    [InlineData("", "x")]
    [InlineData("X-Test", "caf\u00e9")]
    public async Task Header_with_line_breaks_or_bad_characters_is_refused(string name, string value)
    {
        var error = await SendErrorAsync(new
        {
            version = "beta",
            path = "me",
            headers = new Dictionary<string, string> { [name] = value },
        });

        Assert.Equal("bad_request", error.GetProperty("code").GetString());
        Assert.Empty(_graph.Requests);
    }

    [Fact]
    public async Task More_than_twenty_headers_or_eight_kb_is_refused()
    {
        var many = Enumerable.Range(0, 21).ToDictionary(i => $"X-H{i}", _ => "v");
        var big = new Dictionary<string, string> { ["X-Big"] = new('a', 8 * 1024) };

        Assert.Equal("bad_request", (await SendErrorAsync(new { version = "beta", path = "me", headers = many }))
            .GetProperty("code").GetString());
        Assert.Equal("bad_request", (await SendErrorAsync(new { version = "beta", path = "me", headers = big }))
            .GetProperty("code").GetString());
        Assert.Empty(_graph.Requests);
    }

    [Fact]
    public async Task Other_headers_are_passed()
    {
        var headers = Enumerable.Range(0, 19).ToDictionary(i => $"X-H{i}", _ => "v");
        headers["ConsistencyLevel"] = "eventual";

        await SendAsync(new { version = "beta", path = "users/$count", headers });

        var request = Assert.Single(_graph.Requests);
        Assert.Equal("eventual", request.Headers["ConsistencyLevel"]);
        Assert.Equal("v", request.Headers["X-H18"]);
    }

    [Fact]
    public async Task Request_carries_account_key()
    {
        await SendAsync(new { version = "beta", path = "me", headers = new { } });

        Assert.Equal([Account], _tokens.Asked);
        Assert.Equal("Bearer tok-" + Account, Assert.Single(_graph.Requests).Headers["Authorization"]);
    }

    [Fact]
    public async Task Response_headers_exclude_set_cookie_and_authorization()
    {
        _graph.Answer = () =>
        {
            var response = FakeGraph.Json("""{"id":"1"}""");
            response.Headers.TryAddWithoutValidation("Set-Cookie", "session=abc");
            response.Headers.TryAddWithoutValidation("request-id", "r-1");
            return response;
        };

        var result = await SendAsync(new { version = "beta", path = "me", headers = new { } });

        var names = result.GetProperty("headers").EnumerateObject().Select(p => p.Name).ToList();
        Assert.DoesNotContain(names, n => n.Equals("Set-Cookie", StringComparison.OrdinalIgnoreCase));
        Assert.DoesNotContain(names, n => n.Equals("Authorization", StringComparison.OrdinalIgnoreCase));
        Assert.Equal("r-1", result.GetProperty("headers").GetProperty("request-id").GetString());
        Assert.Contains("application/json", result.GetProperty("headers").GetProperty("Content-Type").GetString(), StringComparison.Ordinal);
        Assert.DoesNotContain("tok-", result.GetRawText(), StringComparison.Ordinal);
    }

    [Fact]
    public async Task Next_link_in_the_body_is_returned_and_followed()
    {
        const string Next = "https://graph.microsoft.com/v1.0/users?$skiptoken=abc";
        _graph.Answer = () => FakeGraph.Json(JsonSerializer.Serialize(new Dictionary<string, object>
        {
            ["value"] = Array.Empty<object>(),
            ["@odata.nextLink"] = Next,
        }));

        var first = await SendAsync(new { version = "v1.0", path = "users", headers = new { } });
        Assert.Equal(Next, first.GetProperty("nextLink").GetString());

        await Call("raw.next", new { nextLink = Next });

        Assert.Equal(Next, _graph.Requests.Last().Uri.AbsoluteUri);
        Assert.All(_graph.Requests, r => Assert.Equal("Bearer tok-" + Account, r.Headers["Authorization"]));
    }

    [Theory]
    [InlineData("https://evil.example/beta/users")]
    [InlineData("http://graph.microsoft.com/beta/users")]
    [InlineData("users?$skiptoken=abc")]
    [InlineData("/beta/users")]
    [InlineData("//evil.example/beta/users")]
    [InlineData("https://graph.microsoft.com.evil.example/beta/users")]
    [InlineData("https://user@graph.microsoft.com/beta/users")]
    [InlineData("https://graph.microsoft.com:8443/beta/users")]
    [InlineData("https://graph.microsoft.com/v2/users")]
    [InlineData("https://graph.microsoft.com/beta/../v2/users")]
    [InlineData("https://graph.microsoft.com/beta/users#x")]
    [InlineData("")]
    public async Task Next_link_to_another_host_is_refused(string nextLink)
    {
        var reply = await Call("raw.next", new { nextLink });

        Assert.Equal("bad_request", reply.GetProperty("error").GetProperty("code").GetString());
        Assert.Empty(_graph.Requests);
    }

    [Fact]
    public async Task Body_over_10mb_is_truncated()
    {
        var stream = new EndlessStream();
        _graph.Answer = () => new HttpResponseMessage(HttpStatusCode.OK) { Content = new StreamContent(stream) };

        var result = await SendAsync(new { version = "beta", path = "users", headers = new { } });

        Assert.True(result.GetProperty("truncated").GetBoolean());
        Assert.Equal(TenMb, result.GetProperty("body").GetString()!.Length);
        Assert.Equal(JsonValueKind.Null, result.GetProperty("nextLink").ValueKind);
        // The endless body was not read to its end: at most the cap, its one extra byte and one read's slack.
        Assert.InRange(stream.BytesRead, TenMb + 1, TenMb + 1 + (128 * 1024));
    }

    [Fact]
    public async Task Body_of_exactly_10mb_is_not_truncated()
    {
        _graph.Answer = () => new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(Enumerable.Repeat((byte)'a', TenMb).ToArray()) };

        var result = await SendAsync(new { version = "beta", path = "users", headers = new { } });

        Assert.False(result.GetProperty("truncated").GetBoolean());
        Assert.Equal(TenMb, result.GetProperty("body").GetString()!.Length);
    }

    [Fact]
    public async Task Graph_error_status_is_returned_as_a_response()
    {
        _graph.Answer = () => new HttpResponseMessage(HttpStatusCode.Forbidden)
        {
            Content = new StringContent("""{"error":{"code":"Authorization_RequestDenied"}}""", Encoding.UTF8, "application/json"),
        };

        var result = await SendAsync(new { version = "beta", path = "users", headers = new { } });

        Assert.Equal(403, result.GetProperty("status").GetInt32());
        Assert.Contains("Authorization_RequestDenied", result.GetProperty("body").GetString(), StringComparison.Ordinal);
    }

    [Fact]
    public async Task Without_an_account_send_and_next_need_sign_in()
    {
        var bridge = NewBridge(account: null);

        foreach (var (method, p) in new (string, object)[]
        {
            ("raw.send", new { version = "beta", path = "me", headers = new { } }),
            ("raw.next", new { nextLink = "https://graph.microsoft.com/beta/users?$skiptoken=1" }),
        })
        {
            var error = (await Call(bridge, method, p)).GetProperty("error");
            Assert.Equal(("signInNeeded", GraphRunner.SignInMessage), (error.GetProperty("code").GetString(), error.GetProperty("message").GetString()));
        }

        Assert.Empty(_graph.Requests);
    }

    [Fact]
    public async Task An_account_whose_sign_in_expired_needs_sign_in()
    {
        var bridge = NewBridge(account: "expired");

        var error = (await Call(bridge, "raw.send", new { version = "beta", path = "me", headers = new { } })).GetProperty("error");

        Assert.Equal(("signInNeeded", GraphRunner.SignInMessage), (error.GetProperty("code").GetString(), error.GetProperty("message").GetString()));
        Assert.Empty(_graph.Requests);
    }

    private Messaging.Bridge NewBridge(string? account)
    {
        var bridge = new Messaging.Bridge(_ => { });
        new RawHandler(new RawRequestService(_http), () => Task.FromResult(account)).Register(bridge);
        return bridge;
    }

    private Task<JsonElement> Call(string method, object p) => Call(NewBridge(Account), method, p);

    private static async Task<JsonElement> Call(Messaging.Bridge bridge, string method, object p)
    {
        var json = await bridge.HandleAsync(JsonSerializer.Serialize(new { id = "r", method, @params = p }));
        Assert.NotNull(json);
        using var doc = JsonDocument.Parse(json);
        return doc.RootElement.Clone();
    }

    private async Task<JsonElement> SendAsync(object p)
    {
        var reply = await Call("raw.send", p);
        Assert.False(reply.TryGetProperty("error", out var error), error.ToString());
        return reply.GetProperty("result");
    }

    private async Task<JsonElement> SendErrorAsync(object p)
    {
        var reply = await Call("raw.send", p);
        Assert.True(reply.TryGetProperty("error", out var error), reply.ToString());
        return error;
    }

    private sealed record SeenRequest(HttpMethod Method, Uri Uri, IReadOnlyDictionary<string, string> Headers);

    private sealed class FakeGraph : HttpMessageHandler
    {
        public ConcurrentQueue<SeenRequest> Requests { get; } = new();

        public Func<HttpResponseMessage> Answer { get; set; } = () => Json("""{"value":[]}""");

        public static HttpResponseMessage Json(string body) =>
            new(HttpStatusCode.OK) { Content = new StringContent(body, Encoding.UTF8, "application/json") };

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var headers = request.Headers.ToDictionary(h => h.Key, h => string.Join(", ", h.Value), StringComparer.OrdinalIgnoreCase);
            Requests.Enqueue(new SeenRequest(request.Method, request.RequestUri!, headers));
            return Task.FromResult(Answer());
        }
    }

    /// <summary>Tokens for any account but <c>expired</c>, which has to sign in again.</summary>
    private sealed class Tokens : ITokenSource
    {
        public ConcurrentQueue<string> Asked { get; } = new();

        public Task<string> GetTokenAsync(string accountKey, Audience audience, CancellationToken ct)
        {
            Asked.Enqueue(accountKey);
            return accountKey == "expired"
                ? throw new SignInRequiredException("Sign in again.")
                : Task.FromResult("tok-" + accountKey);
        }
    }

    /// <summary>A body that never ends; counts the bytes read from it.</summary>
    private sealed class EndlessStream : Stream
    {
        public long BytesRead { get; private set; }

        public override bool CanRead => true;

        public override bool CanSeek => false;

        public override bool CanWrite => false;

        public override long Length => throw new NotSupportedException();

        public override long Position
        {
            get => throw new NotSupportedException();
            set => throw new NotSupportedException();
        }

        public override int Read(byte[] buffer, int offset, int count)
        {
            Array.Fill(buffer, (byte)'a', offset, count);
            BytesRead += count;
            return count;
        }

        public override void Flush()
        {
        }

        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();

        public override void SetLength(long value) => throw new NotSupportedException();

        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }
}
