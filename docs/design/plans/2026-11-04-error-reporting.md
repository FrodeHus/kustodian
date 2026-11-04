# Error Reporting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every error Kustodian shows gets a report ID. Unexpected errors send a scrubbed `ExceptionData` report to
Application Insights when the user opted in, and the user can send a full report for any error after reading it.

**Architecture:**

- **Telemetry (host).** `ErrorScrubber` turns exceptions into type names and filtered frames, and nothing else.
  `ErrorTrail` keeps the last 20 event codes. `ErrorReporter` gives each error an ID, keeps the full-report material in
  memory, sends the automatic report, and sends a full report when asked. `AppInsightsTelemetry` gains
  `TrackExceptionAsync`.
- **Engine.** The worker writes a crash frame before it dies; the pool keeps a stderr tail per worker. Both ride on
  `GraphEngineException`.
- **Runs and bridge.** The runners set `RunResult.Cause` on unexpected failures only. `QueryHandler` and `Bridge` capture
  every error they answer with and put the `reportId` in the answer.
- **UI.** A shared "Send details" action and dialog, an error boundary and window listeners, and a consent dialog and
  setting.
- **Release.** Hidden source maps, kept out of the app and attached to the GitHub release.

**Tech Stack:** .NET 10, xUnit v3, `Microsoft.Extensions.Time.Testing`, React + TypeScript, Vitest, oxlint, Vite. No new
dependencies.

**Spec:** `docs/design/specs/2026-11-04-error-reporting-design.md`. Read it first; this plan argues from it.

## Global Constraints

- No warning suppressions: `dotnet build -warnaserror`, `oxlint` and `tsc` pass clean (`CLAUDE.md`). The two known open
  warnings stay as they are.
- Work only in this worktree (`worktree-error-reporting-design`); run each git command on its own.
- No Application Insights SDK. Envelopes are posted the way `AppInsightsTelemetry.TrackEventAsync` posts them today, with
  `ai.location.ip` = `0.0.0.0`.
- An automatic report never holds an exception message, query, parameter, Graph or engine output, object, tenant or account
  ID, file path, or machine or user name (spec §4). The scrubber is the only way into it.
- A full report is sent only by `errors.send`, which only the "Send" button in the dialog calls.
- Telemetry never throws into, or holds up, what the user is doing. Sends are not awaited by callers.
- Report IDs: 8 characters from the Crockford base32 alphabet (`0123456789ABCDEFGHJKMNPQRSTVWXYZ`), shown as `XXXX-XXXX`.
- Numbers: automatic-report frames come only from assemblies whose name starts with `Kustodian`, `KustoLoco`,
  `Kusto.Language` or `System`/`Microsoft` (the runtime); the trail holds 20 events; the stores hold 10 unexpected and 20
  expected errors for 30 minutes; full-report sections are cut to 8,192 characters; the stderr tail is 50 lines.
- Match the surrounding code: XML doc comments on public types, comment density, `string.Create(CultureInfo.InvariantCulture, …)`
  for numbers in text.

## Review Focus

1. **Ingestion is unreachable or slow** (offline, proxy): the user sees no change and nothing waits. The host's
   unhandled-exception handler waits at most 2 s for pending sends. Tested in Task 4.
2. **A crash loop** (the crash guard pausing the pool, the same bug on every run) must not send a report for each failure.
   At most one automatic report per problem (kind + exception type + top frame) per app session, and at most 20 per session
   (**plan's call**: the spec's anti-goal on flooding implies it). Tested in Task 4.
3. **The details are gone** by the time "Send details" is clicked (over 30 minutes, pushed out, or the app restarted): the
   dialog says so and offers to send what the UI still has. Tested in Tasks 4 and 8.
4. **A huge section** (a 1 MB query, a long stderr): each is cut to 8,192 characters with a visible "… cut" marker in the
   dialog *and* in what is sent, so what was shown is what was sent. Tested in Task 4.
5. **A crafted `errors.send`** that changes a section the dialog doesn't let the user edit, or adds a section that wasn't
   in the report, is refused with `bad_request` and sends nothing. Tested in Task 7.

---

### Task 1: `ExceptionData` envelopes

**Files:**
- Modify: `src/Kustodian/Telemetry/AppInsightsTelemetry.cs`
- Create: `src/Kustodian/Telemetry/ScrubbedException.cs`
- Test: `tests/Kustodian.Tests/Telemetry/AppInsightsTelemetryTests.cs` (create; reuse the `Recorder` handler pattern from
  `SharedProbeCacheTests`)

**Interfaces:**
- Produces: `public sealed record ErrorFrame(string Method, string Assembly);`
  `public sealed record ScrubbedException(string TypeName, IReadOnlyList<ErrorFrame> Frames);`
  `public Task TrackExceptionAsync(string kind, IReadOnlyList<ScrubbedException> exceptions, IReadOnlyDictionary<string, string> properties, CancellationToken ct = default)`

- [ ] **Step 1: Write the failing test** `Exception_envelope_has_types_frames_and_kind_only`: sending kind `engine.crash`
  with two exceptions (outer `System.InvalidOperationException` with frames `Kustodian.Graph.Run.GraphRunner.RunAsync` /
  `Kustodian.Graph`, inner `System.IO.IOException` with no frames) and properties `{ "reportId": "K7Q2M9XD" }` posts one
  envelope to `…/v2/track` where `name` = `Microsoft.ApplicationInsights.Exception`, `data.baseType` = `ExceptionData`,
  the tags equal the event tags, `baseData.exceptions` has 2 entries, each with `id`, `outerId` (inner points at outer),
  `typeName`, `message` = `engine.crash`, `hasFullStack` = true, and `parsedStack` entries with exactly `level`, `method`,
  `assembly`. No `fileName` or `line` key appears anywhere in the body. `baseData.properties` equals the given properties.
- [ ] **Step 2:** Run `dotnet test tests/Kustodian.Tests --filter AppInsightsTelemetryTests`. Expected: FAIL to compile.
- [ ] **Step 3: Implement** `TrackExceptionAsync` next to `TrackEventAsync`, sharing the envelope, tag and posting code
  (extract one private helper; don't copy it). `ExceptionData` schema:
  `{ ver: 2, exceptions: [{ id, outerId, typeName, message, hasFullStack, parsedStack: [{ level, method, assembly }] }], properties }`.
  Never throws, like `TrackEventAsync`.
- [ ] **Step 4:** Run the tests. Expected: PASS, including the existing `SharedProbeCacheTests`.
- [ ] **Step 5: Commit** `feat: send ExceptionData envelopes to Application Insights`.

### Task 2: The scrubber

**Files:**
- Create: `src/Kustodian/Telemetry/ErrorScrubber.cs`
- Test: `tests/Kustodian.Tests/Telemetry/ErrorScrubberTests.cs`

**Interfaces:**
- Consumes: `ScrubbedException`, `ErrorFrame` (Task 1); `EngineCrash` (Task 5; add the overload in Task 5, not here).
- Produces: `public static class ErrorScrubber`
  - `IReadOnlyList<ScrubbedException> Of(Exception exception)`: the exception, then its inner exceptions
    (`AggregateException.InnerExceptions` flattened), at most 10.
  - `IReadOnlyList<ScrubbedException> OfJs(string name, string? stack)`: one entry; `TypeName` = `name` if it matches
    `^[A-Za-z_$][\w$]{0,63}$`, else `Error`.

- [ ] **Step 1: Write the failing tests.** Build one test fixture, `Leaky`, used by every test here: the strings
  `adele.vance@contoso.com`, `10.20.30.40`, `2001:db8::1`, `0f8fee3c-12ab-4c3d-9e8f-1234567890ab`,
  `C:\Users\adele\AppData`, `/Users/adele/Library`, and `users | where displayName == "Adele"`.
  - `Of_keeps_type_names_and_frames_and_nothing_else`: an exception thrown (so it has a stack) through a Kustodian
    method, whose message, inner exception's message and `Data` each contain every `Leaky` string. Assert the serialized
    result contains none of them, `TypeName`s are the .NET full names, and the frames' `Method` is
    `Namespace.Type.Method`.
  - `Frames_outside_known_assemblies_are_external`: a frame from the test assembly (`Kustodian.Tests`… is allowed, so use
    a frame from a dynamic method or a lambda in an assembly named outside the list, e.g. via `Expression.Lambda(...).Compile()`)
    becomes one `ErrorFrame("<external>", "")`; consecutive external frames collapse into one.
  - `Of_caps_inner_exceptions_at_ten`: an `AggregateException` of 15 → 10 entries.
  - `OfJs_keeps_function_names_and_bundle_positions`: stack
    `"TypeError: x is undefined\n    at Qe (app://localhost/assets/index-abc123.js:1:48213)\n    at https://kustodian.invalid/assets/index-abc123.js:2:10"`
    → frames `("Qe", "index-abc123.js:1:48213")`, `("<anonymous>", "index-abc123.js:2:10")`; message text absent.
  - `OfJs_drops_anything_but_bundle_positions`: a stack line containing each `Leaky` string, and a frame whose URL isn't an
    `assets/*.js` file → no `Leaky` string survives; the non-bundle frame becomes `<external>`.
- [ ] **Step 2:** Run `dotnet test tests/Kustodian.Tests --filter ErrorScrubberTests`. Expected: FAIL.
- [ ] **Step 3: Implement** with `System.Diagnostics.StackTrace(exception)` and `StackFrame.GetMethod()`, reading
  `DeclaringType.FullName`, `Name` and `Module.Assembly.GetName().Name`. Never read `Message`, `Data`, `Source`,
  `HelpLink` or `ToString()`. For JS, parse each `at` line with one regex for `name (url:line:col)` and `url:line:col`,
  keeping only the last path segment of a URL under `/assets/` that ends in `.js`.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat: scrub exceptions to types and frames`.

### Task 3: The trail

**Files:**
- Create: `src/Kustodian/Telemetry/ErrorTrail.cs`
- Test: `tests/Kustodian.Tests/Telemetry/ErrorTrailTests.cs`

**Interfaces:**
- Produces: `public sealed class ErrorTrail(TimeProvider time)` with `const int Capacity = 20`, `void Add(string code)`,
  `string Render()`. Thread-safe.

- [ ] **Step 1: Write the failing tests.**
  - `Render_lists_codes_with_seconds_since_the_previous_event`: add `run.start(graph)`, advance the fake clock 2 s, add
    `run.error(consentNeeded)` → `"run.start(graph) +0s; run.error(consentNeeded) +2s"`.
  - `Keeps_the_last_twenty`: 25 events → the first 5 are gone.
  - `Refuses_anything_that_is_not_a_code`: `Add("run.error(adele.vance@contoso.com)")`, `Add("x")`, `Add(new string('a', 65))`
    and `Add("run.start(graph) users | take 1")` add nothing.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3: Implement.** A code matches `^[a-z]+(\.[a-zA-Z]+)+(\([a-zA-Z0-9=.,-]{1,40}\))?$` and is at most 64
  characters; anything else is dropped (and `Debug.Fail`s, since only code constants should reach it). The minimum set the
  later tasks record: `run.start(<source>)`, `run.end(<outcome>)`, `bridge.error(<code>)`, `account.signIn`,
  `account.consent(<audience>)`, `token.acquire(<audience>)`, `engine.start`, `engine.kill(<kind>)`, `engine.exit(<code>)`,
  `settings.change(<name>)`, `ui.error(<source>)`.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5: Commit** `feat: keep a trail of recent event codes`.

### Task 4: The reporter

**Files:**
- Create: `src/Kustodian/Telemetry/ErrorReporter.cs`
- Test: `tests/Kustodian.Tests/Telemetry/ErrorReporterTests.cs`

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces:
  - `public sealed record ErrorFacts(string? Source = null, int? ExitCode = null, int? PeakMemoryMb = null, int? MemoryLimitMb = null, int? WorkerUptimeS = null, int? CrashesLastMinute = null, bool? Paused = null);`
    (`Source` is one of `graph`, `hunting`, `arg`, `ui`, `host`, or null.)
  - `public sealed record FullReportSection(string Key, string Title, string Text, bool Editable);`
  - `public sealed record ErrorCapture(string Kind, bool Unexpected, IReadOnlyList<ScrubbedException> Exceptions, ErrorFacts Facts, IReadOnlyList<FullReportSection> Details);`
  - `public sealed record FullReport(string ReportId, string Kind, IReadOnlyList<FullReportSection> Sections);`
  - `public sealed class ErrorReporter(AppInsightsTelemetry telemetry, Func<CancellationToken, Task<bool>> enabled, ErrorTrail trail, TimeProvider time)`:
    `string Capture(ErrorCapture capture)`, `FullReport? Details(string reportId)`,
    `Task<bool> SendAsync(string reportId, IReadOnlyDictionary<string, string> sections, CancellationToken ct)`,
    `Task FlushAsync(TimeSpan wait)`, `public const string FullReportEvent = "Kustodian.FullErrorReport";`

- [ ] **Step 1: Write the failing tests.**
  - `Capture_returns_a_new_id_each_time` (8 Crockford base32 characters).
  - `Unexpected_error_sends_one_exception_report_when_enabled`: the envelope's properties are exactly `reportId`, `kind`,
    `os`, `arch`, `runtime`, `trail`, plus each non-null `ErrorFacts` field in camelCase. None of the `Details` texts appear.
  - `Expected_error_sends_nothing`, `Disabled_sends_nothing`, `Unconfigured_sends_nothing`.
  - `Same_problem_is_reported_once_per_session` (same kind, type and top frame twice → one send; different top frame → two),
    and `At_most_twenty_reports_per_session`.
  - `Details_are_kept_ten_unexpected_and_twenty_expected_for_thirty_minutes`: 25 expected captures don't evict an earlier
    unexpected one; the 11th unexpected evicts the 1st; after 30 minutes on the fake clock `Details` is null.
  - `Details_include_the_scrubbed_report_and_trail_as_sections` (keys `report`, `trail`, plus the capture's own).
  - `SendAsync_sends_the_given_sections_as_one_event`: event name `Kustodian.FullErrorReport`, properties `reportId`,
    `kind`, and one property per section key. Works with error reports disabled. A section over 8,192 characters is cut
    and ends with `… (cut)`, and `Details` returns it already cut, so what was shown is what was sent.
  - `SendAsync_refuses_changed_or_unknown_sections`: a changed non-editable section, or a key not in the report → returns
    false, sends nothing. Leaving sections out is allowed.
  - `SendAsync_for_an_expired_report_sends_the_ui_sections_only`: unknown `reportId` → sends only the keys `query`,
    `message` and `uiStack` (the UI's own), returns true.
  - `A_send_that_fails_changes_nothing`: the HTTP handler throws; `Capture` still returns an ID and doesn't throw.
  - `FlushAsync_waits_at_most_the_given_time` for a handler that never answers.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3: Implement.** IDs from `RandomNumberGenerator`. `os`: `RuntimeInformation.OSDescription` reduced to its first
  two words (left to the builder per spec §10, but it must not include a host name or kernel build string); `arch`:
  `RuntimeInformation.OSArchitecture`; `runtime`: `Environment.Version`. Sends are started, not awaited, and tracked so
  `FlushAsync` can wait on them.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5: Commit** `feat: give each error a report ID and send reports`.

### Task 5: Engine crash details

**Files:**
- Modify: `src/Kustodian.Graph/Engine/EngineProtocol.cs`, `GraphEngineException.cs`, `GraphEnginePool.cs`
- Modify: `src/Kustodian.Engine/EngineMain.cs`
- Modify: `src/Kustodian/Telemetry/ErrorScrubber.cs` (add the `EngineCrash` overload)
- Test: `tests/Kustodian.Engine.Tests/GraphEnginePoolTests.cs` (add a `StandInWorker` script that writes a crash frame),
  `tests/Kustodian.Engine.Tests/EngineMainTests.cs` (or the existing engine tests file), `ErrorScrubberTests`

**Interfaces:**
- Produces (in `Kustodian.Graph.Engine`):
  - `public sealed record EngineStackFrame(string Method, string Assembly);`
  - `public sealed record EngineCrashException(string TypeName, string Message, IReadOnlyList<EngineStackFrame> Frames);`
  - `public sealed record EngineCrash(IReadOnlyList<EngineCrashException> Exceptions);`
  - `EngineResponse` gains a last parameter `EngineCrash? Crash = null`.
  - `GraphEngineException` gains init properties `EngineCrash? Crash`, `int? ExitCode`, `IReadOnlyList<string> StderrTail`
    (default empty), `long? PeakBytes`, `TimeSpan? WorkerUptime`.
  - `GraphEnginePool` constructor gains an optional last parameter `Action<string>? trail = null` and calls it with
    `engine.start`, `engine.kill(<kind>)`, `engine.exit(<code>)`.
  - `ErrorScrubber.Of(EngineCrash crash)`: same rules as `Of(Exception)`, dropping `Message`.

- [ ] **Step 1: Write the failing tests.**
  - Engine: `Unhandled_exception_writes_a_crash_frame_then_exits`: a request that makes `EngineHandler` throw (inject via a
    test seam, or a KQL that throws inside the handler outside its own catch) → the output has one `EngineResponse` with
    `Crash` set, type names and frames filled in, exit code non-zero.
  - Pool: `Crash_frame_reaches_the_exception`: a stand-in that answers with a crash frame → `GraphEngineException` with
    `Failure` = `Crashed`, `Crash` equal to the frame, `ExitCode` set, and `PeakBytes`/`WorkerUptime` set.
  - Pool: `Stderr_tail_keeps_the_last_fifty_lines_whatever_the_log_level`: a stand-in printing 60 lines then exiting →
    `StderrTail` has lines 11–60, each cut to 500 characters.
  - Pool: `Crash_without_a_frame_has_the_exit_code`: the existing garbage-answer stand-in → `Crash` null, `ExitCode` set.
  - Pool: `Out_of_memory_and_timeout_are_not_crashes` stays green (existing tests).
  - Scrubber: `Of_engine_crash_drops_messages`.
- [ ] **Step 2:** Run `dotnet test tests/Kustodian.Engine.Tests`. Expected: FAIL.
- [ ] **Step 3: Implement.** In `EngineMain`, the `UnhandledException` handler and a new `catch (Exception)` around
  `ServeAsync` (after the out-of-memory checks, which keep exiting with `EngineExitCodes.OutOfMemory`) write one
  `EngineResponse(null, null, 0, 0, null, null, crash)` frame, best effort, then exit with a new
  `EngineExitCodes.Crashed = 4`. In the pool, `Worker` keeps a `StderrTail` (lock-guarded queue of 50) and its start time.
  The `ErrorDataReceived` handler always fills the tail and still logs at Debug as today. An `EngineResponse` with `Crash` set
  is handled like a crash (retire, kill, the crash guard counts it), and every `GraphEngineException` thrown from
  `ExecuteAsync` carries the details.
- [ ] **Step 4:** Run `dotnet test tests/Kustodian.Engine.Tests tests/Kustodian.Graph.Tests`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: carry engine crash details to the host`.

### Task 6: Settings and consent

**Files:**
- Modify: `src/Kustodian/Settings/SettingsService.cs`, `web/src/wire.ts`, `web/src/settings/settings-writes.ts`,
  `web/src/settings/settings-view.tsx`, `web/src/app.tsx`
- Create: `web/src/settings/error-reports.tsx`
- Test: `tests/Kustodian.Tests/Settings/SettingsServiceTests.cs`, `web/src/settings/error-reports.test.tsx`

**Interfaces:**
- Produces: `AppSettings` gains last parameters `bool? ErrorReports = null, int ErrorReportsConsent = 0`, and
  `public const int CurrentErrorReportsConsent = 1;`. Web: `AppSettings.errorReports?: boolean | null`,
  `setErrorReports(on: boolean): Promise<SettingsAnswer>`, `ErrorReportsExplainer`, `ErrorReportsDialog({ onClose })`.

- [ ] **Step 1: Write the failing tests.**
  - .NET: `Error_reports_yes_to_an_older_consent_reads_as_unasked` and `Error_reports_answer_is_stamped_with_the_current_consent`,
    mirroring the existing `Telemetry`/`TelemetryConsent` tests. `Telemetry` and `ErrorReports` don't affect each other.
  - Web: the dialog's "Yes" calls `setErrorReports(true)`, "No" calls `setErrorReports(false)`, Esc closes it unanswered,
    and the explainer says what is sent (`error types and where in Kustodian's code they happened, the recent steps before
    it as codes, the app version and OS`) and what never is (`your tenant, account, queries, values, results or error
    messages`). In `app.tsx`, the error-reports dialog shows only once the Graph findings dialog is answered or closed.
- [ ] **Step 2:** Run `dotnet test tests/Kustodian.Tests --filter SettingsServiceTests` and `npm test -- error-reports`
  (in `web/`). Expected: FAIL.
- [ ] **Step 3: Implement** by copying the `Telemetry`/`TelemetryConsent` pattern in `GetAsync` and `SetAsync`, and the
  `TelemetryDialog`/`TelemetryExplainer` pattern for the UI. Settings shows a toggle under the existing sharing toggle, with
  the explainer. The dialog has a link to the telemetry page through `openTelemetryDocs`.
- [ ] **Step 4:** Run both test suites, `npm run lint` and `npm run typecheck`. Expected: PASS, no warnings.
- [ ] **Step 5: Commit** `feat: ask for consent to send error reports`.

### Task 7: Capture in the host

**Files:**
- Modify: `src/Kustodian.Graph/Run/RunResult.cs`, `GraphRunner.cs`, `src/Kustodian.Sources/Shared.cs`
  (`SourceFailure.Of`), `src/Kustodian/Bridge/BridgeMessages.cs`, `src/Kustodian/Bridge/Bridge.cs`,
  `src/Kustodian/Bridge/Handlers/QueryHandler.cs`, `src/Kustodian/Bridge/Handlers/AccountHandler.cs`,
  `src/Kustodian/App/AppServices.cs`, the host entry point (`src/Kustodian/App/EntryPoint.cs` or `AppHost.cs`, where the
  process starts), the token handlers (`GraphAuthHandler`, `ArmAuthHandler`)
- Create: `src/Kustodian/Bridge/Handlers/ErrorHandler.cs`
- Test: `tests/Kustodian.Tests/Bridge/BridgeTests.cs`, `tests/Kustodian.Tests/Bridge/ErrorHandlerTests.cs`,
  `tests/Kustodian.Tests/Bridge/SourceDispatchTests.cs` (or wherever `QueryHandler` is tested),
  `tests/Kustodian.Graph.Tests/Run/GraphRunnerTests.cs`

**Interfaces:**
- Consumes: Tasks 2, 4, 5.
- Produces:
  - `RunResult`: `public string? ReportId { get; init; }` (on the wire) and `[JsonIgnore] public Exception? Cause { get; init; }`.
    Check `RunResultConverter` writes `reportId` and never `cause`.
  - `BridgeError(string Code, string Message, string? ReportId = null)`.
  - `Bridge` gains an optional `ErrorReporter?` and `ErrorTrail?`.
  - `ErrorHandler(ErrorReporter reporter)` registers `errors.details` `{ reportId }` → `FullReport | null`,
    `errors.send` `{ reportId, sections: { [key]: text } }` → `{ sent: bool }` (`bad_request` when the reporter refuses), and
    `errors.report` `{ name, message, stack, source: "boundary" | "error" | "rejection" }` → `{ reportId }`.

- [ ] **Step 1: Write the failing tests.**
  - Runner: `Unexpected_failure_sets_cause`: the catch-all path and an engine `Crashed` set `Cause`; `Busy`, timeout,
    memory, sign-in, permission and fetch failures leave it null. The same for `SourceFailure.Of` (hunting and ARG).
  - Query handler: `Failed_run_gets_a_report_id`: every non-`ok`, non-cancelled outcome gets one. Only those with `Cause` are
    `Unexpected`. The capture's details hold sections `query` (editable), `parameters`, `message`, `exception`
    (`Cause.ToString()`), `graphError` (the read failure and its requests' paths and error bodies, when present) and
    `engineStderr` (the tail, when present). Facts come from `GraphEngineException`. The trail gets `run.start(<source>)` and
    `run.end(<outcome>)`.
  - Bridge: `Unexpected_handler_exception_is_reported_with_its_id` (the answer has `reportId`, the capture is unexpected,
    kind `bridge.failed`); `BridgeException_is_captured_as_expected` (with the code in the trail as `bridge.error(<code>)`);
    `Cancelled_gets_no_report_id`.
  - Error handler: `Send_refuses_changed_sections` (Review Focus 5); `Report_from_the_ui_is_scrubbed` (no message text in the
    automatic report; the message is in the `message` section of the full report).
  - Entry point: an unhandled exception captures one unexpected report (kind `host.unhandled`) and flushes for up to 2 s;
    `TaskScheduler.UnobservedTaskException` captures kind `host.unobserved` and calls `SetObserved()`.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3: Implement.** `AppServices` creates one `ErrorTrail` and one `ErrorReporter` (enabled =
  `settings.ErrorReports == true`), passes the trail to the pool (Task 5's `Action<string>`), registers `ErrorHandler`, and
  hands both to the `Bridge`. Record the trail codes from Task 3 at: `QueryHandler` (`run.*`), `Bridge` (`bridge.error`),
  `AccountHandler` (`account.signIn`, `account.consent(<audience>)`), the token handlers (`token.acquire(<audience>)` when a
  token is fetched rather than taken from the cache), and `SettingsHandler` (`settings.change(<name>)`, with names from a
  fixed list).
- [ ] **Step 4:** Run `dotnet test` (all projects) and `dotnet build -warnaserror`. Expected: PASS, no warnings.
- [ ] **Step 5: Commit** `feat: capture every error the host answers with`.

### Task 8: "Send details" in the UI

**Files:**
- Modify: `web/src/bridge.ts` (`BridgeError.reportId`), `web/src/wire.ts` (`RunResult.reportId`, the `errors.*` types),
  `web/src/main.tsx` (boundary and listeners), `web/src/results/run-status.tsx`, and each component that shows a caught
  error to the user: `app.tsx`, `settings/settings-view.tsx`, `settings/telemetry.tsx`, `settings/update-dialog.tsx`,
  `explain/explain-view.tsx`, `toolbar/scope-picker.tsx`, `library/save-dialog.tsx`, `side/snippet-panel.tsx`,
  `side/recent-panel.tsx`, `side/saved-panel.tsx`, `results/result-panel.tsx`, `results/run-tool.tsx`,
  `signin/consent-button.tsx`, `signin/created-view.tsx`, `signin/create-app-dialog.tsx`,
  `signin/grant-permission-button.tsx`, `raw/raw-tab.tsx`, `params/params-form.tsx`. Callers of `errorText` that don't show
  the error (`results/copy.ts`, `session/session-sync.ts`, `schema/schema-store.ts`) are checked and left alone if they
  don't.
- Create: `web/src/shell/error-report.tsx`, `web/src/shell/error-capture.ts`
- Test: `web/src/shell/error-report.test.tsx`, `web/src/shell/error-capture.test.ts`, `web/src/results/run-status.test.tsx`
  (extend)

**Interfaces:**
- Consumes: Task 7's `errors.*` methods and `reportId` fields.
- Produces: `formatReportId(id: string): string` (`"K7Q2M9XD"` → `"K7Q2-M9XD"`);
  `reportIdOf(e: unknown): string | undefined`; `<ErrorReportActions reportId={…} uiSections={{ query?, message, uiStack? }} />`,
  which shows "Report ID: K7Q2-M9XD", a copy button and "Send details"; `SendDetailsDialog`; `installErrorCapture(): () => void`;
  `<ErrorBoundary>`.

- [ ] **Step 1: Write the failing tests.**
  - `formatReportId` and `reportIdOf` (a `BridgeError` with and without an ID, a plain `Error`, a string).
  - Dialog: opening it calls `errors.details`; it shows each section with a checkbox (all checked) and the query section as
    an editable textarea; the warning text says the report may contain data from the tenant and goes privately to the
    Kustodian maintainer's Application Insights, kept for 90 days; "Send" calls `errors.send` with exactly the checked
    sections as displayed; unchecking a section leaves it out; "Cancel" sends nothing. When `errors.details` answers null,
    it says the details are no longer available and offers the UI's own sections (Review Focus 3).
  - `run-status`: a failed run with a `reportId` shows `ErrorReportActions`.
  - Capture: a `window` `error` event and an `unhandledrejection` each call `errors.report` once with `source` set; a render
    error inside `ErrorBoundary` calls it with `boundary` and shows a fallback with `ErrorReportActions`. A failure in
    `errors.report` itself doesn't report again.
- [ ] **Step 2:** Run `npm test` in `web/`. Expected: FAIL.
- [ ] **Step 3: Implement.** In each listed component, keep the caught error in state (not only its text) and render
  `<ErrorReportActions reportId={reportIdOf(e)} uiSections={…} />` next to the message. It renders nothing without an ID.
  Use the existing dialog and button styles (`card`, `scrim`, the `TelemetryDialog` layout).
- [ ] **Step 4:** Run `npm test`, `npm run lint` and `npm run typecheck`. Expected: PASS; only the two known warnings.
- [ ] **Step 5: Commit** `feat: offer Send details on every error`.

### Task 9: Source maps

**Files:**
- Modify: `web/vite.config.ts`, `src/Kustodian/Kustodian.csproj` (the `KustodianWebFile` include),
  `.github/workflows/release.yml`, `docs/releasing.md`

- [ ] **Step 1: Write the failing check.** A test in `tests/Kustodian.Tests/App/` (next to the existing embedded-UI tests,
  or `ScaffoldTests`) `Embedded_ui_has_no_source_maps`: no embedded resource under `wwwroot/` ends in `.map`, and no
  embedded `.js` contains `sourceMappingURL`.
- [ ] **Step 2:** Set `build: { outDir: 'dist', sourcemap: 'hidden' }`, run `dotnet build`, and run the test. Expected: FAIL,
  since the `.map` files are now in `dist`.
- [ ] **Step 3: Implement.** Exclude `$(KustodianWebDist)**\*.map` from `KustodianWebFile`. In `release.yml`, the job that
  builds the web UI uploads `web/dist/**/*.map` as an artifact. The release job zips them as
  `artifacts/kustodian-$VERSION-sourcemaps.zip`, which then sits next to the packages and is covered by `SHA256SUMS.txt` and
  the existing `artifacts/Kustodian-*` / explicit file list of `gh release create` (add it explicitly; the glob is
  case-sensitive). The web bundle must be identical across the platform jobs; if it isn't, take the maps from the job whose
  bundle is shipped and say so in a comment. `docs/releasing.md`: step 4's asset check mentions the source-map zip, and a
  short section says how to decode a reported frame with it.
- [ ] **Step 4:** Run the test and `npm run build`. Expected: PASS; `dist` has `.map` files and the app doesn't.
  Decode one frame from a deliberately thrown error with the map (any source-map CLI run through `npx`, not added as a
  dependency) and confirm it names the right source line.
- [ ] **Step 5: Commit** `build: keep hidden source maps and attach them to releases`.

### Task 10: Docs and site

**Files:**
- Modify: `site/telemetry.html`, `site/index.html`, `README.md`, `docs/manual-checks.md`

- [ ] **Step 1: `site/telemetry.html`.** The lead becomes: Kustodian can share two kinds of data, each only if you say yes
  (Graph compatibility findings and error reports), and you can choose to send a full report for a single error. Add a
  section for each new layer with "Sent" and "Never sent" tables in the existing style, using spec §5.3 and §5.4. Say that a
  full report may contain data from your tenant, that you see all of it first, and that it is sent only when you click Send.
  The existing hosting, region, IP and 90-day retention paragraph covers all three; say so.
- [ ] **Step 2: `site/index.html`.** The privacy lead (line ~337) and the Telemetry fact (line ~341) mention error reports
  and full reports alongside Graph findings, linking to `telemetry.html`.
- [ ] **Step 3: `README.md`.** Under "Privacy and security", one paragraph: off unless you opt in; what automatic error
  reports send and never send; "Send details"; a link to the telemetry page.
- [ ] **Step 4: `docs/manual-checks.md`.** Add a check: with error reports on, kill the engine worker during a run and
  confirm one exception appears in the Application Insights Failures view with no message text; then use "Send details",
  untick a section, and confirm the event has exactly the ticked sections.
- [ ] **Step 5:** Open both site pages in the browser preview at phone and desktop widths; no layout breaks.
- [ ] **Step 6: Commit** `docs: describe error reports and full reports`.

---

## Final check

- [ ] `dotnet build -warnaserror`, `dotnet test`, and in `web/` `npm run lint`, `npm run typecheck`, `npm test`,
  `npm run build`. All pass; only the two known warnings.
- [ ] Run the app with a test connection string, trigger an engine crash (a stand-in worker, or killing the worker), and
  check the envelope in Application Insights: no message, path or value; the trail shows the steps before it.
