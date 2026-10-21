using System.Collections.Concurrent;
using Kustodian.Sessions;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

namespace Kustodian.Files;

/// <summary>The files the UI may ask <c>file.saveAs</c> to overwrite without a dialog: every path a native open or save dialog
/// returned this session, and the file paths of the tabs in the session file as it was when the app started. Paths are compared
/// after <see cref="Path.GetFullPath(string)"/>, case-sensitively everywhere (on a case-insensitive volume that costs an extra dialog; the other way round it would let one file
/// cover another). Seeding starts when this is created, before the
/// UI can send anything, and a later <c>session.save</c> from the UI doesn't add to the set. If the seed read fails for any
/// reason a warning is logged and nothing is seeded, so those files go through a dialog.</summary>
public sealed class AllowedFilePaths
{
    private readonly ConcurrentDictionary<string, bool> _paths;
    private readonly Task _seeded;
    private readonly ILogger _log;

    public AllowedFilePaths(SessionService? sessions = null, ILogger<AllowedFilePaths>? logger = null)
    {
        _log = logger ?? NullLogger<AllowedFilePaths>.Instance;
        _paths = new ConcurrentDictionary<string, bool>(StringComparer.Ordinal);
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
        catch (Exception ex)
        {
            _log.LogWarning(ex, "The saved session couldn't be read, so no tab's file is trusted for Save");
            _paths.Clear();
        }
    }
}
