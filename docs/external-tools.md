# External tools

The Rows tab's **Run tool** menu runs a command of your own on the selected rows, or on every row the filter shows when none
are selected. The tools are set up in **Settings › External tools**: add, edit, duplicate, reorder and delete them there, one
box per argument; each change is saved to `tools.json` in Kustodian's data folder (see [install.md](install.md)) at once. A
tool whose command is no file gets a warning there. While `tools.json` can't be read, Settings shows why and changes nothing.
**Edit tools…** in the menu, and **Open tools.json** in Settings, open the file in a text editor instead, writing an example
there first if there is no file. Saving from Settings rewrites the file, so its own layout isn't kept.

```json
{
  "version": 1,
  "tools": [
    {
      "name": "Revoke sessions",
      "command": "/opt/homebrew/bin/az",
      "args": ["rest", "--method", "post", "--url", "https://graph.microsoft.com/v1.0/users/{id}/revokeSignInSessions"],
      "mode": "each"
    },
    { "name": "Save as JSON lines", "command": "/opt/homebrew/bin/jq", "args": ["-c", ".[]"], "mode": "batch" }
  ]
}
```

- `each` runs the command once per row, one row at a time. Each `{parameter}` in `args` becomes that row's value in the
  column mapped to it: text as it is, null as nothing, and dynamic values as JSON.
- `batch` runs it once and writes the rows to its stdin as a JSON array of objects. Its `args` can't have parameters.

Before an `each` tool runs, its dialog maps a result column to each parameter, the way a custom detection rule maps entities,
or takes **A value I type** for it: text you fill in there, the same for every row. A column with the parameter's name
(ignoring case) is chosen to start with, else a value to type; the menu shows "map …" after a tool with a parameter no column
matches, and it can't run until every parameter has a column or a value that isn't empty. A tool with
`"args": [..., "{id}", "--company", "{company}"]`, say, sets the company you type on every selected user.

Before anything runs, Kustodian also shows the command line for the first row and how many rows it will run on. Afterwards
it shows each command line with its output (the first 64K characters of stdout and of stderr) and any exit code that isn't 0.
Stop, or closing the dialog, ends a run still going.

The command starts directly, never through a shell, so a row value is always exactly one argument and nothing in it runs.
For the same reason a Windows `.bat` or `.cmd` file can't take row values (Windows would run it through `cmd.exe`); use batch
mode for those. Give `command` as a full path: an app started from the Finder or the Start menu doesn't get your shell's
`PATH`. Commands run in your home folder.

Table widgets in a [workbook](workbooks.md#selection-and-tool-buttons) can have tool buttons. A button names a tool here and
never copies its command, so the workbook holds only the tool's name and a column mapping, and changing the tool here
changes what the button runs. A workbook from someone else needs a tool of the same name in your own `tools.json`.
