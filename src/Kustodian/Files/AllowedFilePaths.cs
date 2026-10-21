using System.Collections.Concurrent;
using Kustodian.Sessions;

namespace Kustodian.Files;

/// <summary>The files the UI may ask <c>file.saveAs</c> to overwrite without a dialog: every path a native open or save dialog
/// returned this session, and the file paths of the tabs in the session file as it was when the app started. Paths are compared
/// after <see cref="Path.GetFullPath(string)"/>, ignoring case on Windows and macOS. Seeding starts when this is created, before the
/// UI can send anything, and a later <c>session.save</c> from the UI doesn't add to the set.</summary>
public sealed class AllowedFilePaths
{
    private readonly ConcurrentDictionary<string, bool> _paths;
    private readonly Task _seeded;

    public AllowedFilePaths(SessionService? sessions = null)
    {
        _paths = new ConcurrentDictionary<string, bool>(
            OperatingSystem.IsWindows() || OperatingSystem.IsMacOS() ? StringComparer.OrdinalIgnoreCase : StringComparer.Ordinal);
        _seeded = sessions is null ? Task.CompletedTask : SeedAsync(sessions);
    }

    public void Add(string path) => _paths[Path.GetFullPath(path)] = true;

    public async Task<bool> ContainsAsync(string path)
    {
        await _seeded;
        try
        {
            return _paths.ContainsKey(Path.GetFullPath(path));
        }
        catch (ArgumentException)
        {
            return false;
        }
    }

    private async Task SeedAsync(SessionService sessions)
    {
        try
        {
            var read = await sessions.GetAsync();
            foreach (var path in read.Value.Tabs.Select(t => t.FilePath).Where(p => !string.IsNullOrEmpty(p)))
            {
                try
                {
                    Add(path!);
                }
                catch (ArgumentException)
                {
                    // A path that can't be normalised can't be matched either.
                }
            }
        }
        catch (IOException)
        {
            // An unreadable session file seeds nothing: those files go through a dialog.
        }
    }
}
