namespace Kustodian.Sources;

/// <summary>Reads a response body with a size cap, so a body over it is never held whole.</summary>
internal static class BodyReader
{
    private const int ChunkBytes = 81_920;

    /// <summary>The body, or null when it is over <paramref name="maxBytes"/>: the stated <c>Content-Length</c> is checked before
    /// anything is read, and reading stops as soon as the bytes read pass the cap.</summary>
    public static async Task<byte[]?> ReadAsync(HttpContent content, long maxBytes, CancellationToken ct)
    {
        if (content.Headers.ContentLength > maxBytes)
        {
            return null;
        }

        await using var stream = await content.ReadAsStreamAsync(ct);
        using var buffer = new MemoryStream();
        var chunk = new byte[ChunkBytes];
        int read;
        while ((read = await stream.ReadAsync(chunk, ct)) > 0)
        {
            if (buffer.Length + read > maxBytes)
            {
                return null;
            }

            buffer.Write(chunk, 0, read);
        }

        return buffer.ToArray();
    }
}
