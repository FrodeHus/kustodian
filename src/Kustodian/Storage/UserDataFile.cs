namespace Kustodian.Storage;

/// <summary>The outcome of reading a user data file. <see cref="Corrupt"/> is true when the file existed but could not be read
/// or was not valid; it was moved aside as <c>*.corrupt</c> and <see cref="Value"/> is the defaults.</summary>
public sealed record UserDataRead<T>(T Value, bool Corrupt);

/// <summary>
/// One user data file under the store's root, owned by one service: reads and writes go through one gate, so they never
/// overlap. A missing file reads as <paramref name="defaults"/>; content that doesn't parse, or that
/// <paramref name="isValid"/> refuses, is moved aside and read as the defaults too, marked corrupt. Writes are atomic
/// (<see cref="JsonFileStore.WriteAsync{T}"/>).
/// </summary>
public sealed class UserDataFile<T>(JsonFileStore store, string relativePath, Func<T> defaults, Func<T, bool> isValid)
    where T : class
{
    private readonly SemaphoreSlim _gate = new(1, 1);

    public async Task<UserDataRead<T>> ReadAsync(CancellationToken ct = default)
    {
        await _gate.WaitAsync(ct);
        try
        {
            var read = await store.ReadAsync<T?>(relativePath, null, ct);
            if (read.Corrupt)
            {
                return new UserDataRead<T>(defaults(), true);
            }

            if (read.Value is null)
            {
                return new UserDataRead<T>(defaults(), false);
            }

            if (!isValid(read.Value))
            {
                store.MoveAside(relativePath);
                return new UserDataRead<T>(defaults(), true);
            }

            return new UserDataRead<T>(read.Value, false);
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task WriteAsync(T value, CancellationToken ct = default)
    {
        await _gate.WaitAsync(ct);
        try
        {
            await store.WriteAsync(relativePath, value, ct);
        }
        finally
        {
            _gate.Release();
        }
    }
}
