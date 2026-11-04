# Error reporting: design

Date: 2026-11-04. Status: for the owner's review.

**Owner** means the owner decided it. **My call** means I chose it and the owner can overrule it while reading.

## 1. Why

Kustodian fails on machines the owner never sees: colleagues', and people's who found it on GitHub. Most of those users
will never get in touch, and some failures don't reproduce anywhere else.

The moment this came from (**Owner**): on another machine, a query on `security_securityAlerts` failed with a missing grant.
The grant was given, the same query was run again, and the engine failed with "The query engine stopped unexpectedly". It
has not reproduced on the owner's machine. Nothing on record says what happened, and the steps *before* the crash (a
failed run, a consent, a new token) are probably what matters.

What Kustodian handles is a tenant's directory, sign-ins and security alerts, so it is mostly other people's personal data.
An error message, a query or an engine log can carry it: a UPN in a filter, an IP in a parse error, an object ID in a Graph
error. Common practice (VS Code, the .NET SDK, Sentry's defaults, privacy-minded Sentry users such as Sable) is that
automatic error telemetry is scrubbed of messages, values and user paths. Fuller detail goes only where the user sees it
and chooses to send it (Firefox's crash dialog, VS Code's issue reporter). Kustodian's case is stricter than an editor's,
because the data in a message belongs to people who agreed to nothing (**Owner**, after that research).

## 2. Goals

- An unexpected failure on a user's machine reaches the owner, if the user opted in, with enough to find where in the code
  it failed and what led up to it: exception types and stack frames, the failure kind, an event trail, the app version and
  the OS.
- A user can choose to send a full report for any error the app shows, after seeing all of it, so the owner can
  reproduce it (**Owner**).
- Both go to the owner's existing Application Insights resource, privately (**Owner**: no GitHub account needed, and
  nothing is public).
- A full report and its automatic report share a short ID the user can quote to the owner.
- Crashes land in Application Insights' Failures view, grouped by problem, using its exception type (`ExceptionData`).

## 3. Non-goals

- Memory dumps, screenshots or result rows in any report.
- Contacting the user back. The ID is the link; a user who wants a reply quotes it on GitHub or to the owner.
- Retrying or queuing a send that fails. It is dropped, as telemetry is today.
- Performance or usage telemetry.
- Automatic reports for expected errors (§5.2). They go into the trail, and the user can still send a full report.

## 4. Anti-goals

These would make it a failure even if it works:

- Any tenant data in an automatic report: no query text, filter or parameter values, exception messages, Graph or engine
  output, object IDs, tenant or account IDs, file paths, machine or user names.
- A full report sent without the user having seen exactly what is sent, or sent by anything but their explicit click.
- Automatic reports for users who said yes only to sharing Graph findings.
- Error reporting that fails or slows down what the user is doing.
- Expected errors (a missing grant, a typo in a query) flooding the Failures view.

## 5. The model

### 5.1 Two layers

1. **Automatic reports.** Opt-in through a new setting, `ErrorReports`, separate from `Telemetry`. When an unexpected
   error happens, Kustodian sends one scrubbed `ExceptionData` envelope (§5.3).
2. **Full reports.** Every error the app shows gets a "Send details" action. It opens a dialog showing the whole report
   as text (§5.4). The user can remove parts and then sends it, or cancels. This does not depend on `ErrorReports`: each
   click is its own consent (**My call**).

### 5.2 Which errors are which

Unexpected, so they send an automatic report:

- The engine worker died or sent a malformed answer (`GraphEngineFailure.Crashed`, kinds `crash` and `frame`). Out of
  memory, timeouts, oversized answers and cancellations are the query's doing and are not bugs.
- A bridge handler threw something other than `BridgeException` or `OperationCanceledException` (the `catch (Exception)`
  in `Bridge.cs`, answered as `failed`).
- A run failed unexpectedly. Run failures never reach the bridge's catch: `GraphRunner` catches them itself and returns
  `RunOutcome.Failed` ("A Graph query failed unexpectedly", `GraphRunner.cs`). That catch-all reports, and so do the
  hunting and ARM sources' equivalents.
- An unhandled exception or unobserved task exception in the host process.
- A React render error (an error boundary) or an unhandled promise rejection or `error` event in the UI.

Expected, so they go into the trail only: `consentNeeded`, `signInNeeded`, `cancelled`, `bad_request`, errors in the query
itself (parse and semantic errors, refusals), Graph throttling and other Graph error responses that the app explains to
the user, and engine out of memory, timeout and oversized answers.

The builder sorts the remaining `BridgeException` codes and Graph failure types the same way: is it a bug in Kustodian,
or something the user or Graph caused?

### 5.3 Automatic report contents

One `ExceptionData` envelope, sent the way `AppInsightsTelemetry` sends events today: no SDK, `ai.location.ip` set to
`0.0.0.0`, `ai.application.ver` set to the app version. It contains:

- `exceptions[]`: for the exception and each inner exception, `typeName` and `parsedStack` frames with `level`, `method`
  and `assembly` only. `message` is set to the failure kind (such as `engine.crash` or `bridge.failed`), never the
  exception's own text. `fileName` and `line` are left out (**My call**: line numbers need the PDBs and add little next to
  method names). Frames come only from these assemblies: Kustodian, Kustodian.Graph, Kustodian.Engine, Kustodian.Sources,
  KustoLoco, Kusto.Language and the .NET runtime. Other frames are reduced to `<external>`.
- `properties`:
  - `reportId`: 8 random base32 characters, new for each error.
  - `kind`: the failure kind.
  - `os`: `RuntimeInformation.OSDescription` cut to the OS name and version.
  - `arch`, `runtime`: the .NET version.
  - `exitCode`: the engine's exit code or signal, if there is one.
  - `peakMemoryMb`, `memoryLimitMb`, `workerUptimeS`: if the error came from the engine.
  - `crashesLastMinute`, `paused`: the pool's state.
  - `source`: Graph, hunting or ARM, if a run was involved.
  - `trail`: §5.5 as a compact string.

Values outside this list are not sent. The scrubber that builds the envelope is the only way into the automatic layer. It
takes typed values, not free text, so nothing can slip in through a string.

### 5.4 Full report contents

Everything from §5.3, plus whatever is available:

- the query text and parameters
- each exception's full message and stack, including file paths
- the bridge method and error message
- the engine worker's last stderr lines (§6.1)
- the Graph request path and response error body, if there was one

The dialog shows it as plain text. Each section has a checkbox so the user can leave it out, and the query section is
editable so a user can blank out values (**My call**). The text shown is exactly what is sent. It is sent as an `EventData`
envelope named `Kustodian.FullErrorReport`, with the same `reportId`, and each section in its own property. The builder
checks App Insights' property size limit (8,192 characters per property value) and cuts each section to fit, saying so in
the dialog.

The dialog says plainly that the report may contain data from the tenant, where it goes, who can see it, and how long it is
kept.

### 5.5 The trail

An in-memory ring of the last 20 events (**My call**) in the host, each one a code and the seconds since the previous
event. Codes only, from a fixed list, never values. For example:

`run.start(graph)`, `run.error(consentNeeded)`, `account.consent(graph)`, `token.refresh(graph)`, `run.start(graph)`,
`engine.crash(exit=134)`

Events that go in: run started and finished (with source and outcome kind), each expected error code, sign-in, consent,
token acquired or refreshed (per audience), worker started, killed or retired (with kind), settings changed (the setting's
name only), and the UI's own errors. The trail is never written to disk.

### 5.6 The ID

`reportId` is shown with every error that sent an automatic report ("Report ID: K7Q2-M9XD") and in the "Send details"
dialog, with a copy button. A full report for an error with no automatic report gets its own ID.

## 6. Where the data comes from

### 6.1 The engine worker

Today a worker crash reaches the parent as a closed stream or an exception from reading frames, and the worker's stderr goes
to the logger at Debug only. Two changes:

- **A crash frame.** The worker's `AppDomain.UnhandledException` handler, and the catch-all around `ServeAsync`, write one
  last frame before exiting: `{ crash: { exceptions: [{ typeName, message, frames: [{ method, assembly }] }] } }`. It carries
  the message, but the parent passes the message only into a full report, never into an automatic one. Writing it is best
  effort. If the worker can't write it (a stack overflow, a native crash, a kill), the parent has only the exit code.
- **A stderr tail.** The parent keeps each worker's last 50 stderr lines (already cut to `MaxStderrLine`) in memory, for a
  full report only. .NET writes the stack of an unhandled exception and of a stack overflow to stderr, so this often has the
  stack even when no crash frame came.

`GraphEngineException` gains the crash details (the parsed exceptions, exit code, stderr tail and peak memory) so the code
above the pool can report them.

### 6.2 The host

- `Bridge.cs`'s `catch (Exception)` hands the exception to the error reporter along with the method name, and puts the
  `reportId` in the error answer: `{ code, message, reportId }`.
- The host registers `AppDomain.UnhandledException` and `TaskScheduler.UnobservedTaskException` handlers that report.
- Run failures pass their exception details (including `GraphEngineException`'s) up to the reporter, and `RunResult`
  gains a `reportId`, the same way the bridge's error answer does.

Every error the app shows gets its `reportId` when it happens, not when "Send details" is clicked. That is the only moment
host-side material such as a Graph response body and request path exists, and the §1 case depends on it. The reporter keeps
the material in memory in two stores, so that common expected errors can't push out crash material (**My call**):
unexpected errors keep their last 10, expected errors their last 20, and both drop entries after 30 minutes. "Send details"
asks for the material by ID over the bridge. If the material is gone, the dialog sends what the UI still has and says so.
Nothing is kept on disk.

### 6.3 The UI

- A top-level React error boundary and `window` `error` and `unhandledrejection` listeners send the UI's errors to the host
  over the bridge (`errors.report`): the error's name, message and JS stack. The host scrubs it the same way. The
  production bundle is minified, so function names in a JS stack mean nothing on their own. A frame is therefore reduced to
  the bundle file's name (such as `index-abc123.js`) and its line and column, which are code locations and not user data.
  Everything else in the URL is dropped.
- **Source maps** (**Owner**): the build makes them with `build.sourcemap: 'hidden'`, so they are not shipped in the app
  and no `sourceMappingURL` points to them. The release workflow attaches them to the GitHub release as one archive per
  version (`kustodian-<version>-sourcemaps.zip`). The owner decodes a reported frame with that version's map. The code is
  open source on GitHub, so the maps reveal nothing new (**My call**: if they must not be public, they go to a private
  store instead, and only the release step changes).
- Wherever the UI shows an error (the run result, `errorText` callers, dialogs), a "Send details" action is shown next to it.
  This is one shared component, used everywhere an error is shown.

## 7. Consent

- A new setting, `ErrorReports` (bool, null until asked), next to `Telemetry` in `SettingsService`. The two are separate.
  It copies the consent-version mechanism `Telemetry` already has (`TelemetryConsent`).
- A first-start dialog built like `TelemetryDialog`. It is asked once, after the Graph findings question if both are
  unanswered, and the answer can be changed in Settings. Esc closes it unanswered, so it asks again at the next start.
  Nothing is sent until the user says yes. Users who said yes to Graph findings are asked again, since this is a different
  thing (**My call**).
- Its explainer says what is sent and what is never sent, in the style of `TelemetryExplainer`, and links to the telemetry
  page.
- `site/telemetry.html` gets a section for each layer, with tables of what is sent and never sent like the existing one.
  The lead sentence ("one kind of data") changes to cover all three: Graph findings, error reports and full reports
  (**Owner**: the page can be updated).

## 8. Code layout

- `src/Kustodian/Telemetry/ErrorReporter.cs`: the trail, the scrubber, the recent full-report store, and sending.
- `src/Kustodian/Telemetry/AppInsightsTelemetry.cs`: gains `TrackExceptionAsync`, which posts an `ExceptionData` envelope
  alongside `TrackEventAsync`.
- `src/Kustodian.Graph/Engine/`: the crash frame, the stderr tail, and the details on `GraphEngineException`.
- `src/Kustodian.Engine/EngineMain.cs`: writes the crash frame.
- `src/Kustodian/Bridge/`: `Bridge.cs` reports; a new `errors.*` handler (`errors.details`, `errors.send`, `errors.report`).
- `web/src/shell/`: the error boundary, the listeners and the "Send details" component and dialog.
- `web/src/settings/`: the consent dialog and setting.
- `web/vite.config.ts` (`build.sourcemap: 'hidden'`) and `.github/workflows/release.yml` (archive the maps and attach the
  archive in `gh release create`). The installer and the app bundle must not include the `.map` files.
- `site/telemetry.html`.

## 9. Testing and verification

- **The scrubber**, as unit tests. Feed it exceptions whose messages, inner messages, `Data` and file paths contain a UPN,
  an IPv4 and IPv6 address, a GUID, a Windows and a macOS home path, and a KQL fragment. Assert that none of those strings
  appears anywhere in the serialized envelope. Do the same for JS errors and for the trail.
- **The envelope** matches the `ExceptionData` schema. Send one to a test App Insights resource and check that it shows up
  in Failures, grouped by problem.
- **The crash frame**: a test worker that throws, one that overflows its stack, and one that exits without a frame. The
  parent reports each with what it has.
- **Classification**: each expected code makes no automatic report; each unexpected path makes exactly one.
- **Consent**: with `ErrorReports` null or false, nothing is posted. With a full report, nothing is posted until "Send" is
  clicked, and what is posted equals what was shown, minus the sections left out.
- **Source maps**: a production build has no `.map` file in what is packaged and no `sourceMappingURL` comment, and a frame
  from a deliberately thrown UI error decodes to the right source line with that build's map.
- **Never fails the user**: a send that throws or times out changes nothing the user sees.
- `dotnet build -warnaserror`, `oxlint` and `tsc` pass clean.

## 10. What is left to the builder

- The exact trail codes and where each one is recorded.
- Sorting the remaining `BridgeException` codes and Graph failure types into expected and unexpected (§5.2).
- The dialog's layout and wording, in the style of the existing dialogs.
- How the OS description is cut down to a name and version.
