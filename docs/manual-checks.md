# Manual checks

The spec 13 checklist, run on all three platforms against a real tenant before v1. Plan 1 fills in only what could be verified
without signing in. Rows marked "owner" need a live sign-in and are left for the owner; nothing here was signed in by the
builder.

Legend: `ok` verified, `-` not run, `owner` needs a live tenant sign-in, `n/a` not applicable.

## Automated gate (Plan 1, 2026-10-21)

| Check | macOS | Windows | Linux |
| --- | --- | --- | --- |
| `npm ci`, lint, typecheck, test, build in `web/` | ok (40 web tests) | - (no Node in the VM; the web build was made on macOS and embedded) | ok (Ubuntu 24.04 arm64 container, Node 22) |
| `dotnet build -warnaserror`, 0 warnings | ok | ok | ok |
| `dotnet test` | ok, 445 passed (466 after the Windows origin and DPI fixes) | ok, 442 passed, 3 skipped (after the origin fix: 457, 454 passed, 3 skipped) | ok, 445 passed, before the origin and DPI fixes; not re-run |

Known open warnings, not failures: oxlint `react(incompatible-library)` for TanStack Table, Vite chunk-size.

## Launch

| Check | macOS | Windows | Linux |
| --- | --- | --- | --- |
| Window opens and the web UI renders from its origin (`app://localhost`; `https://kustodian.invalid` on Windows) | ok (main window with an account already in the token cache; schema panel listed 438 tables, 436 on the re-check after the fix) | ok after the fix (sign-in screen: "Sign in to Microsoft Graph", "Not signed in"; see notes) | - (headless container, no display) |
| Window opens at 1440x900 logical, never larger than the work area | ok (1440x900 points) | ok at 300 %: capped at the 4112x2436 work area, page about 1370x810 CSS px, no scrollbars (see notes) | - |
| No `--engine` process left after closing the window (idle) | ok (quit the way the Dock's Quit does: a quit Apple Event through `NSRunningApplication.terminate`; before, the app and its `--engine` child were running; 5 s after, `ps` showed neither) | - (the app was force-killed after the check, not closed) | - |

## Spec 13 checklist

| Check | macOS | Windows | Linux |
| --- | --- | --- | --- |
| Sign in with the Azure CLI client | owner | owner | owner |
| Sign in with your own client | owner | owner | owner |
| Expired-or-passthru Graph query (`applications` with expired `passwordCredentials`) | owner | owner | owner |
| Add `onPremisesPublishing`: denied chip shows and rows still return | owner | owner | owner |
| Hunting query | owner | owner | owner |
| ARG query across two subscriptions | owner | owner | owner |
| Cancel during a long run | owner | owner | owner |
| Kill the engine by memory | owner | owner | owner |
| No orphaned `Kustodian --engine` after closing mid-run (`ps` / Task Manager) | owner | owner | owner |
| Restart with unsaved tabs | owner | owner | owner |
| Missing keychain on Linux | n/a | n/a | owner |
| monaco-kusto completion works in the web view (WKWebView / WebView2 / WebKitGTK; spec 14 risk 2) | owner (not run in the app: typing into the window needs Accessibility permission, which the builder doesn't have; the blank-label bug is fixed and checked in Chromium, see notes) | owner | owner |
| Fresh download opens past Gatekeeper / SmartScreen (README walkthrough) | owner | owner | owner |

## Plan 2 workbench (2026-10-21)

Run by the builder with no sign-in and no typing into any app window. Every app-level row stays "owner", with its reason in the
cell. The builder has no Accessibility permission on macOS, so synthetic keys and clicks cannot reach the window. On the Windows
VM the app has no account, so it stops at the sign-in screen, and the workbench (tabs, palette, Explain, file dialogs) is behind
that. This Mac's token cache holds the owner's account; the builder never pressed Run or Send. On Windows, one synthetic click
(`vm.sh click` on the settings gear) gave the gear a hover state but opened no panel while signed out.

### Automated gate

| Check | macOS | Windows | Linux |
| --- | --- | --- | --- |
| `npm ci`, lint, typecheck, test, build in `web/` | ok (240 web tests; lint shows only the known TanStack Table warning, now at `src/results/result-grid.tsx`; build only the Vite chunk-size note) | - (no Node in the VM) | ok (Ubuntu 24.04 arm64 container, Node 22.12.0: 240 tests, lint only the known warning, tsc clean, build only the chunk-size note) |
| `dotnet build Kustodian.slnx -warnaserror`, 0 warnings | ok | ok (run on the VM as `dotnet build Kustodian.slnx -warnaserror`, default Debug configuration) | ok (Ubuntu 24.04 container with `libwebkit2gtk-4.1-dev` and `libsecret-1-dev`) |
| `dotnet test --solution Kustodian.slnx` | ok, 885 passed | ok, 881 passed, 4 skipped | ok, 885 passed |
| Window opens and renders the UI from its origin | ok (launched from `kustodian/src/Kustodian/bin/Debug/net10.0/Kustodian`; the window rendered the workbench with the owner's cached account, 436 schema tables, Run and Explain in the toolbar, status bar "Dark"; captured with `screencapture -l`, see notes; nothing pressed) | ok (4112x2436 physical px; sign-in screen, "Not signed in", settings gear in the header; captured with `PrintWindow` on the Kustodian window only) | - (headless container) |

### Plan 2 features

Cell reasons: macOS "owner" = the builder cannot type or click in the window; Windows "owner" = no account on the VM, workbench
behind sign-in; Linux "owner" = headless container.

| Check | macOS | Windows | Linux |
| --- | --- | --- | --- |
| Restart with two unsaved tabs: both come back | owner | owner | owner |
| Theme: light | owner | owner | owner |
| Theme: dark | owner (status bar showed "Dark" in the launch screenshot; the setting was not switched) | owner (the sign-in screen rendered dark; only that screen was seen and the setting was not read) | owner |
| Theme: system follows the OS | owner | owner | owner |
| Palette opens with the platform shortcut (`⌘ K` on macOS, `Ctrl K` elsewhere) | owner | owner | owner |
| Save a query, restart, open it from Saved | owner | owner | owner |
| Recent panel lists runs and re-runs from Recent | owner | owner | owner |
| Clear recent | owner | owner | owner |
| Snippets: insert at cursor | owner | owner | owner |
| Snippets: open in a new tab | owner | owner | owner |
| Snippets: save your own | owner | owner | owner |
| Snippets: delete your own; a built-in snippet can't be deleted | owner | owner | owner |
| Run a `datatable` snippet (no Graph data); snippets that need a tenant stay owner | owner | owner | owner |
| Clear cache | owner | owner | owner |
| Explain a query (no Graph call) | owner (the Explain button is visible in the launch screenshot; not pressed) | owner | owner |
| Parameters form: placeholders found, typed values, a run with them | owner | owner | owner |
| Diagnostics: requests, status and sizes listed; no tokens or `Authorization` headers | owner | owner | owner |
| Raw request tab: send | owner | owner | owner |
| Raw request tab: next page | owner | owner | owner |
| Raw request tab: open the array as a KQL tab | owner | owner | owner |
| Results: chart | owner | owner | owner |
| Results: JSON tab | owner | owner | owner |
| Results: grid tools (sort, filter, columns) | owner | owner | owner |
| Results: row details | owner | owner | owner |
| Results: copy | owner | owner | owner |
| Results: export | owner | owner | owner |
| Results: compare | owner | owner | owner |
| Settings validation and the restart notice | owner | owner | owner |
| Native open dialog opens and returns a path | owner | owner | owner |
| Native save dialog opens and returns a path (no suggested name, a Photino limitation) | owner | owner | owner |
| Drag a `.kql` file from Finder or Explorer into the window: opens exactly one tab | owner | owner | owner |
| Close tab with the shortcut; closing a tab is a command on every platform. macOS: `⌘ W`, and Photino's menu may take it before the page sees it | owner | owner (`Ctrl W`; not checked, workbench behind sign-in) | owner (`Ctrl W`; not checked, headless) |
| Row, column, copy and export menus and the save dialog: a click on an item lands (WebKit doesn't focus buttons on mousedown) | owner (WKWebView) | owner (WebView2) | owner (WebKitGTK) |
| `crypto.randomUUID` works, or the `getRandomValues` fallback covers it; log `window.isSecureContext` in a dev build | owner (the `app://` origin may not be a secure context; not logged) | owner (`https://kustodian.invalid` is probably a secure context; not checked) | owner |
| monaco-kusto completion in the web view (owner-only since Plan 1) | owner (WKWebView; the launch screenshot happened to show a completion list for `ta` in a restored tab, but the builder typed nothing and doesn't know why the list was open) | owner (WebView2) | owner (WebKitGTK) |

## Plan 3 sources: hunting and Resource Graph (2026-10-21)

Run by the builder at commit 238ae752 with no sign-in, no typing and no clicks in any app window, and nothing pressed. Every row
that needs tenant data stays "owner". The macOS instance was a second copy built from the Plan 3 worktree, launched with `HOME`
pointed at an empty temporary folder so it never read or wrote the owner's user-data folder; the owner's own running Kustodian
was not touched. It still came up with an account in the title bar (see notes), so it showed the workbench, not sign-in. The
Windows VM has no account, so it stops at the sign-in screen and every workbench row there is behind it. Linux is a headless
container.

### Automated gate

| Check | macOS | Windows | Linux |
| --- | --- | --- | --- |
| `npm ci`, lint, typecheck, test, build in `web/` | ok (321 web tests; lint shows only the known TanStack Table warning; build only the chunk-size note) | - (no Node in the VM; `web/dist` was built on macOS and embedded) | ok (Ubuntu 24.04 arm64 container, Node 22.12.0: 321 tests, lint 1 warning (the known one), tsc clean, build only the chunk-size note) |
| `dotnet build Kustodian.slnx -warnaserror`, 0 warnings | ok (also with `--no-incremental`) | ok (Windows 11 ARM64 VM, .NET SDK 10.0.401, Debug) | ok (.NET SDK 10.0.402, with `libwebkit2gtk-4.1-dev` and `libsecret-1-dev`) |
| `dotnet test --solution Kustodian.slnx` | ok, 1110 passed | ok, 1106 passed, 4 skipped (1110 total) | ok, 1110 passed |
| Window opens and renders the UI from its origin | ok (1440x900 points; workbench with a Graph tab, 436 schema tables, Run, Run all, Cancel, Format and Explain; captured with `screencapture -l`, see notes) | ok (4112x2436 physical px at 300 %; sign-in screen, "Not signed in"; captured with `PrintWindow` on the Kustodian window only) | - (headless container) |
| Stopping the app (idle) leaves no Kustodian or `--engine` process | ok (SIGTERM to the builder's instance: it exited at once, status 143, unlike the Plan 2 check in the Backlog; no `--engine` left) | ok (`CloseMainWindow` on the builder's instance: no Kustodian process 5 s later) | - |

### Plan 3 features

Cell reasons: macOS "owner" = the builder cannot type or click in the window (no Accessibility permission) and never runs
against an account; Windows "owner" = no account on the VM, workbench behind sign-in; Linux "owner" = headless container.

| Check | macOS | Windows | Linux |
| --- | --- | --- | --- |
| Graph schema grouped by data area (Task 6b): 11 areas in order, "Other" last, closed by default with counts | ok (seen in the app without signing in: Users, groups and directory 37; Apps and permissions 14; Sign-in and audit logs 9; Risk and identity protection 8; Access reviews and privileged roles 24 (truncated with an ellipsis); Policies and Conditional Access 38; Devices and Intune 174; Security 44; Mail, Teams and files 53; Reports and usage 18; Other 17; total 436) | owner (behind sign-in: the workbench, and with it the schema panel, only shows once an account is active) | owner |
| Graph schema search keeps the grouping | owner | owner | owner |
| New tab per source (Graph, Defender hunting, Resource Graph) and the tab's source badge | owner | owner | owner |
| Change a tab's source; Explain closes and only shows on Graph tabs | owner | owner | owner |
| Hunting schema: tenant schema after sign-in (`getHuntingSchema`), bundled schema (66 tables, 4 functions) with its reason as fallback, refreshed by "Refresh schema" | owner | owner | owner |
| Resource Graph schema: bundled tables plus the account's resource types | owner | owner | owner |
| Editor completion and diagnostics per source (hunting functions with docstrings, ARG `properties` and `tags` dynamic) | owner | owner | owner |
| Hunting run | owner | owner | owner |
| Hunting timespan picker: 1, 7, 30 days, custom (30 days at most); default 30 days | owner | owner | owner |
| ARG run across two subscriptions | owner | owner | owner |
| ARG scope picker: subscriptions with search, a management group, "All I can see"; the trigger text | owner | owner | owner |
| Management groups: listed in the scope picker, the note when they can't be read, a run scoped to one | owner | owner | owner |
| ARG paging up to "ARG rows per run" (setting, 1,000–1,000,000) | owner | owner | owner |
| Throttling: hunting 429 and ARG 429 messages with when to retry | owner | owner | owner |
| Consent flow: an ARG tab's first run asks for consent, "Grant Azure access" opens the browser, the run reruns after it | owner | owner | owner |
| Consent as a different account shows its error on the tab | owner | owner | owner |
| Hunting 403 and ARG 403 messages | owner | owner | owner |
| Options saved with the query, in recent runs and in the session; reopening restores them | owner | owner | owner |
| "Pick timespan" and "Pick scope" commands in the palette, each enabled on its source's tabs | owner | owner | owner |
| Built-in snippets: "Threat hunting" (2) and "Azure posture" (3) groups insert and run | owner | owner | owner |
| Snippet wording as it reads in the app: "VMs without host encryption or a disk encryption set" says Azure Disk Encryption (the extension) is not detected and only the OS disk is checked. No snippet mentions Copilot; the only Copilot text is the `copilot/*` Graph tables, which sit under "Other" (`copilot/agentRegistrations` under "Apps and permissions") | owner | owner | owner |
| `invoke FileProfile()` on a hunting tab shows no squiggle | owner | owner | owner |
| Run log (Diagnostics) shows the full hunting and ARG URLs, statuses and sizes; no tokens | owner | owner | owner |

### Facts to check against a real tenant (owner)

Earlier reviews parked these: the fixtures follow Microsoft Learn, but no real response was recorded.

| Check | macOS | Windows | Linux |
| --- | --- | --- | --- |
| The real `runHuntingQuery` 400 body: does it carry a position, and in which form (the parser reads `line N` / `column M` style text) | owner | owner | owner |
| The real `getHuntingSchema` response shape (matches `Fixtures/hunting-schema-200.json`?) | owner | owner | owner |
| The real ARG 400 position fields: `line` and `characterPositionInLine`; is the second 0-based (the client assumes it is)? | owner | owner | owner |
| The ARG 429 body and the `x-ms-user-quota-resets-after` header format | owner | owner | owner |

## Create Entra ID application (2026-10-22)

Spec: `docs/design/specs/2026-10-22-create-entra-app-design.md` (section 10 lists the checks). The builder ran only the
automated gate below, with no sign-in and no tenant. Every feature row is the owner's to run, against a **test tenant** (never a
production tenant), because creating an app, adding an owner and granting admin consent change real directory objects.

### Automated gate

| Check | Result |
| --- | --- |
| `dotnet build -warnaserror` | ok, 0 warnings, 0 errors |
| `dotnet test` | ok, 1376 passed, 0 failed, 0 skipped |
| `npm --prefix web run lint` | ok, 1 warning, the known `react(incompatible-library)` on TanStack Table in `result-grid.tsx` |
| `npm --prefix web run typecheck` | ok, clean |
| `npm --prefix web test` | ok, 380 tests in 48 files |
| `npm --prefix web run build` | ok, only Vite's chunk-size note for the Monaco chunk (`kql-editor`, 3,647 kB) |

### Features (owner, test tenant)

| Check | Owner |
| --- | --- |
| Create the app as a non-admin user: the app is created and the signed-in user is added as its owner | owner |
| Create the app as an admin: the app is created and the owner is added | owner |
| A tenant with "Users can register applications" off: the refusal message is shown and nothing is created | owner |
| Admin consent from the system browser, then "Check again" shows the permissions as granted | owner |
| Switch to the new app and sign in with it | owner |
| A hunting query runs with the new app | owner |
| An ARG query runs with the new app | owner |
| The create button is hidden when the account uses an own client ID | owner |
| The create button is hidden for an expired account | owner |
| The create button is disabled, with the reason shown, when the token lacks `Application.ReadWrite.All` | owner |
| The "No permission" run-status button | owner |
| "Just show me the client ID" leaves the client ID note | owner |
| The copied admin-consent link opens Microsoft's consent page for the right tenant and app | owner |
| Force the service principal step to fail (for example, a user without the right to create it), grant admin consent, then click **Try again**: it succeeds | owner |
| As a guest, or a sign-in pinned to another tenant, "Open in Entra" opens the app in that tenant | owner |

## Plan 4: release builds (2026-10-22)

Run by the builder at commit cb5a01a with no sign-in and no tenant. Every row that needs one, or hardware the builder doesn't
have, stays "owner". The machines:

- **macOS arm64**: this Mac (Apple silicon). The osx-x64 build ran here under Rosetta; there is no Intel Mac.
- **Windows**: the Parallels Windows 11 VM, which is ARM64. The x64 MSI and zip ran there under x64 emulation (the process
  loaded `xtajit64se.dll`); no x64 PC was available.
- **Ubuntu and Fedora**: amd64 containers on this Mac (`ubuntu:24.04` and `fedora:latest`, Fedora 44), with no .NET and no
  keyring. The windows opened under Xvfb, with openbox as the window manager.

A "download" is a copy of the package that carries what a browser adds: on macOS the quarantine attribute
(`xattr -w com.apple.quarantine "0081;<hex time>;Safari;"`), and on Windows the Mark-of-the-Web (a `Zone.Identifier` stream
with `ZoneId=3`). On Linux it is a plain copy. Each was put in a folder with a space in its name ("Kustodian test").

Legend for this section: the Plan 1 legend, plus `no` (checked, and not met; see Findings).

### Automated gate and packages

| Check | macOS | Windows | Linux |
| --- | --- | --- | --- |
| `npm ci`, lint, typecheck, test, build in `web/` | ok (391 tests in 48 files; lint shows only the known TanStack Table warning; build only the chunk-size note) | - (no Node in the VM; `web/dist` was built on macOS and copied in) | ok (Ubuntu 24.04 amd64 container, Node 22.12.0: 391 tests, 1 lint warning (the known one), tsc clean) |
| `dotnet build Kustodian.slnx -warnaserror`, 0 warnings | ok | ok | ok |
| `dotnet test --solution Kustodian.slnx` | ok, 1452 passed | ok, 1448 passed, 4 skipped (1452 total) | ok, 1452 passed |
| Packages built | `package.sh osx-arm64` (smoke PASS), `osx-x64`, `win-x64`, `win-arm64`: both zips and dmgs, both Windows zips | `build.ps1 -Version 1.0.0` (Windows PowerShell 5.1): both MSIs and their `.sha256`, `--version` checked for both, `wix msi validate` clean | `package.sh linux-x64` in the SDK container: tarball and AppImage, smoke PASS, appimagetool and runtime checksums OK |

All 10 packages were then put in one folder and `checksums.sh` wrote one `SHA256SUMS.txt`, as the release does.

### Release rows

| Check | macOS arm64 | macOS x64 | Windows x64 | Windows arm64 | Ubuntu | Fedora |
| --- | --- | --- | --- | --- | --- | --- |
| The package downloads and its checksum matches `SHA256SUMS.txt` | ok (`shasum -a 256 -c --ignore-missing SHA256SUMS.txt`: both arm64 packages OK) | ok (same run: both x64 packages OK) | ok (MSI and zip: `Get-FileHash` matches `SHA256SUMS.txt` and the `.msi.sha256`) | ok (same, for the arm64 MSI and zip) | ok (`sha256sum -c --ignore-missing SHA256SUMS.txt`: tarball and AppImage OK) | ok (same) |
| The first open follows the install guide's unsigned-build steps exactly | owner for the blocked first open and **Open Anyway** (they need the app opened through Finder and clicks in System Settings). Checked without opening: the app copied out of the quarantined dmg, and the one unzipped with `ditto -x -k`, both carry the quarantine flag; `spctl --assess` says "rejected" and `syspolicy_check distribution` reports "Adhoc Signed App" and "Notary Ticket Missing". The guide's `xattr -dr com.apple.quarantine` removes it, and the app then runs. | owner (same as arm64; the guide's `xattr` step checked, then `--version` under Rosetta) | ok, zip with **Unblock**: `Unblock-File` on the downloaded zip (what the **Unblock** box does; the Properties dialog itself wasn't clicked), Explorer's extraction, `Kustodian.exe` opens with no prompt | ok, zip without **Unblock**: Explorer's extraction carries the Mark-of-the-Web onto `Kustodian.exe`; opening it from Explorer shows "Windows protected your PC", then **More info**, **Run anyway**, and the window opens. The MSI opened from Explorer shows the same SmartScreen page, then the installer. | ok (the guide's `apt install`, `tar -xzf`, `./Kustodian`) | owner: GNU tar 1.35 fails on every file under the Mac's amd64 emulation ("Cannot open: Function not implemented", no `openat2`); unpack with plain `tar -xzf` on native Fedora. The `dnf install` line and `./Kustodian` are ok (unpacked with Python's `tarfile`). |
| MSI per-user install | n/a | n/a | ok under emulation (silent `/qn`; installed into `%LOCALAPPDATA%\Programs\Kustodian`, opened, uninstalled); owner on x64 hardware | ok (installer UI: no UAC prompt, the license page, **Install**, "Launch Kustodian" ticked, **Finish** opens the app; Start menu shortcut present) | n/a | n/a |
| MSI per-machine install (`ALLUSERS=1`) | n/a | n/a | owner | owner through the real UAC prompt. Silent from an elevated session: ok (`C:\Program Files\Kustodian`, all-users shortcut, HKLM marker `PerMachine=1`, "Kustodian 1.0.0, Reothor" in Apps; the app opens from Program Files) | n/a | n/a |
| MSI per-user-over-per-machine guard | n/a | n/a | owner | ok (an interactive per-user 1.0.1 install over the per-machine 1.0.0 shows "Kustodian is installed for all users of this PC. To upgrade it, an administrator runs this installer with ALLUSERS=1 ..."; status 1603; only 1.0.0 remains) | n/a | n/a |
| MSI upgrade | n/a | n/a | owner | ok (a local `build.ps1 -Version 1.0.1 -Architectures arm64` installed over 1.0.0 per user: RemoveExistingProducts ran, exe version 1.0.1, one product left) | n/a | n/a |
| MSI uninstall leaves the user data | n/a | n/a | ok under emulation for the install folder (gone); the user data was not re-checked after this uninstall | ok (per user and per machine: install folder, shortcut and registry keys gone; `%APPDATA%\Kustodian\session.json` and `%LOCALAPPDATA%\Kustodian\Cache` stay) | n/a | n/a |
| The window opens with its icon | ok (1440x900 points; the running app is a regular app, so it has a Dock icon, and the icon it shows is the bundle's K; captured with `screencapture -l`) | owner (no Intel Mac; not opened under Rosetta) | ok under emulation (K icon in the title bar) | ok (K icon in the title bar, from the zip, the per-user MSI and Program Files) | ok under Xvfb and openbox (K icon in the frame; `_NET_WM_ICON` set), from the tarball and the AppImage | - (not opened; `--version` and the engine smoke only) |
| `--version` and the OS app info (Windows Apps list, macOS Get Info) show the version | ok (`--version` prints "Kustodian 1.0.0"; the bundle's `Info.plist` has `CFBundleShortVersionString` and `CFBundleVersion` 1.0.0, which Get Info shows) | ok (`--version` under Rosetta prints "Kustodian 1.0.0"; `Info.plist` 1.0.0, as arm64) | ok under emulation for `--version` ("Kustodian 1.0.0", from `build.ps1`); owner for the Apps list | ok (`--version` prints "Kustodian 1.0.0"; Apps lists "Kustodian 1.0.0, Reothor") | ok (`--version` prints "Kustodian 1.0.0", tarball and AppImage) | ok (`--version` prints "Kustodian 1.0.0") |
| Sign-in, and the keychain prompt (macOS) or libsecret (Linux) | owner | owner | owner | owner | owner (without a keyring the app says so; see the missing-keychain row) | owner |
| A Graph query runs | owner | owner | owner | owner | owner | owner |
| The engine worker starts from the single-file build | ok (`smoke.sh` on the app's executable: `print x=1` answered, the worker exits when stdin closes) | ok under Rosetta (same) | ok under emulation (`--engine` with redirected stdin/stdout, one framed request answered, exit 0 within 5 s of stdin closing) | ok (same) | ok (`smoke.sh` on the tarball's `Kustodian`) | ok (same) |
| No orphan process after quitting | ok idle (a quit Apple Event: no Kustodian process 6 s later); owner after a query | owner | ok idle (`CloseMainWindow`: no Kustodian process 5 s later); owner after a query | ok idle (same); owner after a query | ok idle (closed through the window manager with `wmctrl -c`: no Kustodian process, and for the AppImage no runtime process either); owner after a query | owner |
| The app runs from a folder with a space in its name | ok (".../Applications test/Kustodian.app": the window opened) | ok (`--version` and the engine smoke) | ok ("Downloads\Kustodian test\unblocked x64": the window opened) | ok ("Downloads\Kustodian test\explorer arm64", and `C:\Program Files\Kustodian`) | ok ("Downloads/Kustodian test": the window opened) | ok (`--version` and the engine smoke) |
| A missing WebKitGTK gives the named-package message | n/a | n/a | n/a | n/a | ok (plain `ubuntu:24.04`, and again with only `libicu74` added: the message names the Debian/Ubuntu and Fedora packages, exit 3; the AppImage gives the same) | ok (plain `fedora:latest`: same message, exit 3) |
| The AppImage runs without FUSE 2: with no `fusermount` it extracts itself, and with fuse3's it mounts | n/a | n/a | n/a | n/a | ok: with no `fusermount` it prints "No suitable fusermount binary found on the $PATH" and runs anyway (extract-and-run); installing `libfuse2t64` changes nothing. The guide's `libwebkit2gtk-4.1-0` already pulls in `fuse3`, and with it the AppImage mounts (`/tmp/.mount_*`). | ok (same: runs without `fuse-libs`; `webkit2gtk4.1` pulls in `fuse3`) |
| Cancel during a long run | owner | owner | owner | owner | owner | owner |
| Kill the engine by memory | owner | owner | owner | owner | owner | owner |
| Restart with unsaved tabs | owner | owner | owner | owner | owner | owner |
| Missing keychain on Linux | n/a | n/a | n/a | n/a | owner for sign-in. Without a keyring the sign-in screen shows "Sign-ins aren't remembered on this computer" with the reason, says the token stays in memory, and the log has "Tokens are kept in memory only" | owner |
| Signing with `build.ps1 -Sign` (Certum) | n/a | n/a | owner | owner | n/a | n/a |
| The release workflow's first run | owner | owner | owner | owner | owner | owner |

### Findings

- **The title doesn't show the version.** The window title is the constant `AppWindow.Title`, "Kustodian", on every
  platform. The version shows only in `--version`, in Apps (Windows) and in `Info.plist` (macOS). Either the title gets
  the version, or this row changes. Resolved: the spec doesn't ask for the version in the title, so the title stays and
  the row now checks `--version` and the OS app info.
- **The AppImage doesn't need FUSE 2.** The pinned type2 runtime (20251108) is static and only uses a `fusermount` binary
  (`fuse3` provides one, and WebKitGTK pulls it in on Ubuntu 24.04 and Fedora 44). Without one it falls back to
  extract-and-run. The FUSE 2 lines in `docs/install.md`, the README and the product site are therefore not needed.
  Resolved: the install guide, the release notes and the product site no longer ask for FUSE 2.
- **`.msi.sha256` has a CRLF line ending** (`Set-Content` on Windows). `shasum -a 256 -c Kustodian-1.0.0-x64.msi.sha256`
  on macOS then looks for "Kustodian-1.0.0-x64.msi\r" and fails with "No such file or directory". `Get-FileHash` on
  Windows, as the guide says, and `SHA256SUMS.txt` are fine. Resolved: `build.ps1` now writes it with an LF ending.
- **Linux `WM_CLASS` is ".", "."** for both the tarball and the AppImage. A desktop environment that matches windows to
  `kustodian.desktop` by `WM_CLASS` (GNOME, KDE) may not group the window with its launcher or show its icon from the
  desktop file. The window's own icon (`_NET_WM_ICON`) is set.

### Notes

- macOS window: the owner's own Kustodian had quit before this check, and the builder's instance was started with `HOME`
  pointed at an empty temporary folder, so it didn't touch the owner's user-data folder. As in Plan 3, it still showed an
  account in the header (MSAL reads the login keychain, which doesn't follow `HOME`), so it opened the workbench, not
  sign-in. Nothing was clicked or typed. The temporary folder was deleted afterwards.
- macOS Dock icon: read from `NSRunningApplication.icon` (the image the Dock shows), not from a screenshot of the Dock. It
  is the K, drawn in the system's tinted icon style.
- Windows: the first launch through `Start-Process` (not Explorer) showed the older "Open File - Security Warning" prompt
  ("Unknown Publisher"), not SmartScreen; through Explorer it was SmartScreen. Both were captured on the dialog's window only.
- Windows: the installer, SmartScreen and Kustodian windows were driven through UI Automation (no coordinates) and
  captured one window at a time. The 1.0.1 MSI is a local build for the upgrade check and was never published.
- Linux: the containers have no keyring, so every launch kept tokens in memory only. The AppImage ran with
  `--device /dev/fuse --cap-add SYS_ADMIN`.
- Plan 4 screenshots are not committed.

## Microsoft Graph Command Line Tools (2026-10-28)

Spec: `docs/design/specs/2026-10-28-graph-cli-client-design.md`. These checks need a live tenant, so they are the owner's to run.
Use a **test tenant** for the consent rows: granting a permission changes what everyone using the client can read.

| Check | macOS | Windows | Linux |
| --- | --- | --- | --- |
| Sign in with Microsoft Graph Command Line Tools (system browser) | owner | owner | owner |
| Sign in with Microsoft Graph Command Line Tools (device code) | owner | owner | owner |
| Resource Graph query behind a Graph Command Line Tools sign-in, first time: **Grant Azure access** is offered, completes in the browser, and the query runs | owner | owner | owner |
| Resource Graph query behind a Graph Command Line Tools sign-in, after that: runs silently, no extra account in the list | owner | owner | owner |
| **Grant permission…** as an admin: consent on Microsoft's screen, the query runs again | owner | owner | owner |
| **Grant permission…** as a non-admin: "Not granted. An administrator has to grant <permission>." appears | owner | owner | owner |

## Notes

- macOS launch check: the window title was "Kustodian". It showed a signed-in account because of an earlier owner sign-in cached
  on this Mac, so the sign-in screen itself was not seen. Closing the app (SIGTERM) left no Kustodian or `--engine` process. In Plan 2 (Task 13) SIGTERM
  did not stop the app within 8 s; see the Backlog.
- Windows launch check (Parallels Windows 11 ARM64, WebView2 154), first run: the "Kustodian" window opened but stayed white.
  With `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333`, the only page target reported `about:blank`: the
  navigation to `app://localhost/index.html` never took effect. Cause: Photino.Native 4.0.22 never registers custom schemes
  with WebView2 (no `CoreWebView2CustomSchemeRegistration`); it only intercepts requests through `WebResourceRequested`, and
  WebView2 treats an unregistered `app:` URL as an external protocol, so nothing loads. Fix: on Windows the handler is
  registered for `https` and the UI is served from `https://kustodian.invalid/` (`AppOrigin`); requests for other hosts are left
  to the web view. Re-check after the fix (2026-10-21): the window (1440x900 physical pixels) showed the sign-in screen, header
  "Kustodian / Microsoft Graph beta / Not signed in" and the "Sign in with your browser" button; captured with `PrintWindow`
  on the Kustodian window only. Not signed in. The app was then killed; no Kustodian process remained.
- Windows sizing: Photino passes `SetSize`/`SetMinSize` to Win32 as physical pixels. The VM runs at 300 % (288 DPI, checked
  with `GetDpiForMonitor`; the earlier note said 200 %, which was wrong), so the first fixed run's 1440x900 window gave the page
  only about 480x300 CSS pixels, with scrollbars. Fix: on Windows, once the native window exists, `WindowSizing.ForMonitor` scales
  1440x900 and the 1024x640 minimum by the monitor's DPI factor, caps both at the monitor's work area and centres the window.
  Re-check (2026-10-21, 300 %): 1440x900 logical is 4320x2700 physical, more than the 4112x2436 work area, so the window opened
  at exactly 4112x2436 at 0,0 (not maximised). The page got about 1370x810 CSS pixels and showed the whole sign-in card with no
  scrollbars. Captured on the Kustodian window only; not signed in; killed afterwards, no Kustodian process left. The 200 % case
  was not run on the VM (changing its display scaling is a system setting); it is covered by `WindowSizingTests` (2880x1800,
  minimum 2048x1280). macOS re-check: the window is still 1440x900 points (a 2880x1800 capture on Retina).
- Completion labels were blank (the owner's report: rows and icons showed, labels didn't). Cause: our global class `.main`
  (`display: flex; flex-direction: column`) also matched the `.main` element inside each Monaco suggestion row. That stacked the
  icon above the label, and the 21 px row clipped the label off, leaving only stray marks. `.body`, `.code`, `.input`, `.light`,
  `.overlay`, `.status` and `.tree` also clashed with Monaco's CSS (for example `.input` would restyle the find widget's input).
  They are renamed (`panes`, `codeblock`, `textbox`, `theme-light`, `workspace`, `scrim`, `statusbar`, `schema-tree`), and
  `src/styles.test.ts` fails if `styles.css` shares any class name with Monaco's or monaco-kusto's CSS. Checked in `vite dev`
  (Chromium): `applications | where ` now lists appId, createdDateTime, displayName ... with readable labels. Not seen in
  WKWebView in the app (see the completion row).
- Schema panel: the "N columns" count and the tags no longer shrink or wrap (`flex-shrink: 0; white-space: nowrap`); long table
  names truncate with an ellipsis. Seen in the macOS app (for example "agentRegistry_agentC… 21 columns" on one line).
- macOS screenshot attempt (Task 13, fix round): `screencapture -l <windowid>` works without extra permissions here. No Python
  `Quartz` module is installed, so a small Swift script called `CGWindowListCopyWindowInfo` (option `.optionAll`) and listed the
  windows whose owner name contains "Kustodian"; one of them was the 1440x900-point main window. The command that
  gave the shot, as run: `screencapture -x -o -l 81735 <scratchpad>/mac2.png` (81735 was that window's number; the PNG is
  2880x1800 and shows that window only). The first try, `screencapture -x -l 81740 <scratchpad>/mac.png`, used the id of
  another Kustodian window and captured something else, so pick the one with the 1440x900 bounds. The shot showed the workbench with a restored "Query 1" tab (unsaved dot),
  the owner's cached account, 436 schema tables, Run, Cancel, Format and Explain, and "Dark" in the status bar. Nothing was
  pressed. Typing and clicking still need Accessibility permission, so the rows stay owner. After the shot, SIGTERM did not stop
  the app within 8 s (the Plan 1 note says it did); it was killed with SIGKILL, and nothing was left running.
- Linux: only build and tests could be run (container, no display). The monaco-kusto-in-WebKitGTK question (spec 14, risk 2) is
  still open and needs a machine with a display.

- Plan 3 macOS launch (Task 8): the owner's own Kustodian (from the main checkout) was running and was left alone. The builder
  built the Plan 3 worktree and ran that build as a second instance through a small launcher script that sets `HOME` to an empty
  temporary folder, so `AppPaths.Root` pointed there and the owner's `accounts.json`, `session.json` and `recent.json` were never
  read or written. The log said the secure store was not available ("Tokens are kept in memory only", MSAL persistence check
  error -60006), as expected with a foreign `HOME`. Even so, the instance wrote an `accounts.json` into the temporary folder and
  showed an account in the title bar, so it opened the workbench rather than sign-in. The builder did not sign in and did not
  open the file; where that account came from (probably MSAL reading the login keychain, whose location doesn't follow `HOME`)
  was not investigated. The temporary folder was deleted afterwards. Window id from a Swift `CGWindowListCopyWindowInfo` script
  filtered by the instance's PID (the 1440x900 window), then `screencapture -x -o -l <id>`; the PNG is 2880x1800 and shows that
  window only. Nothing was clicked or typed, and only the bundled Graph schema was on screen (footer: msgraph-metadata commit and
  the permissions file), so the data-area grouping row is the only Plan 3 feature the shot verifies.
- Plan 3 Windows launch (Task 8): the worktree's tracked `kustodian/` files plus the macOS-built `web/dist` were copied into a new
  folder in the VM (`C:\src\kustodian-p3b`; the older `C:\src\kustodian` was left alone). A first copy picked up macOS
  AppleDouble `._*` files and failed with CS2015; copying again with `COPYFILE_DISABLE=1` fixed it. The app was started on the
  interactive desktop, captured with the Plan 2 `PrintWindow` script (Kustodian window only, 4112x2436) and closed with
  `CloseMainWindow`.
- Plan 3 screenshots are not committed (Plans 1 and 2 committed none either).

## Backlog

- Windows: Photino.Native 4.0.22 has no `WM_DPICHANGED` handler, so a window dragged to a monitor with a different DPI keeps its
  physical size (too big or too small there). It needs handling in Photino or a native hook in the host.
- SIGTERM didn't stop the macOS app in one Plan 2 check. .NET 10 managed code can't block SIGTERM, so check how it was launched
  (inherited ignored signal, job control, or the wrong PID): run `ps -o pid,ppid,stat,sigignore,sigcatch,command -p <pid>` on
  the apphost PID, then `kill -TERM`.
