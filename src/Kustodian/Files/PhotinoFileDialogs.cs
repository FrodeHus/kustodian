using Kustodian.Messaging;
using Photino.NET;

namespace Kustodian.Files;

/// <summary>Holds the app's window. The bridge's handlers are registered before the window exists, so
/// <see cref="Kustodian.App.AppWindow"/> sets it once it has been created.</summary>
public sealed class WindowHolder
{
    private PhotinoWindow? _window;

    public PhotinoWindow? Window
    {
        get => Volatile.Read(ref _window);
        set => Volatile.Write(ref _window, value);
    }
}

/// <summary>Photino's native open and save dialogs. Photino's <c>ShowOpenFile</c> and <c>ShowSaveFile</c> hand the native call to
/// the UI thread themselves and wait for it, so they must not be called from that thread: this runs them on the thread pool.</summary>
public sealed class PhotinoFileDialogs(WindowHolder holder) : IFileDialogs
{
    public async Task<string?> OpenAsync(string title, IReadOnlyList<FileFilter> filters)
    {
        var window = Window();
        var chosen = await window.ShowOpenFileAsync(title, filters: Native(filters));
        return chosen is { Length: > 0 } ? chosen[0] : null;
    }

    public async Task<string?> SaveAsync(string title, string suggestedName, IReadOnlyList<FileFilter> filters)
    {
        var window = Window();
        // Photino takes a default folder, not a name, and the native dialog doesn't offer one for the file.
        var chosen = await window.ShowSaveFileAsync(title, filters: Native(filters));
        return string.IsNullOrEmpty(chosen) ? null : chosen;
    }

    private PhotinoWindow Window() =>
        holder.Window ?? throw new BridgeException(BridgeErrorCodes.Failed, "The window isn't ready yet.");

    private static (string, string[])[] Native(IReadOnlyList<FileFilter> filters) =>
        [.. filters.Select(f => (f.Name, f.Extensions.ToArray()))];
}
