# Changelog

All notable changes are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions
follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Graph collections one single-valued step below a singleton are now tables, such as
  `reports_authenticationMethods_userRegistrationDetails` (MFA and passkey/FIDO2 registration per user),
  `roleManagement_directory_roleAssignments` and `identity_conditionalAccess_policies`: 319 more tables. Paths through a `me`
  segment (`education/me/...`) stay out, like `me` itself. The schema is regenerated from the latest beta metadata.

## [0.9.8] - 2026-10-23

### Added

- An inspect button on every row of the results opens the row in the row details sheet; another row's button switches the
  sheet to that row, and the open row's button closes it. Dynamic values show as a tree to open and close, with Expand all.

### Fixed

- A Graph query with a dynamic value on the left of `in`, `!in`, `in~`, `!in~` or `has_any` says to convert it with
  `tostring()` instead of showing an internal cast error.
- Graph `directoryRoles` and each role's `members` no longer fail: Graph refuses any page size there, and the read now retries
  without `$top`.

## [0.9.7] - 2026-10-22

### Added

- The macOS app and dmgs are signed with a Developer ID and notarized, so they open without a Gatekeeper prompt and macOS no
  longer asks about the keychain item after an update.

## [0.9.6] - 2026-10-22

### Added

- A Save button in the query toolbar. Once the tab is saved to the library or a file, its ▾ menu has Save as.

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
