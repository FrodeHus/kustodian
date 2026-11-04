# External tools

The Rows tab's **Run tool** menu runs a command of your own on the selected rows, or on every row the filter shows when none
are selected. **Edit tools…** opens `tools.json` in Kustodian's data folder (see [install.md](install.md)), and writes an
example there first if there is no file.

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

Before an `each` tool runs, its dialog maps a result column to each parameter, the way a custom detection rule maps entities.
A column with the parameter's name (ignoring case) is chosen to start with; the menu shows "map …" after a tool with a
parameter no column matches, and it can't run until every parameter has a column.

Before anything runs, Kustodian also shows the command line for the first row and how many rows it will run on. Afterwards
it shows each command line with its output (the first 64K characters of stdout and of stderr) and any exit code that isn't 0.
Stop, or closing the dialog, ends a run still going.

The command starts directly, never through a shell, so a row value is always exactly one argument and nothing in it runs.
For the same reason a Windows `.bat` or `.cmd` file can't take row values (Windows would run it through `cmd.exe`); use batch
mode for those. Give `command` as a full path: an app started from the Finder or the Start menu doesn't get your shell's
`PATH`. Commands run in your home folder.
