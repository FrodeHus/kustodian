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
| `dotnet test` | ok, 445 passed | ok, 442 passed, 3 skipped | ok, 445 passed |

Known open warnings, not failures: oxlint `react(incompatible-library)` for TanStack Table, Vite chunk-size.

## Launch

| Check | macOS | Windows | Linux |
| --- | --- | --- | --- |
| Window opens and the web UI renders from `app://` | ok (main window with an account already in the token cache; schema panel listed 438 tables) | FAIL (window opens, page stays blank; see notes) | - (headless container, no display) |
| No `--engine` process left after closing the window (idle) | ok | - | - |

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
| monaco-kusto completion works in the web view (WKWebView / WebView2 / WebKitGTK; spec 14 risk 2) | owner | owner | owner |
| Fresh download opens past Gatekeeper / SmartScreen (README walkthrough) | owner | owner | owner |

## Notes

- macOS launch check: the window title was "Kustodian". It showed a signed-in account because of an earlier owner sign-in cached
  on this Mac, so the sign-in screen itself was not seen. Closing the app (SIGTERM) left no Kustodian or `--engine` process.
- Windows launch check (Parallels Windows 11 ARM64, WebView2 154): the "Kustodian" window opens but stays white. With
  `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333`, the only page target reports `about:blank`, so the
  navigation to `app://localhost/index.html` never took effect. The embedded resources are fine: the assembly holds 84
  `wwwroot/...` names with forward slashes, matching the 84 files in `web/dist`. The `app://` scheme handler is the suspect on
  WebView2 and needs a fix before the Windows rows can be checked.
- Linux: only build and tests could be run (container, no display). The monaco-kusto-in-WebKitGTK question (spec 14, risk 2) is
  still open and needs a machine with a display.
