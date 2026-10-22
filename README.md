# Kustodian

[![ci](https://github.com/FrodeHus/kustodian/actions/workflows/ci.yml/badge.svg)](https://github.com/FrodeHus/kustodian/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A desktop KQL workbench for your Microsoft tenant. Write one query language against **Microsoft Graph**, **Defender advanced
hunting** and **Azure Resource Graph**, with completion, parameters and results side by side. Runs on Windows, macOS and Linux.

![Kustodian querying Microsoft Graph with KQL](docs/images/main.png)

## Why

Graph has no query language: answering "which apps have expired credentials?" means paging, `$filter` quirks and per-object
calls. Kustodian fetches Graph data and runs real KQL over it locally, and shows exactly which requests it will send before
it sends them. Hunting and Resource Graph queries go straight to their services, in the same editor.

## Features

- **Three sources, one editor**: Graph (beta), Defender hunting via `security/runHuntingQuery`, and Azure Resource Graph.
- **Schema-aware KQL**: completion and errors from each source's schema, including nested and `mv-expand`ed fields.
- **Explain**: see the Graph requests, `$filter` and permissions a query needs, without sending anything.
- **Results**: virtualized grid, charts, JSON and diagnostics; compare two runs; export to CSV, JSON or Markdown.
- **Workflow**: tabs that survive restarts, `{name}` parameters, snippets, saved queries, history and a command palette.
- **Raw Graph requests**, like Graph Explorer, with responses you can open as KQL tabs.
- Light and dark themes, and keyboard shortcuts for every action.

<table>
  <tr>
    <td><img src="docs/images/hunting.png" alt="Defender advanced hunting"><br><sub>Defender advanced hunting</sub></td>
    <td><img src="docs/images/resource-graph.png" alt="Azure Resource Graph"><br><sub>Azure Resource Graph, scoped to subscriptions</sub></td>
  </tr>
  <tr>
    <td><img src="docs/images/explain.png" alt="Explain"><br><sub>Explain: the requests a query would send</sub></td>
    <td><img src="docs/images/light.png" alt="Charts and compare runs in the light theme"><br><sub>Charts and compare runs, light theme</sub></td>
  </tr>
</table>

<sub>Screenshots are rendered from the [design mockups](docs/design/mockups) and use sample data.</sub>

## Install

Download the package for your platform from the [latest release](https://github.com/FrodeHus/kustodian/releases/latest).
The builds are self-contained, so there is no .NET to install.

| Platform | Download |
| --- | --- |
| Windows 11 (x64, Arm) | `Kustodian-<version>-x64.msi` or `-arm64.msi` (recommended), or the portable `-win-x64.zip` / `-win-arm64.zip` |
| macOS 14 or later | `Kustodian-<version>-osx-arm64.dmg` (Apple silicon) or `-osx-x64.dmg` (Intel); the same app is in the `.zip` |
| Linux x64 | `Kustodian-<version>-x86_64.AppImage` or `-linux-x64.tar.gz`, with WebKitGTK 4.1, libsecret and libnotify |

The macOS app isn't notarized, so its first open needs one extra step, and so does an unsigned Windows build. The
[install guide](docs/install.md) covers each platform, where your data lives and how to verify a download.

## Getting started

Open Kustodian and sign in with your work account. By default Kustodian uses the Azure CLI's public client ID with delegated
permissions, which covers common Graph and Azure Resource Graph queries but not everything: security data, audit logs and
advanced hunting often need permissions it doesn't have. For those, use your own Entra ID app registration with the permissions your queries need,
or let Kustodian create one with **Create Entra ID application**. [Entra ID permissions](docs/EntraPermissions.md) explains
both, step by step.

Some Graph tables and columns also need a license (such as Entra ID P1 for `signInActivity`) or a permission beyond the
table's own. Kustodian checks the tenant's licenses and leaves out what it can't read instead of failing the query:
[Licenses and permissions per column](docs/LicensesAndPermissions.md) explains how.

## Privacy and security

Kustodian talks only to Microsoft's APIs. Tokens are cached in the OS keychain (DPAPI, Keychain or libsecret) and never
written in plain text. Settings, saved queries, snippets, history and open tabs are local JSON files in `%APPDATA%\Kustodian`,
`~/Library/Application Support/Kustodian` or `~/.config/kustodian`.

Report vulnerabilities as described in [SECURITY.md](SECURITY.md).

## Building from source

Requirements: [.NET SDK 10](https://dotnet.microsoft.com/download) (see [global.json](global.json)),
[Node.js 22](https://nodejs.org/), and on Linux WebKitGTK 4.1 and libsecret
(`sudo apt-get install libwebkit2gtk-4.1-dev libsecret-1-dev`).

```sh
dotnet build -warnaserror
dotnet test
dotnet run --project src/Kustodian
```

The build runs `npm ci` and `npm run build` in `web/` when the UI is out of date, and embeds it. For the UI alone:
`cd web && npm ci && npm run lint && npm run typecheck && npm test`.

To build the release packages for one runtime identifier (`win-x64`, `win-arm64`, `osx-arm64`, `osx-x64` or `linux-x64`)
into `artifacts/`, run `tools/release/package.sh <rid>`; the Windows MSIs come from `tools/release/windows/build.ps1`. See
[Building from source](docs/install.md#building-from-source) in the install guide.

| Path | What |
| --- | --- |
| `src/Kustodian` | Desktop host: window, message channel, sign-in, storage |
| `src/Kustodian.Graph` | Graph schema, query planner, `$filter` translation, readers and cache |
| `src/Kustodian.Engine` | KQL engine worker (KustoLoco) |
| `src/Kustodian.Sources` | Defender hunting and Azure Resource Graph clients |
| `web/` | React UI (Vite, TypeScript, Vitest) |
| `docs/` | Design specs, plans, mockups and manual checks ([index](docs/README.md)) |

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md); changes are
recorded in the [CHANGELOG](CHANGELOG.md).

## License

[MIT](LICENSE)
