# Kustodian

[![ci](https://github.com/FrodeHus/kustodian/actions/workflows/ci.yml/badge.svg)](https://github.com/FrodeHus/kustodian/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Kustodian is a cross-platform desktop app (Windows, macOS, Linux) for writing and running KQL against three Microsoft sources,
for the tenant you're signed in to:

- **Microsoft Graph (beta)**: Graph data is fetched and queried with KQL by an embedded engine, so you can answer questions such as
  "applications with expired credentials" in one query.
- **Defender advanced hunting**, through Graph's `security/runHuntingQuery`.
- **Azure Resource Graph**, through Azure Resource Manager.

## Features

- One tab per query, each with its own source, editor, parameters and results. Open tabs and unsaved text survive a restart.
- KQL completion and errors from the source's schema, including nested and `mv-expand`ed fields.
- `{name}` parameters, built-in and personal snippets, saved queries and run history.
- Results as a virtualized grid, chart, JSON or diagnostics; compare two runs; export to CSV, JSON or Markdown.
- Explain shows the Graph requests a query would send, without sending them.
- A raw Graph request tab, like Graph Explorer, whose JSON responses can be opened as KQL tabs.
- Light and dark themes, a command palette, and keyboard shortcuts for every action.

## Signing in

By default Kustodian signs in with the Azure CLI's public client ID, with delegated permissions. You can use your own app
registration instead (a public client with `http://localhost` as a mobile/desktop redirect URI), or let Kustodian create one
for you with **Create Entra ID application**.

Tokens are cached in the OS keychain: DPAPI on Windows, Keychain on macOS, libsecret on Linux. They are never written in plain
text; without libsecret you sign in each time the app starts.

## Where data lives

Settings, saved queries, snippets, history and open tabs are JSON files in:

| Platform | Folder |
| --- | --- |
| Windows | `%APPDATA%\Kustodian` |
| macOS | `~/Library/Application Support/Kustodian` |
| Linux | `$XDG_CONFIG_HOME/kustodian`, else `~/.config/kustodian` |

Nothing is sent anywhere except to Microsoft's APIs.

## Building from source

Requirements:

- [.NET SDK](https://dotnet.microsoft.com/download) 10 (see [global.json](global.json))
- [Node.js](https://nodejs.org/) 22 and npm, for the web UI
- Linux only: WebKitGTK 4.1 and libsecret (`sudo apt-get install libwebkit2gtk-4.1-dev libsecret-1-dev` on Debian/Ubuntu)

```sh
dotnet build -warnaserror
dotnet test
dotnet run --project src/Kustodian
```

The host build runs `npm ci` and `npm run build` in `web/` when the web UI is missing or out of date, and embeds it.

For the web UI on its own:

```sh
cd web
npm ci
npm run lint && npm run typecheck && npm test
```

## Repository layout

| Path | What |
| --- | --- |
| `src/Kustodian` | The desktop host: window, message channel, sign-in, storage, settings |
| `src/Kustodian.Graph` | Graph schema, query planner, `$filter` translation, readers and cache |
| `src/Kustodian.Engine` | The KQL engine worker (KustoLoco) |
| `src/Kustodian.Sources` | Defender hunting and Azure Resource Graph clients |
| `web/` | The React UI (Vite, TypeScript, Vitest) |
| `tools/schema` | Regenerates the embedded Graph schema ([README](tools/schema/README.md)) |
| `tests/` | xUnit tests per project |
| `docs/` | Design specs, plans, mockups and manual checks ([index](docs/README.md)) |

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md), and report security issues as described in
[SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
