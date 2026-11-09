namespace Kustodian.App;

/// <summary>GETs of untrusted content with a hard size limit and a deadline for the whole read.</summary>
public static class BoundedGet
{
    /// <summary>A GET read in chunks; over <paramref name="limit"/> bytes throws <see cref="InvalidDataException"/> without
    /// trusting Content-Length. <paramref name="timeout"/> bounds the whole read (HttpClient.Timeout covers only the headers
    /// here); its cancellation is not the caller's.</summary>
    public static async Task<byte[]> BytesAsync(HttpClient http, string url, long limit, TimeSpan timeout, CancellationToken ct)
    {
        using var limited = CancellationTokenSource.CreateLinkedTokenSource(ct);
        limited.CancelAfter(timeout);
        ct = limited.Token;
        using var response = await http.GetAsync(url, HttpCompletionOption.ResponseHeadersRead, ct);
        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync(ct);
        using var body = new MemoryStream();
        var buffer = new byte[16 * 1024];
        int read;
        while ((read = await stream.ReadAsync(buffer, ct)) > 0)
        {
            if (body.Length + read > limit)
            {
                throw new InvalidDataException($"The response is over {limit} bytes.");
            }

            body.Write(buffer, 0, read);
        }

        return body.ToArray();
    }
}
