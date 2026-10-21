using System.Diagnostics;
using System.Text;
using System.Text.Json;
using Kustodian.Graph.Fetch;

namespace Kustodian.Raw;

/// <summary>A raw Graph answer: its status, its headers (never <c>Set-Cookie</c> or <c>Authorization</c>), its body as text
/// (at most <see cref="RawRequestService.MaxBodyBytes"/>, <see cref="Truncated"/> when there was more), how long it took, and the
/// body's <c>@odata.nextLink</c> when it has one, and the account it was sent for (a next page goes out for the same one).</summary>
public sealed record RawResponse(int Status, IReadOnlyDictionary<string, string> Headers, string Body, long DurationMs,
    string? NextLink, bool Truncated, string AccountKey);

/// <summary>A raw request the service won't send; its message says why and is shown to the user.</summary>
public sealed class RawRequestRefusedException(string message) : Exception(message);

/// <summary>
/// GET requests to Graph as the user typed them, for the raw tab. Every request goes through the Graph client
/// (<c>GraphHttp.CreateClient</c>), carries the account it was made for, and can only reach <c>https://graph.microsoft.com</c>
/// under <c>beta</c> or <c>v1.0</c>: a path is refused if it is absolute, starts with a slash or backslash, contains a
/// backslash, <c>#</c>, <c>://</c>, a control character, or (after percent-decoding, repeated until nothing changes) <c>..</c>;
/// and the URL built from it must still be https on that host with the version as its first segment. A next link must be such a
/// URL too. The page's headers are refused if they name <c>Authorization</c>, <c>Host</c>, <c>Cookie</c>,
/// <c>Accept-Encoding</c> (the body would come back compressed, and unreadable), any <c>Proxy-*</c> header, a hop-by-hop header
/// (<c>Connection</c>, <c>Keep-Alive</c>, <c>TE</c>, <c>Trailer</c>, <c>Transfer-Encoding</c>, <c>Upgrade</c>, <c>Expect</c>)
/// or a content header (any <c>Content-*</c>, <c>Allow</c>, <c>Expires</c>, <c>Last-Modified</c>: a GET has no body, and
/// .NET won't put them on a request), hold anything but
/// printable ASCII (so no CR or LF), or number more than <see cref="MaxHeaders"/> or <see cref="MaxHeaderBytes"/> in total.
/// Nothing here logs a request header. Refusals throw <see cref="RawRequestRefusedException"/>.
/// </summary>
public sealed class RawRequestService(HttpClient graph, TimeProvider? time = null)
{
    public const int MaxHeaders = 20;
    public const int MaxHeaderBytes = 8 * 1024;
    public const int MaxBodyBytes = 10 * 1024 * 1024;

    private const string GraphHost = "graph.microsoft.com";
    private static readonly string[] Versions = ["beta", "v1.0"];
    private static readonly HashSet<string> RefusedHeaders = new(
        [
            "Authorization", "Host", "Cookie", "Accept-Encoding",
            "Connection", "Keep-Alive", "TE", "Trailer", "Transfer-Encoding", "Upgrade", "Expect",
            "Allow", "Expires", "Last-Modified",
        ],
        StringComparer.OrdinalIgnoreCase);
    private static readonly string[] RefusedHeaderPrefixes = ["Proxy-", "Content-"];
    private static readonly HashSet<string> HiddenResponseHeaders =
        new(["Set-Cookie", "Set-Cookie2", "Authorization", "Proxy-Authorization"], StringComparer.OrdinalIgnoreCase);

    private readonly TimeProvider _time = time ?? TimeProvider.System;

    /// <summary>GETs <c>https://graph.microsoft.com/{version}/{path}</c> for <paramref name="accountKey"/>, with
    /// <paramref name="headers"/> added.</summary>
    public Task<RawResponse> SendAsync(string accountKey, string version, string path, IReadOnlyDictionary<string, string> headers,
        CancellationToken ct)
    {
        if (!Versions.Contains(version, StringComparer.Ordinal))
        {
            throw new RawRequestRefusedException("The version must be beta or v1.0.");
        }

        CheckPath(path);
        var checkedHeaders = CheckHeaders(headers);
        if (!Uri.TryCreate($"https://{GraphHost}/{version}/{path}", UriKind.Absolute, out var uri) || !IsGraphUrl(uri, version))
        {
            throw new RawRequestRefusedException("The path must stay on Graph.");
        }

        return GetAsync(accountKey, uri, checkedHeaders, ct);
    }

    /// <summary>GETs a next link from an earlier answer for <paramref name="accountKey"/>. It must be an absolute https URL on
    /// <c>graph.microsoft.com</c> under <c>beta</c> or <c>v1.0</c>.</summary>
    public Task<RawResponse> NextAsync(string accountKey, string nextLink, CancellationToken ct)
    {
        if (!Uri.TryCreate(nextLink, UriKind.Absolute, out var uri) || !Versions.Any(v => IsGraphUrl(uri, v)))
        {
            throw new RawRequestRefusedException("A next link must be an https URL on graph.microsoft.com.");
        }

        return GetAsync(accountKey, uri, [], ct);
    }

    private async Task<RawResponse> GetAsync(string accountKey, Uri uri, IReadOnlyList<KeyValuePair<string, string>> headers,
        CancellationToken ct)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, uri).ForAccount(accountKey);
        foreach (var (name, value) in headers)
        {
            if (!request.Headers.TryAddWithoutValidation(name, value))
            {
                throw new RawRequestRefusedException($"The header {name} can't be sent on a GET request.");
            }
        }

        var started = _time.GetTimestamp();
        using var response = await graph.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);
        var (body, truncated) = await ReadBodyAsync(response.Content, ct);
        var duration = (long)Math.Round(_time.GetElapsedTime(started).TotalMilliseconds);
        return new RawResponse((int)response.StatusCode, ResponseHeaders(response), body, duration,
            truncated ? null : NextLinkOf(body), truncated, accountKey);
    }

    /// <summary>Reads at most <see cref="MaxBodyBytes"/> plus one byte, so a longer body is known to be longer without being
    /// read to its end.</summary>
    private static async Task<(string Body, bool Truncated)> ReadBodyAsync(HttpContent content, CancellationToken ct)
    {
        await using var stream = await content.ReadAsStreamAsync(ct);
        using var body = new MemoryStream();
        var chunk = new byte[81920];
        while (body.Length <= MaxBodyBytes)
        {
            var want = (int)Math.Min(chunk.Length, MaxBodyBytes + 1 - body.Length);
            var read = await stream.ReadAsync(chunk.AsMemory(0, want), ct);
            if (read == 0)
            {
                break;
            }

            body.Write(chunk, 0, read);
        }

        var truncated = body.Length > MaxBodyBytes;
        return (Encoding.UTF8.GetString(body.GetBuffer(), 0, (int)Math.Min(body.Length, MaxBodyBytes)), truncated);
    }

    private static Dictionary<string, string> ResponseHeaders(HttpResponseMessage response)
    {
        var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var (name, values) in response.Headers.NonValidated.Concat(response.Content.Headers.NonValidated))
        {
            if (!HiddenResponseHeaders.Contains(name))
            {
                headers[name] = string.Join(", ", values);
            }
        }

        return headers;
    }

    private static string? NextLinkOf(string body)
    {
        try
        {
            using var doc = JsonDocument.Parse(body);
            return doc.RootElement.ValueKind == JsonValueKind.Object
                && doc.RootElement.TryGetProperty("@odata.nextLink", out var next)
                && next.ValueKind == JsonValueKind.String
                ? next.GetString()
                : null;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    /// <summary>The second guard, on the URL as it will be sent: https, the Graph host on its default port, no user info or
    /// fragment, and <paramref name="version"/> as the first path segment.</summary>
    private static bool IsGraphUrl(Uri uri, string version) =>
        uri.IsAbsoluteUri
        && uri.Scheme == Uri.UriSchemeHttps
        && uri.Host == GraphHost
        && uri.IsDefaultPort
        && uri.UserInfo.Length == 0
        && uri.Fragment.Length == 0
        && uri.AbsolutePath.StartsWith($"/{version}/", StringComparison.Ordinal);

    private static void CheckPath(string path)
    {
        if (string.IsNullOrEmpty(path))
        {
            throw new RawRequestRefusedException("The request needs a path.");
        }

        if (path[0] is '/' or '\\')
        {
            throw new RawRequestRefusedException("The path must be relative to the version, without a leading slash.");
        }

        if (path.Any(c => char.IsControl(c)) || path.Contains('\\') || path.Contains('#'))
        {
            throw new RawRequestRefusedException("The path can't contain backslashes, # or control characters.");
        }

        if (path.Contains("://", StringComparison.Ordinal) || Uri.TryCreate(path, UriKind.Absolute, out _))
        {
            throw new RawRequestRefusedException("The path must be relative to the version, not a URL.");
        }

        if (FullyDecoded(path).Contains("..", StringComparison.Ordinal))
        {
            throw new RawRequestRefusedException("The path can't contain '..'.");
        }
    }

    /// <summary>Percent-decodes until nothing changes, so a double-encoded <c>%252e</c> is seen as <c>.</c>.</summary>
    private static string FullyDecoded(string path)
    {
        var current = path;
        for (var i = 0; i < 16; i++)
        {
            var next = Uri.UnescapeDataString(current);
            if (next == current)
            {
                return current;
            }

            current = next;
        }

        throw new RawRequestRefusedException("The path is encoded too many times.");
    }

    private static List<KeyValuePair<string, string>> CheckHeaders(IReadOnlyDictionary<string, string> headers)
    {
        if (headers.Count > MaxHeaders)
        {
            throw new RawRequestRefusedException($"At most {MaxHeaders} headers can be sent.");
        }

        var total = 0;
        var list = new List<KeyValuePair<string, string>>(headers.Count);
        foreach (var (name, value) in headers)
        {
            if (HeaderProblem(name, value) is { } problem)
            {
                throw new RawRequestRefusedException(problem);
            }

            total += name.Length + value.Length;
            if (total > MaxHeaderBytes)
            {
                throw new RawRequestRefusedException($"The headers can be at most {MaxHeaderBytes / 1024} KB in total.");
            }

            list.Add(new(name, value));
        }

        return list;
    }

    /// <summary>Why a header can't be sent from the raw tab, as the user is told it, or null when it can: its name must be an
    /// HTTP token and not one of the refused headers, and its value printable ASCII (so no CR or LF). The session keeps only
    /// headers this accepts.</summary>
    public static string? HeaderProblem(string? name, string? value)
    {
        if (string.IsNullOrEmpty(name) || !name.All(IsTokenChar))
        {
            return "A header name can only have letters, digits and !#$%&'*+-.^_`|~.";
        }

        if (RefusedHeaders.Contains(name) || RefusedHeaderPrefixes.Any(p => name.StartsWith(p, StringComparison.OrdinalIgnoreCase)))
        {
            return $"The {name} header can't be set from the raw tab.";
        }

        return value is null || !value.All(c => c is '\t' or (>= ' ' and <= '~'))
            ? $"The {name} header's value can only have printable ASCII characters."
            : null;
    }

    /// <summary>A character of an HTTP token (RFC 9110, 5.6.2).</summary>
    private static bool IsTokenChar(char c) =>
        c is (>= 'a' and <= 'z') or (>= 'A' and <= 'Z') or (>= '0' and <= '9')
            or '!' or '#' or '$' or '%' or '&' or '\'' or '*' or '+' or '-' or '.' or '^' or '_' or '`' or '|' or '~';
}
