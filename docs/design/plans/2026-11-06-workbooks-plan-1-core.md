# Workbooks, plan 1: core — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A user can create a workbook tab, place and size Markdown, Chart, Table and Stat widgets on a grid, back each data
widget with an inline or a linked saved query on any source, drive them with workbook and widget parameters, and save the
workbook to the library.

**Architecture:**

- **Host.** `WorkbookService` keeps `workbooks/<id>.json` as an opaque JSON document it validates only at the edges (kind,
  version, id, name, folder, size, widget count) and lists as summaries; remembered parameter values go in
  `workbook-values/<id>.json`. `WorkbookHandler` exposes `workbook.*`. `query.run` gains `addToRecent`. Session tabs gain a
  `workbook` document. `app.openLink` opens an `https` link in the system browser.
- **Web.** `web/src/workbooks/`: a pure model (types, parse, defaults), pure parameter resolution and layout math, a zustand
  store per workbook tab (view values, results, run queue, undo), and the views: workbook view, widget frame, the four
  widgets, edit mode, widget editor and parameters dialog. Widgets wrap the existing `ChartView`, `ResultGrid`, `KqlEditor`
  and `RunStatus`.
- **Not in this plan:** selection and tool buttons (plan 2), export and import (plan 3), everything marked v2 in the spec.

**Tech Stack:** .NET 10, xUnit v3, React 19 + TypeScript, zustand, Vitest + Testing Library, oxlint, and `react-markdown`
^10.1.0 (MIT; added by the owner's decision, already in `web/package.json`). No other new dependencies.

**Spec:** `docs/design/specs/2026-11-06-workbooks-design.md` (§5–§7, §9.1–§9.2, §11–§12 and the v1 list in §11). Read it
first; this plan argues from it. Mockups: screens 1–4 of the canvas linked from the spec.

## Global Constraints

- No warning suppressions: `dotnet build -warnaserror`, `oxlint` and `tsc` pass clean (`CLAUDE.md`). The two known open
  warnings stay as they are.
- Work only in this worktree; run each git command on its own. Commit after each task.
- No new npm or NuGet dependency beyond `react-markdown` (**Owner**). Grid drag and resize use pointer events and CSS
  grid. If a task seems to need another, stop and ask the owner.
- Markdown goes through `react-markdown` only, with raw HTML off (no `rehype-raw`) and its default `urlTransform`; never
  `dangerouslySetInnerHTML` (**Owner**: no hand-rolled Markdown).
- Results are never written to disk or into the workbook file (spec §7).
- A workbook file holds the author's defaults; view-mode values never mark the workbook dirty (spec §5.2).
- Parameter syntax and substitution are the existing ones: `{name}`, `ParameterDef`, `ParameterValue`, substituted by the
  host's `ParameterSubstitution`. Nothing in this plan builds KQL text from a value.
- Grid: 12 columns, 8 px rows, 12 px gaps (spec §5.2).
- Numbers (**plan's call** where the spec leaves them to the builder): a workbook file at most 2 MiB, at most 100 widgets;
  minimum widget sizes markdown 2 × 3, stat 2 × 6, table 3 × 8, chart 3 × 12; at most 3 running widgets per source; text
  parameter reruns 400 ms after the last keystroke or on Enter; below 900 px of grid width every widget is full width in
  `(y, x)` order; undo keeps 50 steps.
- Copy in the UI uses the spec's wording: "Workbook", "Widget · shown", "Fixed", "Copy into widget", "Open in tab",
  "Refresh all", "Needs a value before the widget runs."
- Match the surrounding code: XML doc comments on public C# types, the existing comment density, `call()` from
  `web/src/bridge.ts`, `errorText`/`reportIdOf` for errors, `BridgeException(BridgeErrorCodes.BadRequest, …)` for refusals.

## Review Focus

1. **A linked saved query was deleted or renamed** while the workbook was closed: the widget shows "This saved query is
   gone" with "Copy the last text into the widget", and the rest of the workbook runs. Tested in Task 8.
2. **A parameter changes while widgets are still running** (fast typing, several selects): stale results never overwrite
   newer ones; only the latest run per widget lands. Tested in Task 8.
3. **A hand-edited or damaged workbook file** (wrong kind, missing `widgets`, a widget with an unknown type, overlapping
   layouts): the host moves a file it can't read aside, and the web parse drops unknown widgets and repairs overlaps
   instead of failing the whole workbook. Tested in Tasks 1 and 5.
4. **A parameter name used by a widget but not defined anywhere** (typo in a query, `{Tmerange}`): the widget treats it as
   **Widget · shown** with an empty value and says it needs a value, rather than running with `{Tmerange}` in the text.
   Tested in Task 6.
5. **Closing a workbook tab with unsaved edit-mode changes, or the app restarting**: the close asks, and a restart restores
   the unsaved document from the session. Tested in Tasks 4 and 9.

---

## File structure

| File | Responsibility |
| --- | --- |
| `src/Kustodian/Workbooks/WorkbookService.cs` | `workbooks/` and `workbook-values/` on disk; validation at the edges. |
| `src/Kustodian/Bridge/Handlers/WorkbookHandler.cs` | `workbook.list/get/save/delete`, `workbook.values.get/save`. |
| `src/Kustodian/Bridge/Handlers/AppHandler.cs` | adds `app.openLink`. |
| `src/Kustodian/Bridge/Handlers/QueryHandler.cs` | `addToRecent` on `query.run`. |
| `src/Kustodian/Session/SessionService.cs` | `SessionTab.Workbook`. |
| `src/Kustodian/App/AppServices.cs` | wiring. |
| `web/src/workbooks/model.ts` | types, `parseWorkbook`, `newWorkbook`, `newWidget`, `isoTimespan`. |
| `web/src/workbooks/resolve.ts` | parameter resolution and which widgets a change reruns. |
| `web/src/workbooks/layout.ts` | placement, compaction, move, resize, narrow order. |
| `web/src/workbooks/workbook-store.ts` | per-tab view state, results, run queue, undo. |
| `web/src/workbooks/workbook-view.tsx` | toolbar, parameter bar, grid; view and edit mode. |
| `web/src/workbooks/widget-frame.tsx` | header, widget parameter controls, status, menu, edit handles. |
| `web/src/workbooks/widgets/{markdown,chart,table,stat}-widget.tsx` | the four widgets. |
| `web/src/workbooks/widget-editor.tsx` | Query, Parameters and Visualization tabs. |
| `web/src/workbooks/parameters-dialog.tsx` | workbook parameters. |
| `web/src/workbooks/save-workbook-dialog.tsx` | name and folder on first save. |
| `web/src/wire.ts`, `web/src/bridge.mock.ts` | wire types and mock answers for every new method. |
| `web/src/tabs/tab-store.ts`, `web/src/session/session-sync.ts`, `web/src/tabs/tab-strip.tsx`, `web/src/app.tsx`, `web/src/side/saved-panel.tsx` | workbook tabs. |

---

### Task 1: `WorkbookService`

**Files:**
- Create: `src/Kustodian/Workbooks/WorkbookService.cs`
- Test: `tests/Kustodian.Tests/Workbooks/WorkbookServiceTests.cs`

**Interfaces:**
- Consumes: `JsonFileStore`, `TimeProvider`, the pattern of `LibraryService` (one `SemaphoreSlim` gate, `*.corrupt` move-aside,
  `LibraryRejectedException`-style refusals).
- Produces:
  - `public sealed record WorkbookSummary(string Id, string Name, string? Folder, DateTimeOffset ModifiedAt, int Widgets);`
  - `public sealed record WorkbookList(IReadOnlyList<WorkbookSummary> Workbooks, IReadOnlyList<string> Folders, int Skipped);`
  - `public sealed class WorkbookRejectedException(string message) : Exception(message);`
  - `public sealed class WorkbookService(JsonFileStore store, TimeProvider time, ILogger<WorkbookService>? logger = null)` with
    `const string Folder = "workbooks"`, `const string ValuesFolder = "workbook-values"`, `const int MaxBytes = 2 << 20`,
    `const int MaxWidgets = 100`, and
    `Task<WorkbookList> ListAsync(CancellationToken)`,
    `Task<JsonObject?> GetAsync(string id, CancellationToken)`,
    `Task<JsonObject> SaveAsync(JsonObject workbook, CancellationToken)` (returns what was written, with `modifiedAt` set),
    `Task DeleteAsync(string id, CancellationToken)` (deletes its values file too),
    `Task<JsonObject> GetValuesAsync(string id, CancellationToken)` (empty object when none),
    `Task SaveValuesAsync(string id, JsonObject values, CancellationToken)`.

- [ ] **Step 1: Write the failing tests** in `WorkbookServiceTests` (temp-folder `JsonFileStore`, `FakeTimeProvider`):
  - `Save_then_get_round_trips_the_document_and_sets_modifiedAt`: save `{kind:"kustodian.workbook",version:1,id:<guid>,name:"VM hygiene",folder:null,parameters:[],widgets:[]}`, get by id; every field equal, `modifiedAt` = the fake time in ISO 8601.
  - `Save_keeps_fields_it_does_not_know`: a `widgets[0].chart.stack` value and an unknown top-level `"x-note"` survive the round trip.
  - `Save_refuses` (theory): kind `"other"` → "This isn't a Kustodian workbook."; version `2` → "This workbook needs a newer Kustodian."; id not a GUID; name `""` or 201 characters; folder `"a/b"`, `""` or 81 characters; `widgets` missing or not an array; 101 widgets; serialized size over `MaxBytes`. Each throws `WorkbookRejectedException` and writes nothing.
  - `List_returns_summaries_sorted_by_name_then_id_and_distinct_folders`.
  - `List_moves_an_unreadable_file_aside_and_counts_it`: write `workbooks/<id>.json` with `not json` and one whose `id` differs from its file name; both end as `*.corrupt`, `Skipped == 2`.
  - `Delete_removes_the_workbook_and_its_values`; `Delete_of_a_missing_id_does_nothing`.
  - `Values_round_trip_and_default_to_empty`.

- [ ] **Step 2: Run them to see them fail**

Run: `dotnet test tests/Kustodian.Tests --filter WorkbookServiceTests`
Expected: FAIL (types not defined).

- [ ] **Step 3: Implement `WorkbookService`** as above. Validation reads only `kind`, `version`, `id`, `name`, `folder` and the
  `widgets` array length; ids are normalized with `Guid.Parse(...).ToString("D")` like `LibraryService.NormalizeId`; name and
  folder limits are `LibraryService.MaxNameLength` / `MaxFolderLength` and the same "no `/`" folder rule.

- [ ] **Step 4: Run the tests to see them pass**

Run: `dotnet test tests/Kustodian.Tests --filter WorkbookServiceTests`
Expected: PASS.

- [ ] **Step 5: Commit** — `feat: workbook storage`

### Task 2: `workbook.*` bridge methods

**Files:**
- Create: `src/Kustodian/Bridge/Handlers/WorkbookHandler.cs`
- Modify: `src/Kustodian/App/AppServices.cs` (construct `WorkbookService`, register the handler next to `LibraryHandler`)
- Modify: `web/src/wire.ts`, `web/src/bridge.mock.ts`
- Test: `tests/Kustodian.Tests/Bridge/WorkbookHandlerTests.cs`

**Interfaces:**
- Consumes: Task 1.
- Produces (bridge):
  - `workbook.list` → `WorkbookList`
  - `workbook.get {id}` → `{ workbook: object | null }`
  - `workbook.save {workbook}` → `{ workbook: object }`; `WorkbookRejectedException` → `bad_request` with its message
  - `workbook.delete {id}` → `null`
  - `workbook.values.get {id}` → `{ values: Record<string, string> }`; `workbook.values.save {id, values}` → `null`
- Produces (web, `wire.ts`): `WorkbookSummary`, `WorkbookList` mirroring Task 1 (`modifiedAt: string`).

- [ ] **Step 1: Write the failing tests** in `WorkbookHandlerTests`, the way `LibraryHandlerTests` drives a `Bridge`: each
  method round-trips; `workbook.save` without `workbook`, or with a refused one, answers `bad_request` with the message;
  `workbook.get` of an unknown id answers `{ workbook: null }`.
- [ ] **Step 2: Run** `dotnet test tests/Kustodian.Tests --filter WorkbookHandlerTests` — Expected: FAIL.
- [ ] **Step 3: Implement** `WorkbookHandler(WorkbookService workbooks).Register(Bridge)`; register it in `AppServices`.
  Add the wire types and in-memory mock cases to `bridge.mock.ts` (a `Map` of workbooks and of values).
- [ ] **Step 4: Run** the host tests and `npm run typecheck` in `web/` — Expected: PASS.
- [ ] **Step 5: Commit** — `feat: workbook bridge methods`

### Task 3: `query.run` without Recent

**Files:**
- Modify: `src/Kustodian/Bridge/Handlers/QueryHandler.cs` (`RunParams` gains `bool AddToRecent = true`; Recent is skipped when false)
- Modify: `web/src/wire.ts` (`QueryRunParams.addToRecent?: boolean`)
- Test: the existing `QueryHandler` tests file (find it with `grep -rl "query.run" tests/Kustodian.Tests`)

**Interfaces:**
- Produces: `query.run { …, addToRecent: false }` runs without adding to Recent. Omitted means `true`, as today.

- [ ] **Step 1: Write the failing test** `Run_with_addToRecent_false_is_not_added_to_Recent` next to the existing test that
  checks a finished run is added; assert `RecentService.ListAsync` is empty afterwards.
- [ ] **Step 2: Run it** — Expected: FAIL (the run is in Recent).
- [ ] **Step 3: Implement** the flag; update the class doc comment's sentence on Recent.
- [ ] **Step 4: Run** the `QueryHandler` tests — Expected: PASS, including the existing Recent test.
- [ ] **Step 5: Commit** — `feat: query.run can skip Recent`

### Task 4: Workbook tabs in the session (host)

**Files:**
- Modify: `src/Kustodian/Session/SessionService.cs`
- Test: `tests/Kustodian.Tests/Session/` (the existing session tests file)

**Interfaces:**
- Produces: `SessionTab` gains `JsonObject? Workbook = null` (last positional parameter). A tab with `Source == "workbook"`
  keeps its document there; `Text` is `""` for it. The per-tab cap `MaxTextBytes` applies to the serialized workbook too;
  a workbook tab over it is dropped and counted like an oversized text tab.

- [ ] **Step 1: Write the failing tests:** `A_workbook_tab_round_trips_with_its_document`;
  `A_workbook_tab_over_the_cap_is_dropped_and_counted`; `A_tab_without_workbook_reads_as_before` (an old `session.json`
  without the field still reads).
- [ ] **Step 2: Run** the session tests — Expected: FAIL.
- [ ] **Step 3: Implement.** `IsValid` additionally requires `Workbook` non-null when `Source == "workbook"`.
- [ ] **Step 4: Run** the session tests — Expected: PASS.
- [ ] **Step 5: Commit** — `feat: workbook tabs in the session`

### Task 5: Web model

**Files:**
- Create: `web/src/workbooks/model.ts`, `web/src/workbooks/model.test.ts`

**Interfaces:**
- Consumes: `Source`, `ParameterDef`, `QueryOptions` (`wire.ts`); `Picked` (`results/chart-view.tsx`, type-only import).
- Produces:

```ts
export const WORKBOOK_KIND = 'kustodian.workbook';
export const WORKBOOK_VERSION = 1;
export type WidgetType = 'markdown' | 'chart' | 'table' | 'stat';
export interface WidgetLayout { x: number; y: number; w: number; h: number }
export type ParamFrom = 'workbook' | 'widget' | 'fixed';
export interface WidgetParam { from: ParamFrom; value: string }
export interface WidgetQuery {
  source: Exclude<Source, 'raw'>;
  text: string;
  options: QueryOptions | null;
  parameters: ParameterDef[];
  /** Set for a linked saved query; text, source, options and parameters are then the last copy of it (spec §9.2). */
  saved: { id: string; name: string } | null;
}
export interface Widget {
  id: string;
  type: WidgetType;
  title: string;
  layout: WidgetLayout;
  markdown?: string;
  query?: WidgetQuery;
  parameters: Record<string, WidgetParam>;
  chart?: Picked;
  stat?: { value: string | null; compare: string | null };
}
export interface WorkbookParameter extends ParameterDef {
  label: string | null;
  multi: boolean;
  all: boolean;
  remember: boolean;
  huntingTimespan: boolean;
}
export interface WorkbookDoc {
  kind: typeof WORKBOOK_KIND;
  version: typeof WORKBOOK_VERSION;
  id: string;
  name: string;
  folder: string | null;
  parameters: WorkbookParameter[];
  widgets: Widget[];
  modifiedAt?: string;
}
export const MIN_SIZE: Record<WidgetType, { w: number; h: number }>; // markdown 2×3, stat 2×6, table 3×8, chart 3×12
export function newWorkbook(name: string): WorkbookDoc;           // id from crypto.randomUUID()
export function newWidget(type: WidgetType, layout: WidgetLayout): Widget; // id 'w' + 8 hex; data widgets get an empty graph query
export function parseWorkbook(json: unknown): WorkbookDoc | string; // string = what is wrong, as the user is told it
export function isoTimespan(kql: string): string | null;
```

- [ ] **Step 1: Write the failing tests:**
  - `parseWorkbook` returns a doc for the spec §9.2 example (minus `selection` and `tools`, which it keeps untouched as
    extra fields); returns `"This isn't a Kustodian workbook."` for another kind and `"This workbook needs a newer Kustodian."`
    for version 2; drops a widget with type `"map"` and keeps the rest; fills missing `parameters: {}`, `title: ''`;
    clamps a layout to the grid (`x + w ≤ 12`, `w ≥ MIN_SIZE`); a widget whose `query.source` is `'raw'` is dropped.
  - `isoTimespan`: `'7d'→'P7D'`, `'12h'→'PT12H'`, `'90m'→'PT90M'`, `'45s'→'PT45S'`, `'1.5d'→'PT36H'`, `'30d'→'P30D'`,
    `'31d'→null`, `'7 days'→null`, `''→null`. (The host accepts at most 30 days; the pattern is the host's
    `^[0-9]+(\.[0-9]+)?(d|h|m|s|ms)$`.)
  - `newWidget('chart', …)` has `query.source === 'graph'`, `query.saved === null`, `parameters` empty.
- [ ] **Step 2: Run** `npx vitest run src/workbooks/model.test.ts` in `web/` — Expected: FAIL.
- [ ] **Step 3: Implement.** `isoTimespan` converts to whole seconds and writes the largest whole unit: days `P{n}D`, else
  `PT{n}H`, `PT{n}M`, `PT{n}S`; `ms` rounds up to seconds.
- [ ] **Step 4: Run** the tests — Expected: PASS.
- [ ] **Step 5: Commit** — `feat: workbook model`

### Task 6: Parameter resolution

**Files:**
- Create: `web/src/workbooks/resolve.ts`, `web/src/workbooks/resolve.test.ts`

**Interfaces:**
- Consumes: Task 5; `findParams` (`params/find-params.ts`); `ParameterValue` (`wire.ts`).
- Produces:

```ts
/** Current values: the workbook's by parameter name, and each widget's shown/fixed ones by widget id. Never in the file. */
export interface ViewValues { workbook: Record<string, string>; widgets: Record<string, Record<string, string>> }
export interface ResolvedParam { name: string; type: string; value: string; required: boolean; from: ParamFrom }
export function widgetParams(doc: WorkbookDoc, widget: Widget, values: ViewValues): ResolvedParam[];
export function missingRequired(params: ResolvedParam[]): string[];
export function toParameterValues(params: ResolvedParam[]): ParameterValue[];
/** Widgets a change to workbook parameter `name` reruns: data widgets whose resolved `name` comes from the workbook. */
export function widgetsUsing(doc: WorkbookDoc, name: string): string[];
/** The hunting timespan a widget sends: the huntingTimespan parameter's ISO value, else the widget's own options. */
export function widgetRunOptions(doc: WorkbookDoc, widget: Widget, values: ViewValues): QueryOptions | null | { problem: string };
export function initialValues(doc: WorkbookDoc, remembered: Record<string, string>): ViewValues;
```

- [ ] **Step 1: Write the failing tests:**
  - A placeholder with a workbook parameter of the same name and no widget entry resolves `from: 'workbook'` with the
    current workbook value.
  - A widget entry `{from:'widget', value:'1h'}` wins over the workbook parameter; the current widget value in
    `values.widgets[id]` wins over the entry's default.
  - `{from:'fixed'}` uses the entry's value and ignores `values.widgets`.
  - A placeholder with no workbook parameter and no widget entry resolves `from: 'widget'`, type from
    `query.parameters` (else `'text'`), value from it (else `''`); with `required` true it is listed by `missingRequired`.
    `{Tmerange}` with nothing defined: `from 'widget'`, value `''`, not required — `missingRequired` empty, and the widget
    runs with an empty text value, not the literal placeholder (Review Focus 4).
  - `widgetsUsing(doc, 'TimeRange')` lists widgets that take it from the workbook, not ones set to widget or fixed, and
    never Markdown widgets.
  - `widgetRunOptions`: a hunting widget with a `huntingTimespan` parameter `7d` → `{ timespan: 'P7D', scope: null }`; value `45d`
    → `{ problem: 'TimeRange: at most 30 days for Defender hunting.' }`; a Graph widget → `null`; an ARG widget → its own
    `options` with the source's default (reuse `runOptions` from `tabs/tab-store.ts` for the defaults).
  - `initialValues` takes a remembered value only for parameters with `remember: true`, else the default.
- [ ] **Step 2: Run** `npx vitest run src/workbooks/resolve.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** — `feat: workbook parameter resolution`

### Task 7: Layout math

**Files:**
- Create: `web/src/workbooks/layout.ts`, `web/src/workbooks/layout.test.ts`

**Interfaces:**
- Consumes: `WidgetLayout`, `Widget`, `MIN_SIZE` (Task 5).
- Produces:

```ts
export const COLUMNS = 12;
export const ROW_PX = 8;
export const GAP_PX = 12;
export const NARROW_PX = 900;
export function overlaps(a: WidgetLayout, b: WidgetLayout): boolean;
/** Moves every widget up as far as it goes without overlapping, in (y, x) order; overlapping input is pushed down first. */
export function compact(widgets: Widget[]): Widget[];
export function move(widgets: Widget[], id: string, x: number, y: number): Widget[];   // clamps, pushes others down, compacts
export function resize(widgets: Widget[], id: string, w: number, h: number): Widget[]; // clamps to MIN_SIZE and the grid
/** Where a new w × h widget goes: the first free spot scanning rows top-down, else below everything. */
export function place(widgets: Widget[], w: number, h: number): WidgetLayout;
export function narrowOrder(widgets: Widget[]): Widget[];
```

- [ ] **Step 1: Write the failing tests:** two overlapping widgets after `compact` don't overlap and keep their order;
  a gap above a widget closes; `move` to `x: 11` of a `w: 4` widget clamps to `x: 8`; moving onto another pushes it down;
  `resize` below `MIN_SIZE.chart` clamps to 3 × 12; `place` finds the right-hand hole next to a `w: 8` widget for a `w: 4`
  one; `narrowOrder` sorts by `(y, x)`.
- [ ] **Step 2: Run** `npx vitest run src/workbooks/layout.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.** Pure functions returning new arrays; never mutate input.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** — `feat: workbook grid layout`

### Task 8: Workbook store

**Files:**
- Create: `web/src/workbooks/workbook-store.ts`, `web/src/workbooks/workbook-store.test.ts`

**Interfaces:**
- Consumes: Tasks 5–7; `call` (`bridge.ts`); `RunResult` (`wire.ts`); `library.list`; `workbook.values.get/save`.
- Produces a zustand store keyed by tab id:

```ts
export type WidgetRun =
  | { state: 'idle' }
  | { state: 'waiting' }
  | { state: 'running'; runId: string; startedAt: number }
  | { state: 'done'; result: RunResult }
  | { state: 'blocked'; reason: string }   // a required value is missing, or widgetRunOptions gave a problem
  | { state: 'gone' }                       // the linked saved query no longer exists
  | { state: 'failed'; error: unknown };
export interface WorkbookState {
  doc: WorkbookDoc;
  values: ViewValues;
  runs: Record<string, WidgetRun>;
  editing: boolean;
  undo: WorkbookDoc[];
  redo: WorkbookDoc[];
}
export interface WorkbookActions {
  load(tabId: string, doc: WorkbookDoc): Promise<void>;   // reads remembered values and the library, then runAll
  unload(tabId: string): void;                             // cancels its runs
  runWidget(tabId: string, widgetId: string, opts?: { refresh?: boolean }): Promise<void>;
  runAll(tabId: string, opts?: { refresh?: boolean }): Promise<void>;
  setWorkbookValue(tabId: string, name: string, value: string, opts?: { now?: boolean }): void; // reruns widgetsUsing; text is debounced unless now
  setWidgetValue(tabId: string, widgetId: string, name: string, value: string): void; // reruns that widget
  edit(tabId: string, change: (doc: WorkbookDoc) => WorkbookDoc): void; // pushes undo, marks the tab dirty (Task 9)
  undoEdit(tabId: string): void;
  redoEdit(tabId: string): void;
  setEditing(tabId: string, editing: boolean, discard?: boolean): void;
  saveValuesAsDefaults(tabId: string): void;
  copySavedIntoWidget(tabId: string, widgetId: string): void;
}
export const useWorkbooks: UseBoundStore<StoreApi<{ byTab: Record<string, WorkbookState> } & WorkbookActions>>;
export const MAX_RUNNING_PER_SOURCE = 3;
export const TEXT_DEBOUNCE_MS = 400;
export const UNDO_STEPS = 50;
```

  Runs call `query.run` with `tabId: `${tabId}/${widgetId}``, `runId: crypto.randomUUID()`, `source`, `kql: query.text`,
  `parameters: toParameterValues(...)`, `options`, `refresh`, `addToRecent: false`. A linked widget runs the library's text,
  source, options and parameters (from `library.list`, read once in `load` and again on `runAll` with `refresh`), and
  `edit` refreshes the widget's copy from it when the workbook is saved (Task 9).

- [ ] **Step 1: Write the failing tests** (mock bridge; fake timers):
  - `runAll` runs every data widget; with 4 hunting widgets only 3 are `running` at once and the 4th is `waiting`.
  - Changing a workbook value reruns only `widgetsUsing`; a text value reruns once, 400 ms after the last change; Enter
    (`setWorkbookValue(…, { now: true })`) reruns at once.
  - **Review Focus 2:** two quick changes; the first run's answer arrives after the second's; the widget ends with the
    second result.
  - A widget with a missing required value is `blocked` with "Needs a value before the widget runs." and isn't sent.
  - **Review Focus 1:** a linked widget whose saved id isn't in `library.list` is `gone`; the others run;
    `copySavedIntoWidget` sets `saved: null`, keeps the copied text and the widget then runs.
  - `edit` then `undoEdit` restores the doc; 51 edits keep 50 undo steps; `setEditing(false, true)` (discard) restores the
    doc as it was when editing started.
  - `setWorkbookValue` doesn't change `doc`; `saveValuesAsDefaults` copies `values.workbook` into the parameters' `value`
    and the widget values into their entries, through `edit`.
  - Values of parameters with `remember: true` are written with `workbook.values.save` (debounced like text values).
- [ ] **Step 2: Run** `npx vitest run src/workbooks/workbook-store.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.** Keep the latest `runId` per widget and ignore answers for any other (`query.cancel` with the
  widget's run tab id cancels the old one).
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** — `feat: workbook state and runs`

### Task 9: Workbook tabs in the app

**Files:**
- Modify: `web/src/wire.ts` (`export type TabSource = Source | 'workbook'`; `SessionTab.source: TabSource`;
  `SessionTab.workbook?: WorkbookDoc | null`)
- Modify: `web/src/tabs/tab-store.ts` (`Tab.source: TabSource`; `Tab.workbook?: WorkbookDoc`; `openWorkbook`, `setWorkbook`)
- Modify: `web/src/session/session-sync.ts` (snapshot and restore the document)
- Modify: `web/src/tabs/tab-strip.tsx` (a "New workbook" item in the + menu; a workbook icon in place of the source badge;
  no source switcher on a workbook tab)
- Modify: `web/src/side/saved-panel.tsx` (a "Workbooks" group from `workbook.list`: open, delete through the row menu)
- Create: `web/src/workbooks/save-workbook-dialog.tsx` (name and folder, `MAX_NAME_LENGTH`/`MAX_FOLDER_LENGTH` and the
  folder list from `library/saving.ts`)
- Modify: `web/src/app.tsx` (Ctrl/⌘+S, `file.save` and the palette's "New workbook" command route to the workbook for a
  workbook tab; the close confirmation covers a dirty workbook)
- Test: `web/src/tabs/tab-store.test.ts`, `web/src/session/session-sync.test.ts`, `web/src/side/saved-panel.test.tsx`

**Interfaces:**
- Consumes: Tasks 2, 4, 5, 8.
- Produces:
  - `openWorkbook(doc: WorkbookDoc, opts?: { savedId?: string; dirty?: boolean }): string` — the tab id; reuses an open tab
    with the same `doc.id`.
  - `setWorkbook(id: string, doc: WorkbookDoc, dirty: boolean): void`.
  - `saveWorkbook(tabId: string): Promise<void>` in `workbooks/workbook-store.ts` — refreshes linked copies, then
    `workbook.save`; asks for name and folder through `SaveWorkbookDialog` on the first save; marks the tab saved.
- Every place `tsc` now flags as passing a `TabSource` where a `Source` is needed treats a workbook tab as not a query tab
  (as `'raw'` is treated today: no toolbar, editor, schema insert, params or explain). `schemaSourceOf('workbook')` is
  `'graph'`.

- [ ] **Step 1: Write the failing tests:** `openWorkbook` twice with the same doc id activates the first tab; a
  workbook tab survives `restore(snapshot())` with its document and dirty flag (Review Focus 5); a dirty workbook tab
  asks before closing (the existing close-confirmation test, with a workbook tab); the saved panel lists workbooks and
  opening one calls `workbook.get` and `openWorkbook`.
- [ ] **Step 2: Run** `npx vitest run src/tabs src/session src/side` — Expected: FAIL.
- [ ] **Step 3: Implement**, fixing every `tsc` error the new `TabSource` raises by excluding workbook tabs the way raw
  tabs are excluded.
- [ ] **Step 4: Run** `npm run typecheck && npm test` in `web/` — Expected: PASS.
- [ ] **Step 5: Commit** — `feat: workbook tabs`

### Task 10: Workbook view, frame and data widgets

**Files:**
- Create: `web/src/workbooks/workbook-view.tsx`, `web/src/workbooks/widget-frame.tsx`,
  `web/src/workbooks/widgets/chart-widget.tsx`, `table-widget.tsx`, `stat-widget.tsx`
- Modify: `web/src/app.tsx` (render `<WorkbookView tabId=… />` in `<main className="workspace">` for a workbook tab)
- Modify: `web/src/styles.css` only for grid classes not expressible with Tailwind utilities
- Test: `web/src/workbooks/workbook-view.test.tsx`

**Interfaces:**
- Consumes: Tasks 7–9; `ChartView` (lazy, as the result panel loads it), `ResultGrid`, `RunStatus`, `exportResult`,
  `SourceBadge`, `ParamsForm`-style controls from `params/params-form.tsx`.
- Produces: `WorkbookView({ tabId })`; `WidgetFrame({ tabId, widget, children })`; each widget takes
  `{ widget: Widget; run: WidgetRun; onChart?: (picked: Picked) => void }`.

Behaviour (spec §5.3, screen 1):
- Toolbar: name, folder, "Updated N s ago", **Refresh all**, **Edit**, ⋯ (Save, Save current values as defaults, Delete).
- Parameter bar: one control per workbook parameter, in order, using `label ?? name`; `list` with choices and `multi` is
  a multi-select; `all` adds an "All" option that selects every choice.
- Grid: `display: grid`, 12 columns, `grid-auto-rows: 8px`, gap 12 px, each widget at its layout; below `NARROW_PX` every
  widget spans 12 columns in `narrowOrder`.
- Frame header: source badge, title, a control per **Widget · shown** parameter, the names of workbook parameters it uses
  (link icon), run time, and ⋯: Refresh, Open in query tab (new query tab with the widget's text, source, options and
  current values as its parameters), Export (CSV, JSON, Markdown), Full screen (the same full-screen pattern the Chart tab
  uses).
- Body by run state: `running`/`waiting` a spinner and the state's word; `blocked` the reason; `gone` "This saved query is
  gone." with **Copy the last text into the widget**; `failed` `RunStatus`'s error view with report actions; `done` the
  widget.
- Chart widget: `ChartView` with `picked = widget.chart ?? {}` and `setPicked` through `edit` (marks dirty only in edit
  mode; in view mode the change is kept in the doc but the tab isn't dirtied — **plan's call**, so view-mode picking stays
  harmless).
- Table widget: `ResultGrid` with its own toolbar row.
- Stat widget: the first row's `stat.value` column (default the first numeric column), formatted with `toLocaleString`;
  with `stat.compare` the difference and its sign, ▲/▼ and its percentage.

- [ ] **Step 1: Write the failing tests:** a workbook with one widget per type renders their titles and the parameter
  bar; changing a bar select calls `setWorkbookValue`; a `blocked` widget shows its reason; a `gone` widget shows the copy
  button; a Stat with `value 1284` and `compare 1088` shows `1,284` and `▲ 196 (18%)`; Open in query tab opens a query tab
  with the resolved parameters.
- [ ] **Step 2: Run** `npx vitest run src/workbooks/workbook-view.test.tsx` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run lint && npm run typecheck && npm test` in `web/` — Expected: PASS, no new oxlint warnings.
- [ ] **Step 5: Commit** — `feat: workbook view and data widgets`

### Task 11: Markdown widget and links

**Files:**
- Create: `web/src/workbooks/widgets/markdown-widget.tsx`, `web/src/workbooks/widgets/markdown-widget.test.tsx`
- Modify: `src/Kustodian/Bridge/Handlers/AppHandler.cs` (`app.openLink {url}`), its tests, `bridge.mock.ts`

**Interfaces:**
- Consumes: `react-markdown` (default export `Markdown`).
- Produces: `MarkdownWidget({ text, values }: { text: string; values: Record<string, string> })`;
  `withValues(text: string, values: Record<string, string>): string` (exported for tests); bridge `app.openLink {url}` →
  `null`, `bad_request` "Only https links open." for anything but an absolute `https` URI, opened through the existing
  `ISystemBrowser`.

`react-markdown` renders to React elements and never to HTML strings; raw HTML in the text is ignored unless a plugin
turns it on (none does here), and its default `urlTransform` drops `javascript:` and other unsafe URLs. So the spec's
"sanitised with DOMPurify" (§5.3) is met by the library itself; DOMPurify isn't used for Markdown. CommonMark only: no
`remark-gfm` (tables, task lists) in v1 (**plan's call**: not asked for, and another dependency).

- `withValues` replaces each `{name}` that has a value with that value, Markdown-escaped (a backslash before each of
  `` \ ` * _ { } [ ] ( ) # + - . ! < > | ``), so a value can't add a link or a heading. An unknown `{name}` stays as written.
- `components.a` renders an `https` link as a button-styled `<a href>` whose click calls `app.openLink` and prevents
  navigation; any other link renders its text only. `components.img` renders nothing (no images in v1: nothing to load
  them from but the network).

- [ ] **Step 1: Write the failing tests:** `# Title` renders an `h1`, `**b**` a `strong`, `- a` a list item;
  `<script>alert(1)</script>` and `<b>x</b>` produce no `script` or `b` element; `[x](javascript:alert(1))` and
  `[x](http://a)` produce no link; `withValues('Range {TimeRange}', { TimeRange: '7d' })` is `'Range 7d'`; a value
  `[y](https://evil)` comes out escaped and renders as text; `{Nope}` stays; clicking an `https` link calls `app.openLink`
  with its URL. Host: `OpenLink_refuses_non_https` (`http:`, `file:`, relative) and opens an `https` one with the fake
  browser.
- [ ] **Step 2: Run** `npx vitest run src/workbooks/widgets/markdown-widget.test.tsx` and the host `AppHandler` tests —
  Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS; `npm run build` still has only the known chunk-size warning.
- [ ] **Step 5: Commit** — `feat: markdown widget`

### Task 12: Edit mode

**Files:**
- Modify: `web/src/workbooks/workbook-view.tsx`, `web/src/workbooks/widget-frame.tsx`
- Test: `web/src/workbooks/edit-mode.test.tsx`

**Interfaces:**
- Consumes: Tasks 7, 8, 10.

Behaviour (screen 2):
- **Edit** switches the toolbar to EDITING with + Add widget (Markdown, Chart, Table, Stat, From a saved query…), Parameters,
  Undo, Redo, Discard, Done. Done leaves the tab dirty; Discard restores the doc from when editing began (spec §5.2).
- Each widget shows a grip, its size (`8 × 18`), and when selected resize handles on the right, bottom and corner, Edit
  widget, Duplicate, Remove. Faint column guides behind the grid.
- Pointer drag on the grip moves by whole cells (from the grid's measured cell width and `ROW_PX + GAP_PX`), with a drop
  target; the corner handle resizes. Both go through `move`/`resize` and one `edit` per gesture.
- Keyboard: Tab reaches each widget's grip; arrows move one cell, Shift+arrows resize one cell, Delete removes, Ctrl/⌘+Z and
  Ctrl/⌘+Shift+Z undo and redo. Each is announced through an `aria-live` region ("Moved to column 3, row 12").
- New widgets go to `place(...)` at their `MIN_SIZE` doubled in height; "From a saved query…" opens the library picker and
  creates a linked Table widget titled with the query's name.

- [ ] **Step 1: Write the failing tests:** Add widget → Chart adds a widget at `place`'s spot; arrow right on a selected
  widget moves it one column; Shift+arrow down grows it one row; Delete then Ctrl+Z restores it; Discard restores; Done
  leaves the tab dirty; the drop target appears during a pointer drag (simulate pointer events with a mocked
  `getBoundingClientRect`).
- [ ] **Step 2: Run** `npx vitest run src/workbooks/edit-mode.test.tsx` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** — `feat: workbook edit mode`

### Task 13: Widget editor

**Files:**
- Create: `web/src/workbooks/widget-editor.tsx`, `web/src/workbooks/widget-editor.test.tsx`

**Interfaces:**
- Consumes: Tasks 5, 6, 8; `KqlEditor` (`editor/kql-editor.tsx`), the saved query list, `CHART_TYPES` (`results/chart-shape.ts`).
- Produces: `WidgetEditor({ tabId, widgetId, onClose })`; Apply writes one `edit`, Cancel writes nothing.

Behaviour (screen 3):
- Title field.
- **Query** (data widgets): "Write a query here" (source select Graph / Defender hunting / Resource Graph, and `KqlEditor`
  with that source's completion) or "Use a saved query" (picker of saved queries, its source badge, Open in tab, the
  read-only text, "Linked: changes to the saved query show up here. Saved <date>.", **Copy into widget**). Switching from
  saved to written copies the text.
- **Parameters:** one row per placeholder found in the query: name, type, "Value comes from" (Workbook / Widget · shown /
  Fixed), value. Workbook is offered only when a workbook parameter of that name exists. The hint line from screen 3.
- **Visualization** (Chart): type buttons for `CHART_TYPES` and X / Y / Series selects writing `widget.chart`. (Stat): value
  and compare column selects. (Table): nothing in v1.
- **Preview:** runs the draft once with the workbook's current values ("Run preview"), through the store's runner with
  run tab id `${tabId}/preview`.
- Markdown widgets show a text area and a live rendered preview instead of the three tabs.

- [ ] **Step 1: Write the failing tests:** choosing a saved query sets `query.saved` and shows Copy into widget; Copy
  into widget clears `saved` and keeps the text; a new placeholder typed in the query appears in Parameters as
  Widget · shown; choosing Fixed and a value stores `{from:'fixed', value}`; Cancel leaves the doc unchanged; Apply is
  one undo step.
- [ ] **Step 2: Run** `npx vitest run src/workbooks/widget-editor.test.tsx` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** — `feat: widget editor`

### Task 14: Workbook parameters dialog

**Files:**
- Create: `web/src/workbooks/parameters-dialog.tsx`, `web/src/workbooks/parameters-dialog.test.tsx`

**Interfaces:**
- Consumes: Tasks 5, 6, 8; `PARAMETER_TYPES`.
- Produces: `ParametersDialog({ tabId, onClose })`; Save writes one `edit`.

Behaviour (screen 4, v1 parts only — choices from a query and the Resource Graph scope are v2 and not shown):
- A reorderable list (drag, and Alt+↑/↓) with each parameter's type, default and "N widgets"; unused ones flagged "Not used".
- Detail: name (the `{name}` rule `^[A-Za-z_][A-Za-z0-9_]*$`, unique), label, type, choices "None, free entry" or "Fixed
  list", Several values and Offer "All" (for `list` with choices), Required, Remember my last value, default, and for a
  `timespan` "Use as the Defender hunting timespan" (one per workbook: setting it clears it elsewhere).
- "Used by": the widgets that take it from the workbook.
- Renaming a parameter renames the matching widget entries; it does not edit query text (the hint says so).

- [ ] **Step 1: Write the failing tests:** adding `TimeRange` (timespan) and marking it the hunting timespan clears the
  mark on another; a duplicate or invalid name can't be saved and says why; Alt+↓ reorders; "Used by" lists the widgets
  `widgetsUsing` returns; an unused parameter shows "Not used".
- [ ] **Step 2: Run** `npx vitest run src/workbooks/parameters-dialog.test.tsx` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** — `feat: workbook parameters dialog`

### Task 15: Docs and full check

**Files:**
- Create: `docs/workbooks.md` (what a workbook is, widgets, the two query forms, parameter resolution order, saving)
- Modify: `README.md` (one Features bullet), `docs/README.md` (link), `CHANGELOG.md` (Unreleased entry)

- [ ] **Step 1: Write the docs** from the spec's wording; no screenshots yet.
- [ ] **Step 2: Run the full check:**
  `dotnet build -warnaserror`, `dotnet test`, and in `web/`: `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`.
  Expected: all pass; the only warnings are the two known ones in `CLAUDE.md`.
- [ ] **Step 3: Run the app** (the `run` skill, or the project's usual way) with the mock bridge: create a workbook with
  one widget of each type on three sources, change a workbook parameter and see only the widgets that use it rerun, edit
  the layout, save, close and reopen it from the library, restart and see an unsaved one restored.
- [ ] **Step 4: Commit** — `docs: workbooks`
