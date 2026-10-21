using System.Net;
using System.Text;

namespace Kustodian.Sources.Tests.Hunting;

/// <summary>A request as the stub saw it: its method, URL, options and body (read before the request is disposed).</summary>
public sealed record SeenRequest(HttpMethod Method, Uri? Uri, HttpRequestOptions Options, string? Body);

/// <summary>Answers every request with what <c>answer</c> returns, and keeps each request it saw.</summary>
public sealed class StubGraph(Func<HttpRequestMessage, HttpResponseMessage> answer) : HttpMessageHandler
{
    private readonly List<SeenRequest> _seen = [];

    public IReadOnlyList<SeenRequest> Seen
    {
        get
        {
            lock (_seen)
            {
                return [.. _seen];
            }
        }
    }

    public HttpClient Client() => new(this, disposeHandler: false);

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        var body = request.Content is null ? null : await request.Content.ReadAsStringAsync(cancellationToken);
        lock (_seen)
        {
            _seen.Add(new SeenRequest(request.Method, request.RequestUri, request.Options, body));
        }

        cancellationToken.ThrowIfCancellationRequested();
        var response = answer(request);
        response.RequestMessage = request;
        return response;
    }

    public static HttpResponseMessage Json(HttpStatusCode status, string json) =>
        new(status) { Content = new StringContent(json, Encoding.UTF8, "application/json") };

    public static string Fixture(string name) => File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Fixtures", name));
}

/// <summary>A body that sends nothing until its read is cancelled.</summary>
public sealed class StallingStream : Stream
{
    public override bool CanRead => true;
    public override bool CanSeek => false;
    public override bool CanWrite => false;
    public override long Length => throw new NotSupportedException();
    public override long Position { get => 0; set => throw new NotSupportedException(); }

    public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
    {
        await Task.Delay(Timeout.Infinite, cancellationToken);
        return 0;
    }

    public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();

    public override void Flush()
    {
    }

    public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
    public override void SetLength(long value) => throw new NotSupportedException();
    public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
}
