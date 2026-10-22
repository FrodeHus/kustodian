# Changelog

All notable changes are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions
follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Save and Save as buttons in the query toolbar. Save as shows once the tab is saved to the library or a file.

## [0.9.5] - 2026-10-22

### Added

- Relationship columns on Graph tables: a user's groups (`memberOf`), manager, direct reports, owned objects and devices; a
  group's members and owners; owners of applications and service principals; a device's registered owners and users. Read
  one object at a time when a query names them, for at most 100 objects per relationship and 1,000 entries per object.
- Notices for relationship reads that were cut off, refused, returned without details, capped, or filtered locally, and the
  relationship requests and permissions in Explain.
- Directory relationship snippets: a user's groups, a group's members and an application's owners.

## [0.9.0] - 2026-10-22

### Added

- KQL over Microsoft Graph (beta), Defender advanced hunting and Azure Resource Graph in one desktop app.
- Tabs, parameters, snippets, saved queries and history; grid, chart, JSON and diagnostics results; Explain and raw requests.
- Sign-in with the Azure CLI client or your own app registration, and Create Entra ID application.
- License-aware Graph tables and columns, and the tenant's licenses (with Refresh) in the account view.
- The Kustodian logo in the title bar, as the window and executable icon, and on the product website.
- Release builds for Windows (MSI and portable zip, x64 and Arm), macOS (dmg and zip, Apple Silicon and Intel) and Linux
  (tarball and AppImage), with SHA-256 checksums and an install guide.
- Create Entra ID application from Settings → Sign-in.
- `--version`, and a clear message on Linux when WebKitGTK, libsecret or libnotify is missing.
