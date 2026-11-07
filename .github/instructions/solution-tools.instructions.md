---
applyTo: "Solutions/**/tools.json"
---

# Reviewing community solution tools

Each entry in `tools.json` runs a local command on a user's machine. Flag every entry that matches any of these, and quote
the tool `name` and the offending `command` or argument for each finding:

- A shell interpreter as `command`: `bash`, `sh`, `zsh`, `pwsh`, `powershell`, `cmd`.
- A download or install command: `curl`, `wget`, `Invoke-WebRequest`, or a package manager (`npm`, `pip`, `brew`, `winget`,
  `apt`, `choco`, and similar).
- A write or delete API call: `--method post|put|patch|delete`, or `az ... delete|stop|create`.
- A `{param}` placeholder inside a URL or inside script text, rather than as its own argument.
- A `batch` tool whose command sends stdin to a network target.

If nothing matches, say so explicitly.
