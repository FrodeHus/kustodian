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

Run by the builder with no sign-in and no typing into any app window. Why most rows are "owner": the builder has no
Accessibility permission on macOS, so synthetic keys can't reach the window, and there is no screenshot tool for a single macOS
window. The macOS app was not launched, because this Mac's token cache holds the owner's account and a Run there is not allowed.
On the Windows VM the app has no account, so it stops at the sign-in screen; the workbench (tabs, palette, Explain, file dialogs)
is only reachable after signing in, so those rows are "owner" there too. A Windows click (`click.ps1`) reached the page (the
settings gear took its hover state) but opened no panel while signed out.

### Automated gate

| Check | macOS | Windows | Linux |
| --- | --- | --- | --- |
| `npm ci`, lint, typecheck, test, build in `web/` | ok (240 web tests; lint shows only the known TanStack Table warning, now at `src/results/result-grid.tsx`; build only the Vite chunk-size note) | - (no Node in the VM) | - (not run) |
| `dotnet build Kustodian.slnx -warnaserror`, 0 warnings | ok | ok (VM, Debug) | ok (Ubuntu 24.04 container with `libwebkit2gtk-4.1-dev` and `libsecret-1-dev`) |
| `dotnet test --solution Kustodian.slnx` | ok, 885 passed | ok, 881 passed, 4 skipped | ok, 885 passed |
| Window opens and renders the UI from its origin | owner (not launched, see above) | ok (4112x2436 physical px; sign-in screen, "Not signed in", settings gear in the header; captured with `PrintWindow` on the Kustodian window only) | - (headless container) |

### Plan 2 features

| Check | macOS | Windows | Linux |
| --- | --- | --- | --- |
| Restart with two unsaved tabs: both come back | owner | owner | owner |
| Theme: light, dark, system | owner | owner (dark seen on the sign-in screen only) | owner |
| Palette opens with the platform shortcut (`⌘ K` on macOS, `Ctrl K` elsewhere) | owner | owner | owner |
| Save a query, restart, open it from Saved | owner | owner | owner |
| Run a `datatable` snippet (no Graph data); snippets that need a tenant stay owner | owner | owner | owner |
| Explain a query (no Graph call; needs the workbench, which sits behind sign-in) | owner | owner | owner |
| Open and save a `.kql` file through the native dialogs; paths come back (no suggested name, a Photino limitation) | owner | owner | owner |
| Settings validation and the restart notice | owner | owner | owner |
| Parameters, diagnostics, raw request tab, results tools (tabs, grid tools, export, chart, compare) against live data | owner | owner | owner |
| `⌘ W` closes a tab in the real macOS window: Photino's menu may take it before the page sees it | owner | n/a | n/a |
| Row menus, column, copy and export menus and the save dialog: a click on an item lands (WebKit doesn't focus buttons on mousedown) | owner (WKWebView) | owner (WebView2) | owner (WebKitGTK) |
| Native open and save dialogs open and return paths | owner | owner | owner |
| Drag a `.kql` file from Finder or Explorer into the window: opens exactly one tab | owner | owner | owner |
| `crypto.randomUUID` on the macOS `app://` origin: log `window.isSecureContext` in a dev build; if false, the `getRandomValues` fallback covers it | owner | n/a (`https://kustodian.invalid` is a secure context) | owner |
| monaco-kusto completion in the web view (owner-only since Plan 1) | owner (WKWebView) | owner (WebView2) | owner (WebKitGTK) |

## Notes

- macOS launch check: the window title was "Kustodian". It showed a signed-in account because of an earlier owner sign-in cached
  on this Mac, so the sign-in screen itself was not seen. Closing the app (SIGTERM) left no Kustodian or `--engine` process.
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
- Linux: only build and tests could be run (container, no display). The monaco-kusto-in-WebKitGTK question (spec 14, risk 2) is
  still open and needs a machine with a display.

## Backlog

- Windows: Photino.Native 4.0.22 has no `WM_DPICHANGED` handler, so a window dragged to a monitor with a different DPI keeps its
  physical size (too big or too small there). It needs handling in Photino or a native hook in the host.
