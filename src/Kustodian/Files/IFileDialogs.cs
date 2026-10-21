namespace Kustodian.Files;

/// <summary>One entry in a file dialog's type list: a name and the extensions it shows, with or without a leading dot.</summary>
public sealed record FileFilter(string Name, IReadOnlyList<string> Extensions);

/// <summary>The operating system's file dialogs. Each answers the chosen path, or null when the dialog was cancelled.</summary>
public interface IFileDialogs
{
    Task<string?> OpenAsync(string title, IReadOnlyList<FileFilter> filters);

    Task<string?> SaveAsync(string title, string suggestedName, IReadOnlyList<FileFilter> filters);
}
