using System.Text.Json;

namespace Kustodian.Storage;

/// <summary>The outcome of a read. <see cref="Corrupt"/> is true when the file existed but could not be parsed; it was moved
/// aside as <c>*.corrupt</c> and <see cref="Value"/> is the fallback.</summary>
public sealed record StoreRead<T>(T Value, bool Corrupt);

/// <summary>Small JSON files under one root directory. Writes are atomic: a temp file in the same directory, then a rename.</summary>
public sealed class JsonFileStore(string root)
{
    /// <summary>How the files are read and written: web defaults (camelCase, names matched ignoring case), indented.</summary>
    public static JsonSerializerOptions Options { get; } = new(JsonSerializerDefaults.Web) { WriteIndented = true };

    public string Root { get; } = Path.GetFullPath(root);

    public async Task<StoreRead<T>> ReadAsync<T>(string relativePath, T fallback, CancellationToken ct = default)
    {
        var path = Resolve(relativePath);
        if (!File.Exists(path))
        {
            return new StoreRead<T>(fallback, false);
        }

        try
        {
            await using var stream = File.OpenRead(path);
            var value = await JsonSerializer.DeserializeAsync<T>(stream, Options, ct);
            if (value is not null)
            {
                return new StoreRead<T>(value, false);
            }
        }
        catch (JsonException)
        {
        }

        MoveAside(relativePath);
        return new StoreRead<T>(fallback, true);
    }

    /// <summary>Renames the file to <c>*.corrupt</c>, replacing an earlier one.</summary>
    public void MoveAside(string relativePath)
    {
        var path = Resolve(relativePath);
        File.Move(path, path + ".corrupt", overwrite: true);
    }

    public async Task WriteAsync<T>(string relativePath, T value, CancellationToken ct = default)
    {
        var path = Resolve(relativePath);
        var directory = Path.GetDirectoryName(path)!;
        Directory.CreateDirectory(directory);

        var temp = Path.Combine(directory, $".{Path.GetFileName(path)}.{Guid.NewGuid():N}.tmp");
        try
        {
            await using (var stream = new FileStream(temp, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            {
                await JsonSerializer.SerializeAsync(stream, value, Options, ct);
                await stream.FlushAsync(ct);
                stream.Flush(flushToDisk: true);
            }

            File.Move(temp, path, overwrite: true);
        }
        finally
        {
            if (File.Exists(temp))
            {
                File.Delete(temp);
            }
        }
    }

    private string Resolve(string relativePath)
    {
        var full = Path.GetFullPath(Path.Combine(Root, relativePath));
        if (!full.StartsWith(Root + Path.DirectorySeparatorChar, StringComparison.Ordinal))
        {
            throw new ArgumentException("Path escapes the storage root.", nameof(relativePath));
        }

        return full;
    }
}
