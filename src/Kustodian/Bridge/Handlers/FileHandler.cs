using System.Text;
using System.Text.Json;
using Kustodian.Files;

namespace Kustodian.Messaging.Handlers;

/// <summary><c>file.open</c> takes <c>{title?, filters?}</c> and answers <c>{path, name, text}</c> for the file the user chose, or
/// <c>null</c> when the dialog was cancelled. Files over 5 MB, and files that aren't UTF-8 text, are a <c>bad_request</c>; a leading
/// byte order mark is dropped. <c>file.saveAs</c> takes <c>{suggestedName, content, title?, filters?, path?}</c> and answers
/// <c>{path, name}</c>, or null when cancelled. A <c>path</c> that still exists is written without a dialog (Save on a tab that came
/// from a file) only if it is one the user chose in a dialog this session or one a tab of the saved session came from; any other
/// <c>path</c> is ignored and the dialog is shown. A dialog's result with no extension gets the first filter's first one. Writes go
/// to a temp file next to the target, which is then renamed over it.</summary>
public sealed class FileHandler(IFileDialogs dialogs, AllowedFilePaths allowed)
{
    private const int MaxOpenBytes = 5 * 1024 * 1024;
    private const int MaxSaveBytes = 200 * 1024 * 1024;

    private static readonly UTF8Encoding StrictUtf8 = new(encoderShouldEmitUTF8Identifier: false, throwOnInvalidBytes: true);

    public void Register(Bridge bridge)
    {
        bridge.Register("file.open", async (p, ct) => await OpenAsync(BridgeJson.Params<OpenParams>(p), ct));
        bridge.Register("file.saveAs", async (p, ct) => await SaveAsync(BridgeJson.Params<SaveParams>(p), ct));
    }

    private async Task<object?> OpenAsync(OpenParams request, CancellationToken ct)
    {
        var path = await dialogs.OpenAsync(request.Title ?? "Open", request.Filters ?? []);
        if (path is null)
        {
            return BridgeNull.Value;
        }

        allowed.Add(path);
        try
        {
            if (new FileInfo(path).Length > MaxOpenBytes)
            {
                throw new BridgeException(BridgeErrorCodes.BadRequest, "Files over 5 MB can't be opened.");
            }

            var bytes = await File.ReadAllBytesAsync(path, ct);
            var offset = bytes.AsSpan().StartsWith(Encoding.UTF8.Preamble) ? Encoding.UTF8.Preamble.Length : 0;
            return new OpenAnswer(path, Path.GetFileName(path), StrictUtf8.GetString(bytes, offset, bytes.Length - offset));
        }
        catch (DecoderFallbackException)
        {
            throw new BridgeException(BridgeErrorCodes.BadRequest, "The file isn't UTF-8 text.");
        }
        catch (IOException ex)
        {
            throw new BridgeException(BridgeErrorCodes.Failed, $"The file couldn't be read: {ex.Message}");
        }
        catch (UnauthorizedAccessException ex)
        {
            throw new BridgeException(BridgeErrorCodes.Failed, $"The file couldn't be read: {ex.Message}");
        }
    }

    private async Task<object?> SaveAsync(SaveParams request, CancellationToken ct)
    {
        if (request.Content is null)
        {
            throw new BridgeException(BridgeErrorCodes.BadRequest, "The request has no content.");
        }

        var bytes = Encoding.UTF8.GetBytes(request.Content);
        if (bytes.Length > MaxSaveBytes)
        {
            throw new BridgeException(BridgeErrorCodes.BadRequest, "Files over 200 MB can't be saved.");
        }

        string? path;
        if (request.Path is { Length: > 0 } given && File.Exists(given) && await allowed.ContainsAsync(given))
        {
            path = given;
        }
        else
        {
            var filters = request.Filters ?? [];
            path = await dialogs.SaveAsync(request.Title ?? "Save", request.SuggestedName ?? "", filters);
            if (path is null)
            {
                return BridgeNull.Value;
            }

            // The OS dialog doesn't add the extension on every platform. This can overwrite an existing foo.kql without the OS
            // having asked, because the dialog only checked for foo.
            path += MissingExtension(path, filters);
            allowed.Add(path);
        }

        try
        {
            await WriteAtomicAsync(path, bytes, ct);
        }
        catch (IOException ex)
        {
            throw new BridgeException(BridgeErrorCodes.Failed, $"The file couldn't be saved: {ex.Message}");
        }
        catch (UnauthorizedAccessException ex)
        {
            throw new BridgeException(BridgeErrorCodes.Failed, $"The file couldn't be saved: {ex.Message}");
        }

        return new SaveAnswer(path, Path.GetFileName(path));
    }

    private static string MissingExtension(string path, IReadOnlyList<FileFilter> filters)
    {
        if (Path.HasExtension(path) || filters.Count == 0 || filters[0].Extensions.Count == 0)
        {
            return "";
        }

        var extension = filters[0].Extensions[0].TrimStart('*', '.');
        return extension.Length == 0 ? "" : "." + extension;
    }

    private static async Task WriteAtomicAsync(string path, byte[] bytes, CancellationToken ct)
    {
        var temp = Path.Combine(Path.GetDirectoryName(Path.GetFullPath(path))!, $".{Path.GetFileName(path)}.{Guid.NewGuid():N}.tmp");
        try
        {
            await using (var stream = new FileStream(temp, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            {
                await stream.WriteAsync(bytes, ct);
                await stream.FlushAsync(ct);
                stream.Flush(flushToDisk: true);
            }

            File.Move(temp, path, overwrite: true);
        }
        finally
        {
            try
            {
                File.Delete(temp);
            }
            catch (IOException)
            {
                // Cleaning up must not hide why the write failed.
            }
            catch (UnauthorizedAccessException)
            {
                // Same.
            }
        }
    }

    private sealed record OpenParams(string? Title, IReadOnlyList<FileFilter>? Filters);

    private sealed record SaveParams(string? Title, string? SuggestedName, string? Content, string? Path, IReadOnlyList<FileFilter>? Filters);

    private sealed record OpenAnswer(string Path, string Name, string Text);

    private sealed record SaveAnswer(string Path, string Name);
}
