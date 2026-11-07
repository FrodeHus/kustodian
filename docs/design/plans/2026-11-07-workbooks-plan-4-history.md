# Workbooks, plan 4: result history — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Stat, Chart or Table widget can keep history. **Values over time** stores each run's small result, so a Stat
shows "▲ 37 vs 7 days ago" and a Chart plots the snapshots with gaps. **Row tracking** remembers when each key was first
seen and when it was no longer reported, so a Table shows New since / No longer reported since a point and a Stat counts
them. History is set up in the editor's History tab (screen 9) and shown in the widgets (screen 8).

**Architecture:**

- **The host owns history.** `src/Kustodian/History/HistoryStore.cs` keeps one SQLite database, `history.db` in the data
  folder, through `Microsoft.Data.Sqlite` (spec §10.4, **Owner**). `HistoryHandler` exposes `history.record`,
  `history.values`, `history.changes`, `history.series` and `history.clear`. The host also derives the series keys
  (SHA-256 in C#), because the webview's `crypto.subtle` needs a secure context the `app://` origin may not give.
- **The web decides what to send.** After a widget's run answers, `workbook-store.ts` checks `recordable(...)` (pure, in
  `web/src/workbooks/history.ts`). Only a run with `outcome === 'ok'` and `total === rows.length`, on a saved, unchanged
  workbook, is sent. Otherwise the widget gets a skip reason. Row tracking sends only the key and kept columns.
- **Widgets read history after each run** through `useHistory(tabId, widget)`, which calls `history.values` or
  `history.changes` keyed by the run's `finishedAt`. The Since choice in a widget is view state in the store, never in
  the doc; its default is `widget.history.since`.
- **The web never computes "new" or "gone".** The host does it in SQL, so the answer works the same at 18,000 keys or
  300,000.
- **Not in this plan:** a scheduler (spec non-goal); the workbook header's "4 widgets keep history" line and a
  workbook-wide CompareTo parameter (screen 8 shows both; a per-widget Since covers the cases raised); a chart range
  picker (the chart shows every retained snapshot); screen 9's "Not saved" list across sessions (the widget's own skip
  line is enough, and it isn't stored); column-change tracking (spec §10.1, waits for a case).

**Tech Stack:** .NET 10, `Microsoft.Data.Sqlite` (new, owner-approved), xUnit v3, React 19 + TypeScript, zustand, Recharts
through the existing `ChartView`, Vitest + Testing Library, oxlint.

**Spec:** `docs/design/specs/2026-11-06-workbooks-design.md` §10 (all of it, with §10.4 as changed 2026-11-07). Mockups:
screen 8 (`History`) and screen 9 (`HistoryConfig`) on the canvas linked from the spec. Plans 1–3 built what this plan
extends.

## Global Constraints

- No warning suppressions: `dotnet build -warnaserror`, `oxlint` and `tsc` pass clean (`CLAUDE.md`). The two known open
  warnings stay as they are.
- Work only in a worktree; run each git command on its own. Commit after each task.
- **One new NuGet package:** `Microsoft.Data.Sqlite`, latest 10.0.x, as a `<PackageVersion>` in `Directory.Packages.props`
  and a versionless `<PackageReference>` in `src/Kustodian/Kustodian.csproj`. Its bundled native SQLite rides in the
  single-file publish (`IncludeNativeLibrariesForSelfExtract` is already on). No new npm package.
- **Never record a run that failed, was cancelled, or was cut off** (spec §10.2): record only `state === 'done'`,
  `result.outcome === 'ok'` and `result.total === result.rows.length`. There is no truncation flag; `total` is it.
- **Only `queue()`'s widget runs record.** `runDraft` (the editor preview) never records.
- **Record only when the tab isn't `dirty`** (**my call**): history then always matches a saved definition, and a
  workbook that was never saved leaves nothing behind. The skip line says "save the workbook first".
- **Local only** (spec §10.4): history is never in an exported workbook, never in an error report, and never logged. The
  widget's `history` *setting* is part of the doc and exports like the rest of the author's settings; its data doesn't.
- **Labels say "No longer reported", never "Patched" or "Removed"** (spec §10.1).
- Limits: Values mode at most **500 rows** per snapshot; `history.changes` returns at most **5,000** new and 5,000 gone
  rows, with their full counts (**my call**: the first run makes every key new). Retention **30, 90 or 365** days.
  Interval **run, day or week**; a day is the host's local calendar day.
- Copy, from screens 8 and 9: tab "History"; "Keep history for this widget"; modes "Values over time" and "Row
  tracking"; "Key columns: what makes a row the same row"; "Also keep, to show rows that are gone"; "Save at most"
  (Once a day / Every run / Once a week); "Forget gone rows after" (Values: "Keep snapshots for"); "Clear history…";
  widget filters "Open now", "New since", "No longer reported since", "Both"; Since choices "Previous snapshot",
  "Yesterday", "7 days ago", "30 days ago", "A date…"; change cells "new" and "no longer reported"; columns "First seen"
  and "No longer reported".
- Skip lines (the widget footer, `!` in `--warn`): "Not recorded: the run was cut off at the row limit", "Not recorded:
  the run failed", "Not recorded: over 500 rows. Use Row tracking or summarise the query.", "Not recorded: the key
  columns aren't unique in this result", "Not recorded: save the workbook first".
- Match the surrounding code: `call()` from `web/src/bridge.ts`, `errorText` for errors, the `Rejected` wrapper and
  `BridgeJson.Params<T>` in handlers, `BridgeException(BridgeErrorCodes.BadRequest, …)`, `MenuButton` items with
  `role="menuitem" tabIndex={-1}`, `FakeTimeProvider` in host tests.

## Review Focus

1. **A run that is cut off, failed, cancelled or refused** (`total` 50,000 of 61,200; `outcome: 'tooLarge'`; a
   `failed` run): nothing is sent to `history.record`, nothing in the database changes, so no key is marked gone, and the
   widget shows the matching skip line. Tested in Task 3 (pure) and Task 4 (store).
2. **The query changes.** It's edited in the editor: Apply asks, and Yes clears, No keeps the old query. Or its linked
   saved query is edited in the library: the next record drops the widget's series whose query key differs. Either way no
   old snapshot is compared with the new query. Tested in Tasks 1 and 5.
3. **`history.db` is damaged** (garbage bytes, a truncated file, a failed `quick_check`): it is renamed to
   `history.db.damaged-<yyyyMMddHHmmss>`, a new one starts, the app and the workbook load, and answers carry
   `reset: true` for the rest of the session, so the widget says "History was reset: its file was damaged." Tested in
   Task 1.
4. **Keys repeat or come back.** A key gone on Nov 2 and back on Nov 5 gets a new row first seen Nov 5, and the Nov 2
   row stays as no longer reported. Duplicate keys in one result are refused with nothing written. Tested in Task 1.
5. **Scale and cleanup.** The first Row tracking run of 18,402 keys makes them all new, and `history.changes` returns
   5,000 rows plus the count. Deleting the workbook removes all its series. Retention removes snapshots and gone keys
   older than the setting when a series is saved. Tested in Tasks 1 and 2.

---

## File structure

| File | Responsibility |
| --- | --- |
| `Directory.Packages.props`, `src/Kustodian/Kustodian.csproj` | the `Microsoft.Data.Sqlite` reference. |
| `src/Kustodian/History/HistoryStore.cs` | the database: open and recover, schema, record, read, clear, delete. |
| `src/Kustodian/History/HistoryKeys.cs` | `queryKey` and `seriesKey` from a run's query, parameters and history setting. |
| `src/Kustodian/Bridge/Handlers/HistoryHandler.cs` | the five `history.*` methods; validation. |
| `src/Kustodian/Bridge/Handlers/WorkbookHandler.cs`, `src/Kustodian/App/AppServices.cs` | delete history with the workbook; wiring. |
| `web/src/wire.ts`, `web/src/bridge.mock.ts` | `history.*` types and an in-memory mock. |
| `web/src/workbooks/model.ts` | `WidgetHistory` and its parse. |
| `web/src/workbooks/history.ts` | pure: `recordable`, `historyRows`, `seriesLabel`, `sinceInstant`, `withGaps`, `statChange`; `useHistory`. |
| `web/src/workbooks/workbook-store.ts` | record after a run; skip reasons; Since view state. |
| `web/src/workbooks/history-section.tsx`, `widget-editor.tsx` | the History tab (screen 9); Apply asks on a query change. |
| `web/src/workbooks/widget-frame.tsx` | "Clear history…" in the widget menu; the footer line. |
| `web/src/workbooks/widgets/stat-widget.tsx`, `chart-widget.tsx`, `table-widget.tsx`, `history-table.tsx` | screen 8. |
| `docs/workbooks.md`, `CHANGELOG.md` | docs. |

---

### Task 1: `HistoryStore` and `HistoryKeys`

**Files:**
- Modify: `Directory.Packages.props`, `src/Kustodian/Kustodian.csproj`
- Create: `src/Kustodian/History/HistoryStore.cs`, `src/Kustodian/History/HistoryKeys.cs`
- Test: `tests/Kustodian.Tests/History/HistoryStoreTests.cs`, `tests/Kustodian.Tests/History/HistoryKeysTests.cs`

**Interfaces:**
- Produces (namespace `Kustodian.History`):
  - `public sealed record HistoryQuery(string Source, string Text, JsonElement? Options, IReadOnlyList<HistoryParameter> Parameters);`
    `public sealed record HistoryParameter(string Name, string Value);`
  - `public enum HistoryMode { Values, Rows }`, `public enum HistoryInterval { Run, Day, Week }`
  - `public sealed record HistorySetting(HistoryMode Mode, HistoryInterval Interval, int RetentionDays, IReadOnlyList<string> Keys);`
  - `HistoryKeys.QueryKey(HistoryQuery q, HistorySetting s) -> string` (source, text, options, mode, keys) and
    `HistoryKeys.SeriesKey(HistoryQuery q, HistorySetting s) -> string` (adds the parameters sorted by name): lowercase
    hex SHA-256 of canonical JSON (`JsonSerializer` of a fixed-order record; options re-serialized with sorted
    property names).
  - `public sealed record HistoryColumn(string Name, string Type);`
  - `public sealed record RecordRequest(string WorkbookId, string WidgetId, HistoryQuery Query, HistorySetting Setting, string Label, IReadOnlyList<HistoryColumn> Columns, IReadOnlyList<JsonElement[]> Rows);`
  - `public sealed record RecordAnswer(bool Recorded, string? Skipped, bool Reset);` with `Skipped` one of
    `"interval"`, `"tooManyRows"`, `"keysNotUnique"`.
  - `public sealed record Snapshot(DateTimeOffset TakenAt, IReadOnlyList<HistoryColumn> Columns, IReadOnlyList<JsonElement[]> Rows);`
  - `public sealed record ValuesAnswer(IReadOnlyList<Snapshot> Snapshots, bool Reset);`
  - `public sealed record TrackedRow(JsonElement[] Values, DateTimeOffset FirstSeen, DateTimeOffset? Gone);`
  - `public sealed record ChangesAnswer(DateTimeOffset? Since, IReadOnlyList<HistoryColumn> Columns, IReadOnlyList<TrackedRow> New, int NewCount, IReadOnlyList<TrackedRow> Gone, int GoneCount, int Open, bool Reset);`
  - `public sealed record SeriesInfo(string Label, DateTimeOffset Since, int Snapshots, int Gaps, int Stored);` (Stored:
    snapshot count in Values, tracked key rows in Rows.)
  - `public sealed class HistoryStore(string root, TimeProvider time, ILogger<HistoryStore>? logger = null) : IDisposable` with
    `Task<RecordAnswer> RecordAsync(RecordRequest r, CancellationToken ct)`,
    `Task<ValuesAnswer> ValuesAsync(string workbookId, string widgetId, HistoryQuery q, HistorySetting s, CancellationToken ct)`,
    `Task<ChangesAnswer> ChangesAsync(string workbookId, string widgetId, HistoryQuery q, HistorySetting s, string since, CancellationToken ct)`
    (`since`: `"previous"` or an ISO 8601 instant),
    `Task<IReadOnlyList<SeriesInfo>> SeriesAsync(string workbookId, string widgetId, CancellationToken ct)`,
    `Task ClearAsync(string workbookId, string widgetId, CancellationToken ct)`,
    `Task DeleteWorkbookAsync(string workbookId, CancellationToken ct)`,
    and `public const int MaxValueRows = 500, MaxChangeRows = 5000;`

- [ ] **Step 1: Add the package.** `Microsoft.Data.Sqlite` latest 10.0.x in `Directory.Packages.props`, a versionless
  reference in `Kustodian.csproj`. `dotnet build -warnaserror` passes.
- [ ] **Step 2: Write the failing tests** in `HistoryStoreTests` (the `WorkbookServiceTests` pattern: a temp folder, a
  `FakeTimeProvider` at 2026-11-06 08:00 local, and `SqliteConnection.ClearAllPools()` in `Dispose` before deleting the
  folder):
  - `values_mode_keeps_one_snapshot_per_day_the_latest_wins`: record at 08:00 then 15:00 on the same day, then 08:00
    the next day; `ValuesAsync` gives 2 snapshots, the first holding the 15:00 rows.
  - `values_mode_refuses_more_than_500_rows`: 501 rows → `Recorded: false, Skipped: "tooManyRows"`, nothing stored.
  - `rows_mode_marks_new_and_gone`: day 1 keys {A,B}, day 2 {B,C} → `ChangesAsync(since: "previous")` gives New [C],
    Gone [A] (Gone = day 2 08:00), Open 2.
  - `a_key_that_returns_starts_a_new_first_seen` (Review Focus 4): {A} → {} → {A} over three days; A has two rows, the
    first gone day 2, the second first seen day 3.
  - `duplicate_keys_are_refused_and_nothing_changes` (Review Focus 4): `Skipped: "keysNotUnique"`, the previous state
    is untouched.
  - `rows_mode_applies_at_most_once_per_interval`: a second record the same day → `Skipped: "interval"`, no gone marks.
  - `changes_are_capped_at_5000_with_counts` (Review Focus 5): 6,000 new keys → `New.Count == 5000`, `NewCount == 6000`.
  - `retention_drops_old_snapshots_and_gone_keys`: retention 30, a snapshot and a gone key 31 days old are gone after the
    next record.
  - `a_different_query_key_drops_the_widgets_other_series` (Review Focus 2): record, change `Text`, record again →
    `SeriesAsync` lists only the new series.
  - `each_parameter_combination_is_its_own_series`: the same query with Severity=Critical and Severity=High → two
    `SeriesInfo`, each with its `Label`.
  - `series_counts_gaps_in_daily_values`: snapshots on Nov 1, 2 and 5 → `Snapshots 3, Gaps 2`.
  - `clear_and_delete_workbook_remove_series` (Review Focus 5).
  - `a_damaged_database_is_renamed_and_replaced` (Review Focus 3): write 4 KB of garbage to `history.db`; the first call
    succeeds with `Reset: true`; a `history.db.damaged-20261106080000` file exists; the next store instance on the same
    folder answers `Reset: false`.
  - `HistoryKeysTests`: the parameter order doesn't change `SeriesKey`; a different value does; `QueryKey` ignores
    parameters but not `Keys` or `Mode`; options `{"a":1,"b":2}` and `{"b":2,"a":1}` give the same key.
- [ ] **Step 3: Run** `dotnet test --filter "FullyQualifiedName~History"`. Expected: FAIL (types don't exist).
- [ ] **Step 4: Implement.** Schema, created when `PRAGMA user_version` is 0 and then set to 1:

  ```sql
  CREATE TABLE series (id INTEGER PRIMARY KEY, workbook_id TEXT NOT NULL, widget_id TEXT NOT NULL,
    series_key TEXT NOT NULL, query_key TEXT NOT NULL, mode TEXT NOT NULL, label TEXT NOT NULL,
    columns TEXT NOT NULL, UNIQUE (workbook_id, widget_id, series_key));
  CREATE TABLE snapshots (series_id INTEGER NOT NULL REFERENCES series(id) ON DELETE CASCADE,
    taken_at INTEGER NOT NULL, result TEXT);              -- unix ms; result null in Rows mode
  CREATE INDEX snapshots_by_time ON snapshots (series_id, taken_at);
  CREATE TABLE tracked (series_id INTEGER NOT NULL REFERENCES series(id) ON DELETE CASCADE,
    key TEXT NOT NULL, row TEXT NOT NULL, first_seen INTEGER NOT NULL, gone INTEGER);
  CREATE UNIQUE INDEX tracked_open ON tracked (series_id, key) WHERE gone IS NULL;
  CREATE INDEX tracked_first_seen ON tracked (series_id, first_seen);
  CREATE INDEX tracked_gone ON tracked (series_id, gone);
  ```

  Open with `foreign_keys = ON` and `journal_mode = WAL`; run `PRAGMA quick_check` once per store instance. An
  `SqliteException` on open or a check that isn't `ok` → dispose, `SqliteConnection.ClearAllPools()`, move the file
  (and its `-wal`/`-shm`) aside, start a new one, set `Reset`, and log one line without contents. A key is the JSON
  array of the key columns' values (`Keys` are the first columns of `Columns`; the web sends them first). Each record
  is one transaction: drop the widget's series with another `query_key`, upsert the series, apply the interval rule
  (Values: replace the snapshot in the same local day or week; Rows: skip if the last snapshot is in the same interval),
  write, then apply retention. "previous" in `ChangesAsync` is the snapshot before the latest one. Serialize calls with
  a `SemaphoreSlim`, as `WorkbookService` does.
- [ ] **Step 5: Run** `dotnet test --filter "FullyQualifiedName~History"`. Expected: PASS.
- [ ] **Step 6: Commit** `feat(history): SQLite history store`.

### Task 2: `history.*` on the bridge

**Files:**
- Create: `src/Kustodian/Bridge/Handlers/HistoryHandler.cs`
- Modify: `src/Kustodian/Bridge/Handlers/WorkbookHandler.cs`, `src/Kustodian/App/AppServices.cs`, `web/src/wire.ts`,
  `web/src/bridge.mock.ts`
- Test: `tests/Kustodian.Tests/Bridge/HistoryHandlerTests.cs`

**Interfaces:**
- Consumes: Task 1's `HistoryStore` and records.
- Produces, on the wire (camelCase, `BridgeJson.Options`):
  - `history.record` `{ workbookId, widgetId, query: { source, text, options, parameters: [{name, value}] }, setting:
    { mode: 'values'|'rows', interval: 'run'|'day'|'week', retentionDays, keys }, label, columns: [{name,type}], rows }`
    → `{ recorded, skipped: 'interval'|'tooManyRows'|'keysNotUnique'|null, reset }`
  - `history.values` `{ workbookId, widgetId, query, setting }` → `{ snapshots: [{ takenAt, columns, rows }], reset }`
  - `history.changes` `{ workbookId, widgetId, query, setting, since }` → `{ since, columns, new: [{ values, firstSeen,
    gone }], newCount, gone: [...], goneCount, open, reset }`
  - `history.series` `{ workbookId, widgetId }` → `[{ label, since, snapshots, gaps, stored }]`
  - `history.clear` `{ workbookId, widgetId }` → `null`
  - TS types in `wire.ts`: `HistorySetting`, `HistoryQuery`, `HistoryRecordParams`, `HistoryRecordAnswer`,
    `HistoryValues`, `HistoryChanges`, `TrackedRow`, `HistorySeries`.

- [ ] **Step 1: Write the failing tests** in `HistoryHandlerTests`, driving the handler through a `Bridge` as the other
  handler tests do:
  - `record_refuses_a_bad_request` with each of: a workbook id that isn't a GUID; a widget id over 64 characters or with
    characters outside `[A-Za-z0-9_-]`; mode `"other"`; retention 31; a Rows setting with no keys; a key not in
    `columns`; a source outside `graph|hunting|arg`. Each → `bad_request`, nothing stored.
  - `deleting_a_workbook_deletes_its_history` (Review Focus 5): `workbook.save`, `history.record`, `workbook.delete`
    → `history.series` is empty.
  - `answers_round_trip_in_camel_case`: a record and `history.changes` give `newCount`, `firstSeen` as ISO strings.
- [ ] **Step 2: Run** `dotnet test --filter "FullyQualifiedName~HistoryHandler"`. Expected: FAIL.
- [ ] **Step 3: Implement** `HistoryHandler(HistoryStore history)` with `Register(Bridge bridge)` in the
  `Kustodian.Messaging.Handlers` namespace (as `WorkbookHandler`). Pass `HistoryStore` to `WorkbookHandler`, so
  `workbook.delete` calls `DeleteWorkbookAsync` after `DeleteAsync`. In `AppServices`, build
  `new HistoryStore(store.Root, time, new StderrLogger<HistoryStore>())`, register the handler next to
  `WorkbookHandler`, and dispose the store with the services. Add the five methods to `bridge.mock.ts` over an
  in-memory map, enough for the browser check in Task 7 (Values: keep the latest per call; Rows: new/gone against the
  previous call).
- [ ] **Step 4: Run** `dotnet test --filter "FullyQualifiedName~History"` and, in `web/`, `npm run typecheck`. Expected:
  PASS.
- [ ] **Step 5: Commit** `feat(history): history bridge methods`.

### Task 3: The setting and the pure rules

**Files:**
- Modify: `web/src/workbooks/model.ts`
- Create: `web/src/workbooks/history.ts`
- Test: `web/src/workbooks/model.test.ts`, `web/src/workbooks/history.test.ts`

**Interfaces:**
- Produces:
  - `export interface WidgetHistory { mode: 'values' | 'rows'; interval: 'run' | 'day' | 'week'; retentionDays: 30 | 90 | 365; keys: string[]; keep: string[]; since: string }`
    (`since`: `'previous' | 'P1D' | 'P7D' | 'P30D'` or a `YYYY-MM-DD` date); `Widget.history?: WidgetHistory` (stat,
    chart, table only).
  - `export function defaultHistory(type: WidgetType): WidgetHistory` (table → rows, stat and chart → values; day; 90;
    since `'P7D'`).
  - `export type SkipReason = 'cutOff' | 'failed' | 'tooManyRows' | 'keysNotUnique' | 'unsaved'` and
    `export const SKIP_TEXT: Record<SkipReason, string>` (the Global Constraints copy).
  - `export function recordable(run: WidgetRun, dirty: boolean): SkipReason | null` (null = send it; `'failed'` for a
    `failed` run or `outcome !== 'ok'`; `'cutOff'` when `total > rows.length`; `'unsaved'` when dirty).
  - `export function historyRows(result: RunResult, h: WidgetHistory): { columns: ResultColumn[]; rows: unknown[][] } | 'keysNotUnique'`
    (Values: the whole result, `'tooManyRows'` is the host's to say; Rows: the key columns first, then `keep`, in that
    order; a missing key column → `'keysNotUnique'`; duplicate keys → `'keysNotUnique'`).
  - `export function seriesLabel(params: ResolvedParam[]): string` (`"Severity = Critical, High"`; the shown and
    workbook values only, `", "` between them; `"All values"` when none).
  - `export function sinceInstant(since: string, now: Date): string` (`'previous'` stays `'previous'`; `P1D`/`P7D`/`P30D`
    → that many local days before now, at 00:00 local, ISO; a date → its 00:00 local, ISO).
  - `export function sinceLabel(since: string, at: string | null): string` (`"7 days ago"`, `"Previous snapshot"`,
    `"Oct 30"`).

- [ ] **Step 1: Write the failing tests.**
  - `model.test.ts`: `parses_a_history_setting`; `drops_an_unknown_mode_and_keeps_the_rest_of_the_widget`; an unknown
    retention falls back to 90; `history_on_a_markdown_widget_is_dropped`; a non-string key is dropped.
  - `history.test.ts`:
    - `a_cut_off_run_is_not_recordable` (Review Focus 1): `total: 61200`, 50,000 rows → `'cutOff'`.
    - `a_refused_or_failed_run_is_not_recordable`: `outcome: 'tooLarge'` → `'failed'`; `{ state: 'failed' }` →
      `'failed'`.
    - `an_unsaved_workbook_is_not_recordable`.
    - `row_tracking_sends_keys_first_then_kept_columns`: columns `[CveId, DeviceName, DeviceId]`, keys
      `[DeviceId, CveId]`, keep `[DeviceName]` → columns `[DeviceId, CveId, DeviceName]` with the values moved to match.
    - `duplicate_keys_are_caught_before_sending`.
    - `series_label_lists_the_values`; `since_7_days_is_local_midnight`; `since_a_date`.
- [ ] **Step 2: Run** `npx vitest run src/workbooks/model.test.ts src/workbooks/history.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the parse in `model.ts` next to `stat` and `selection`, and the functions in `history.ts`.
- [ ] **Step 4: Run** the same tests and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(history): widget history setting and record rules`.

### Task 4: Recording after a run

**Files:**
- Modify: `web/src/workbooks/workbook-store.ts`
- Test: `web/src/workbooks/workbook-store.test.ts`

**Interfaces:**
- Consumes: Task 3's `recordable`, `historyRows`, `seriesLabel`; Task 2's `history.record`.
- Produces:
  - `WorkbookState.history: Record<string, { skipped: SkipReason | null; reset: boolean; recordedAt: number | null }>`
    by widget id (view state, never in the doc).
  - `WorkbookState.since: Record<string, string>` by widget id, and the action
    `setSince(tabId: string, widgetId: string, since: string): void` (no rerun; `useHistory` refetches).
  - `queue()`'s `onAnswer` gets a second argument, `sent: { query: HistoryQuery; label: string }`, built from
    `runParams` and `params`. `runDraft` ignores it.

- [ ] **Step 1: Write the failing tests** (add `'history.record'` to the test's bridge switch, answering
  `{ recorded: true, skipped: null, reset: false }`):
  - `a_finished_run_with_history_is_recorded`: one `history.record` with the workbook id, widget id, the run's query
    text, `parameters` as `{name, value}`, the setting, the label and the rows.
  - `a_cut_off_run_is_not_recorded_and_says_why` (Review Focus 1): `total` above the row count → no `history.record`
    call; `history[widgetId].skipped === 'cutOff'`.
  - `a_failed_run_is_not_recorded`: `query.run` rejects → no call, `'failed'`.
  - `a_dirty_workbook_is_not_recorded`: after an `edit`, a run → no call, `'unsaved'`.
  - `the_preview_never_records`: `runDraft` → no `history.record`.
  - `a_widget_without_history_never_records`.
  - `a_record_failure_does_not_break_the_run`: `history.record` rejects → the run stays `done` and the widget shows
    its rows (the record is fire-and-forget with a `catch` that leaves `skipped` null).
  - `host_skips_map_to_reasons`: an answer `skipped: 'tooManyRows'` → `'tooManyRows'`; `'interval'` → null (not a
    problem, just not a new snapshot).
- [ ] **Step 2: Run** `npx vitest run src/workbooks/workbook-store.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Pass `sent` out of `queue()`; in `runWidget`'s `onAnswer`, after `setRun`, call `record(...)`
  when the widget has `history`. Read `dirty` and the doc at answer time, not at queue time.
- [ ] **Step 4: Run** `npx vitest run src/workbooks` and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(history): record widget runs`.

### Task 5: The History tab, the query-change question and Clear history

**Files:**
- Create: `web/src/workbooks/history-section.tsx`
- Modify: `web/src/workbooks/widget-editor.tsx`, `web/src/workbooks/widget-frame.tsx`
- Test: `web/src/workbooks/widget-editor.test.tsx`, `web/src/workbooks/edit-mode.test.tsx`

**Interfaces:**
- Consumes: `defaultHistory`, `history.series`, `history.clear`, the preview's `result.columns` (as `ToolButtonsSection`
  gets them).
- Produces: `export function HistorySection({ draft, columns, set, workbookId }: { draft: Widget; columns: ResultColumn[]; set: (change: (w: Widget) => Widget) => void; workbookId: string })`.
  `Section` gains `'history'`, shown for stat, chart and table; tab "History", after "Tool buttons".

- [ ] **Step 1: Write the failing tests.**
  - `the_history_tab_turns_history_on_with_the_defaults_for_the_type`: a table → Row tracking selected, key columns
    empty; Apply is off until a key is chosen ("Choose at least one key column." under the field).
  - `each_type_offers_only_the_modes_it_can_show`: a chart's Row tracking button is disabled with "Charts plot values
    over time."; a table's Values over time button is disabled with "Tables show tracked rows."; a stat offers both.
  - `key_uniqueness_is_shown_from_the_preview`: preview rows with a duplicate key → "Not unique in the last result";
    unique → "✓ Unique in the last result (3 rows)".
  - `the_series_list_shows_each_parameter_combination`: `history.series` answers two → two rows with label, since,
    snapshots ("31 · 3 gaps") and stored.
  - `applying_a_query_edit_with_history_asks_first` (Review Focus 2): history exists, the query text changed → a
    confirm, "Clear this widget's history?", with "Clear and apply" and "Cancel". Clear → `history.clear` then
    the edit applies; Cancel → the editor stays open, nothing cleared. Changing mode or keys asks the same. No history
    (empty `history.series`) → no question.
  - `clear_history_in_the_widget_menu_asks_and_clears`: `edit-mode.test.tsx` or the view test, "Clear history…" →
    confirm → `history.clear`; the item exists only for a widget with `history`.
- [ ] **Step 2: Run** `npx vitest run src/workbooks/widget-editor.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement** screen 9's left column. The right column's series list comes from `history.series`. Its "Not
  saved" block and "Show history files" are left out (see Architecture and spec §10.4). Use the app's existing confirm
  dialog pattern (as Delete does in `workbook-view.tsx`).
- [ ] **Step 4: Run** `npx vitest run src/workbooks` and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(history): history tab and clearing`.

### Task 6: History in the widgets

**Files:**
- Modify: `web/src/workbooks/history.ts`, `web/src/workbooks/widgets/stat-widget.tsx`,
  `web/src/workbooks/widgets/chart-widget.tsx`, `web/src/workbooks/widgets/table-widget.tsx`,
  `web/src/workbooks/widget-frame.tsx`
- Create: `web/src/workbooks/widgets/history-table.tsx`
- Test: `web/src/workbooks/history.test.ts`, `web/src/workbooks/widgets/history-widgets.test.tsx`

**Interfaces:**
- Consumes: Tasks 2–4.
- Produces:
  - `export function useHistory(tabId: string, widget: Widget, run: WidgetRun): { values?: HistoryValues; changes?: HistoryChanges; error?: string }`
    (fetches after each `done` run, keyed by `finishedAt` and the widget's Since; ignores an answer that arrives after a
    newer request).
  - `export function withGaps(snapshots: HistoryValues['snapshots'], interval: WidgetHistory['interval']): { columns: ResultColumn[]; rows: unknown[][] }`
    (one table with a leading `Snapshot` datetime column; for `day`, a row of nulls on each missing day, so the chart
    draws a gap; `run` and `week` add none).
  - `export function statChange(h: HistoryValues, valueColumn: string, since: string, now: Date): { text: string; at: string } | null`
    (`"▲ 37 vs 7 days ago (375)"`; `▼` for a fall; null when there's no snapshot at or before the point).

- [ ] **Step 1: Write the failing tests.**
  - `history.test.ts`: `with_gaps_inserts_a_null_row_per_missing_day`; `stat_change_compares_with_the_snapshot_at_or_before_the_point`;
    `stat_change_is_null_without_an_old_enough_snapshot`.
  - `history-widgets.test.tsx`:
    - `a_stat_with_values_history_shows_the_change`: "412", "▲ 37 vs 7 days ago (375)", footer "Daily · 34 days".
    - `a_stat_with_row_tracking_counts_new_and_gone`: "1,206", "23 new · 41 no longer reported since Oct 30".
    - `a_chart_with_history_plots_snapshots`: `ChartView` gets `x: 'Snapshot'` and the gap rows.
    - `a_tracked_table_filters_by_change`: Open now shows the run's rows; New since shows the `new` rows with Change
      "new" and First seen; No longer reported since shows Change "no longer reported" and that column; Both shows
      both; counts in the filter buttons; "Showing 5,000 of 6,000" when capped.
    - `changing_since_refetches`: choosing "Previous snapshot" → one more `history.changes` with `since: 'previous'`.
    - `the_footer_shows_the_skip_reason`: `skipped: 'cutOff'` → "! Not recorded: the run was cut off at the row limit".
    - `a_reset_database_is_said_once_per_widget`: `reset: true` → "History was reset: its file was damaged."
    - `the_labels_never_say_patched_or_removed`: no "Patched" or "Removed" text anywhere in the rendered widgets.
- [ ] **Step 2: Run** `npx vitest run src/workbooks/widgets src/workbooks/history.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** screen 8. The chart reuses `ChartView` with `withGaps(...)` and
  `picked = { ...widget.chart, x: 'Snapshot' }`; Recharts leaves gaps at nulls by default (no `connectNulls`). The
  tracked table reuses `result-grid` as `TableWidget` does, with the Change, First seen and No longer reported columns
  added. Selection and tool buttons apply to Open now only (**my call**: the other filters show history rows, which a
  tool can't act on).
- [ ] **Step 4: Run** `npx vitest run src/workbooks` and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(history): history in stat, chart and table widgets`.

### Task 7: Docs and full check

**Files:**
- Modify: `docs/workbooks.md` (a `## History` section after `## Selection and tool buttons`), `CHANGELOG.md` (Unreleased
  → Added)

- [ ] **Step 1: Write the docs.** `## History`: the two modes with the passkey and TVM examples from spec §10.1; when a
  snapshot is taken and what is never recorded; one history per parameter combination; what asks before clearing;
  where it is stored (`history.db` in the data folder, local only, never exported); "No longer reported" and why.
- [ ] **Step 2: CHANGELOG** line under Added, in the style of the Workbooks lines.
- [ ] **Step 3: Run the full check:** `dotnet build -warnaserror` and `dotnet test`, then in `web/`: `npm run lint`,
  `npm run typecheck`, `npm test`, `npm run build`. Expected: all pass; the only warnings are the two known ones.
- [ ] **Step 4: Browser check on the mock bridge:** a Table widget with Row tracking on keys `DeviceId, CveId`, run
  twice with different mock rows → New since and No longer reported since show the difference; a Stat with Values shows
  a change; a cut-off mock result shows the skip line.
- [ ] **Step 5: Publish check:** `tools/release/publish.sh` for the current platform builds one executable, and starting
  it creates `history.db` the first time a widget with history runs.
- [ ] **Step 6: Commit** `docs: workbook history`.
