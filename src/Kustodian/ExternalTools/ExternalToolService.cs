using System.ComponentModel;
using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Kustodian.Storage;

namespace Kustodian.ExternalTools;

/// <summary>A command the user set up to run on result rows. <see cref="Mode"/> <c>each</c> runs it once per row, with each
/// <c>{column}</c> in <see cref="Args"/> replaced by that row's value; <c>batch</c> runs it once and sends the rows on stdin as
/// a JSON array of objects.</summary>
public sealed record ExternalTool(string Name, string Command, IReadOnlyList<string> Args, string Mode);

/// <summary>The user's tools, or none and the <see cref="Problem"/> with <c>tools.json</c> when it can't be used.</summary>
public sealed record ToolList(IReadOnlyList<ExternalTool> Tools, string? Problem, string Path);

/// <summary>One run of the command: the arguments it got, its exit code and what it wrote.</summary>
public sealed record ToolOutcome(IReadOnlyList<string> Args, int ExitCode, string Output, string Error);

/// <summary>A run that was refused or couldn't start; the message says why, as the user is told it.</summary>
public sealed class ToolRejectedException(string message) : Exception(message);

/// <summary>
/// The user's external tools, kept by hand in <c>tools.json</c> under the app's root. The file is read on every list and run, so
/// what runs is always what the file says, never what the UI sent. A file that isn't valid is reported and left as it is: the
/// user wrote it. Commands start directly with an argument list, never through a shell, so a row value is always one argument
/// and nothing in it is run.
/// </summary>
public sealed partial class ExternalToolService(string root, Action<string>? openInEditor = null)
{
    public const string FileName = "tools.json";
    public const string Each = "each";
    public const string Batch = "batch";
    public const int MaxOutputChars = 64 * 1024;

    private readonly Action<string> _openInEditor = openInEditor ?? OpenInEditor;

    public string Path { get; } = System.IO.Path.Combine(root, FileName);

    private sealed record ToolsFile(int Version, IReadOnlyList<ExternalTool> Tools);

    [GeneratedRegex(@"\{([^{}]+)\}")]
    private static partial Regex Placeholder();

    public async Task<ToolList> ListAsync(CancellationToken ct = default)
    {
        if (!File.Exists(Path))
        {
            return new ToolList([], null, Path);
        }

        try
        {
            var file = JsonSerializer.Deserialize<ToolsFile>(await File.ReadAllTextAsync(Path, ct), JsonFileStore.Options);
            var problem = file is null ? "tools.json is empty." : Problem(file.Tools);
            return problem is null ? new ToolList(file!.Tools, null, Path) : new ToolList([], problem, Path);
        }
        catch (JsonException ex)
        {
            return new ToolList([], $"tools.json isn't valid: {ex.Message}", Path);
        }
    }

    /// <summary>Opens <c>tools.json</c> in a text editor, first writing an example when there is no file.</summary>
    public async Task EditAsync(CancellationToken ct = default)
    {
        if (!File.Exists(Path))
        {
            Directory.CreateDirectory(System.IO.Path.GetDirectoryName(Path)!);
            await File.WriteAllTextAsync(Path, JsonSerializer.Serialize(new ToolsFile(1, [Example()]), JsonFileStore.Options), ct);
        }

        try
        {
            _openInEditor(Path);
        }
        catch (Exception ex) when (ex is Win32Exception or InvalidOperationException)
        {
            throw new ToolRejectedException($"Kustodian couldn't open {Path}. Open it in an editor yourself.");
        }
    }

    /// <summary>Runs the tool named <paramref name="name"/> on <paramref name="rows"/> (each a value per column of
    /// <paramref name="columns"/>), one row at a time in <c>each</c> mode, reporting how many are done after each. Each
    /// <c>{parameter}</c> takes the column <paramref name="mapping"/> names for it, or the column of the same name. Throws
    /// <see cref="ToolRejectedException"/> when the tool can't run, before anything starts.</summary>
    public async Task<IReadOnlyList<ToolOutcome>> RunAsync(string name, IReadOnlyList<string> columns, IReadOnlyList<JsonElement[]> rows,
        IReadOnlyDictionary<string, string>? mapping = null, Action<int>? done = null, CancellationToken ct = default)
    {
        var list = await ListAsync(ct);
        if (list.Problem is { } problem)
        {
            throw new ToolRejectedException(problem);
        }

        var tool = list.Tools.FirstOrDefault(t => t.Name == name) ?? throw new ToolRejectedException($"There is no tool named {name}.");
        if (tool.Mode == Batch)
        {
            return [await RunOnceAsync(tool.Command, tool.Args, StdinJson(columns, rows), ct)];
        }

        var at = new Dictionary<string, int>(StringComparer.Ordinal);
        foreach (var parameter in tool.Args.SelectMany(a => Placeholder().Matches(a)).Select(m => m.Groups[1].Value).Distinct())
        {
            var column = mapping is not null && mapping.TryGetValue(parameter, out var mapped) ? mapped : parameter;
            at[parameter] = IndexOf(columns, column);
            if (at[parameter] < 0)
            {
                throw new ToolRejectedException($"{tool.Name} needs a column for {parameter}, and the result has no column {column}.");
            }
        }

        // shortcut: rows run one at a time; run a few at once if long lists of slow commands get common.
        var outcomes = new List<ToolOutcome>(rows.Count);
        foreach (var row in rows)
        {
            var args = tool.Args.Select(a => Placeholder().Replace(a, m => CellText(row[at[m.Groups[1].Value]]))).ToList();
            outcomes.Add(await RunOnceAsync(tool.Command, args, null, ct));
            done?.Invoke(outcomes.Count);
        }

        return outcomes;
    }

    private static int IndexOf(IReadOnlyList<string> columns, string column)
    {
        for (var i = 0; i < columns.Count; i++)
        {
            if (columns[i] == column)
            {
                return i;
            }
        }

        return -1;
    }

    /// <summary>A cell as the grid copies it: empty for null, dynamic values as JSON, anything else as itself.</summary>
    public static string CellText(JsonElement value) => value.ValueKind switch
    {
        JsonValueKind.String => value.GetString()!,
        JsonValueKind.Null or JsonValueKind.Undefined => "",
        _ => value.GetRawText(),
    };

    /// <summary>What is wrong with the tools, or null when nothing is. Parts missing from the JSON arrive as null.</summary>
    public static string? Problem(IReadOnlyList<ExternalTool>? tools)
    {
        if (tools is null)
        {
            return "tools.json needs a tools list.";
        }

        var names = new HashSet<string>(StringComparer.Ordinal);
        foreach (var tool in tools)
        {
            if (tool is null || string.IsNullOrWhiteSpace(tool.Name))
            {
                return "Every tool needs a name.";
            }

            if (!names.Add(tool.Name))
            {
                return $"There are two tools named {tool.Name}.";
            }

            if (string.IsNullOrWhiteSpace(tool.Command))
            {
                return $"{tool.Name} needs a command.";
            }

            if (tool.Args is null || tool.Args.Any(a => a is null))
            {
                return $"{tool.Name} has an argument that isn't text.";
            }

            if (tool.Mode is not (Each or Batch))
            {
                return $"{tool.Name} needs a mode of \"each\" or \"batch\".";
            }

            var placeholders = tool.Args.Any(a => Placeholder().IsMatch(a));
            if (placeholders && tool.Mode == Batch)
            {
                return $"{tool.Name} runs in batch mode, which sends the rows on stdin, so its arguments can't name columns.";
            }

            // Windows runs a batch file through cmd.exe, which would read characters in a row value as commands.
            if (placeholders && OperatingSystem.IsWindows()
                && System.IO.Path.GetExtension(tool.Command).ToLowerInvariant() is ".bat" or ".cmd")
            {
                return $"{tool.Name} is a batch file, which can't take row values as arguments safely. Use batch mode instead.";
            }
        }

        return null;
    }

    private static string StdinJson(IReadOnlyList<string> columns, IReadOnlyList<JsonElement[]> rows)
    {
        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream))
        {
            writer.WriteStartArray();
            foreach (var row in rows)
            {
                writer.WriteStartObject();
                for (var i = 0; i < columns.Count; i++)
                {
                    writer.WritePropertyName(columns[i]);
                    row[i].WriteTo(writer);
                }

                writer.WriteEndObject();
            }

            writer.WriteEndArray();
        }

        return Encoding.UTF8.GetString(stream.ToArray()) + "\n";
    }

    private static async Task<ToolOutcome> RunOnceAsync(string command, IReadOnlyList<string> args, string? stdin, CancellationToken ct)
    {
        var utf8 = new UTF8Encoding(false);
        var info = new ProcessStartInfo(command)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardInputEncoding = utf8,
            StandardOutputEncoding = utf8,
            StandardErrorEncoding = utf8,
            // An app started from the Finder or the Start menu has no useful working directory of its own.
            WorkingDirectory = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
        };
        foreach (var arg in args)
        {
            info.ArgumentList.Add(arg);
        }

        using var process = new Process { StartInfo = info };
        try
        {
            process.Start();
        }
        catch (Win32Exception ex)
        {
            throw new ToolRejectedException($"Kustodian couldn't start {command}: {ex.Message}");
        }

        var output = ReadCappedAsync(process.StandardOutput);
        var error = ReadCappedAsync(process.StandardError);
        try
        {
            try
            {
                if (stdin is not null)
                {
                    await process.StandardInput.WriteAsync(stdin.AsMemory(), ct);
                }

                process.StandardInput.Close();
            }
            catch (IOException)
            {
                // The command ended, or closed stdin, without reading it all.
            }

            await process.WaitForExitAsync(ct);
        }
        catch (OperationCanceledException)
        {
            try
            {
                process.Kill(entireProcessTree: true);
            }
            catch (InvalidOperationException)
            {
                // It ended first.
            }

            throw;
        }

        return new ToolOutcome(args, process.ExitCode, await output, await error);
    }

    /// <summary>Reads the stream to its end, so the command never blocks on a full pipe, keeping the first
    /// <see cref="MaxOutputChars"/>.</summary>
    private static async Task<string> ReadCappedAsync(StreamReader reader)
    {
        var text = new StringBuilder();
        var buffer = new char[4096];
        var cut = false;
        int read;
        while ((read = await reader.ReadAsync(buffer)) > 0)
        {
            var room = MaxOutputChars - text.Length;
            cut |= read > room;
            text.Append(buffer, 0, Math.Clamp(read, 0, Math.Max(room, 0)));
        }

        return cut ? text.Append("\n[cut at 64K characters]").ToString() : text.ToString();
    }

    private static ExternalTool Example() => OperatingSystem.IsWindows()
        ? new ExternalTool("Show the rows", @"C:\Windows\System32\findstr.exe", [".*"], Batch)
        : new ExternalTool("Echo the id", "/bin/echo", ["{id}"], Each);

    private static void OpenInEditor(string path)
    {
        var info = new ProcessStartInfo { UseShellExecute = false };
        if (OperatingSystem.IsWindows())
        {
            info.FileName = "notepad.exe";
        }
        else if (OperatingSystem.IsMacOS())
        {
            info.FileName = "open";
            info.ArgumentList.Add("-t");
        }
        else
        {
            info.FileName = "xdg-open";
        }

        info.ArgumentList.Add(path);
        using var process = Process.Start(info);
    }
}
