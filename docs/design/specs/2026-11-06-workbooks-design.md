# Workbooks: design

Date: 2026-11-06. Status: approved by the owner (2026-11-06).

**Owner** means the owner decided it. **My call** means I chose it and the owner can overrule it while reading.

Mockups: the [Kustodian Workbooks canvas](https://claude.ai/artifact/Uu65LXkUREw53qNg7cYMZm), seven screens, numbered as
below.

## 1. Why

A query tab answers one question. Recurring reviews (risky users this week, VMs that should be off, expiring credentials)
need several queries side by side, across sources, with the same few inputs changed together. Azure Monitor and Sentinel
workbooks, Azure DevOps dashboards and Grafana all solve this the same way: a canvas of widgets, each backed by a query,
driven by shared parameters (**Owner**: "like the workbook feature in Azure log analytics, Azure DevOps or Sentinel").

What those products share, and what this design takes from them:

- **Azure Workbooks:** a parameter bar whose changes redraw every step that uses it; parameter choices from a query;
  a grid row click that sets a parameter; groups shown only when a parameter has a value.
- **Azure DevOps / Grafana:** a grid you drag and resize widgets on, a separate edit mode, collapsible rows, and one time
  range for the whole board.
- **Most used widgets** across all of them: time series, stat/tiles, table, bar/column, pie, text. Maps, heatmaps and gauges
  come well after (my reading of their docs and galleries, not usage data).

## 2. Goals

- A user can build a workbook of widgets, place and size them freely on a grid, and save it (**Owner**).
- Widgets, at least: **Markdown**, **charts** and **tables** (**Owner**). This design adds **Stat** (**My call**: it is the
  most common widget after those three and is a small one).
- Every data widget can query **any supported source**: Graph, Defender hunting, Resource Graph (**Owner**).
- A data widget's query is either **written in the widget** or **a saved query from the library** (**Owner**).
- Every data widget supports **parameters**, shown on the widget, that the user changes to rerun it (**Owner**).
- **Workbook (global) parameters**: changing one affects every widget that uses it (**Owner**).
- Table-like widgets support **row selection** and **tool buttons** that run an external tool on the selected rows, or on
  all rows when none are selected, with values taken from the result. Example: Start VM / Stop VM calling the Azure CLI
  (**Owner**).
- A workbook is **shareable**: saved as a JSON file another user can open (**Owner**).

## 3. Non-goals

- Live collaboration, or a server to share through. Sharing is a file.
- Scheduled runs, alerts or e-mailed reports.
- Raw Graph requests as a widget source in v1 (they aren't KQL and have no parameters of the same kind). **My call.**
- Widgets that write back to the tenant other than through the user's own external tools.
- Pixel-free layout. Widgets snap to the grid.

## 4. Anti-goals

These would make it a failure even if it works:

- **Opening a shared file runs, or brings in, a command.** A workbook never carries a command line. Tool buttons name a
  tool from the recipient's own `tools.json`, and nothing runs without the existing confirmation (§8).
- A shared file carrying tenant data: results, tokens, account or tenant IDs beyond what the author typed into a query or
  a default value.
- One slow or failing widget blocking or breaking the others.
- Changing one parameter rerunning every widget. Only widgets that use it rerun.
- A second, different parameter syntax. Workbooks use `{name}` and `ParameterDef` as query tabs do.

## 5. The model

### 5.1 Workbook

A workbook has an id (GUID), a name, an optional folder, workbook parameters (§6), and widgets. It opens as a **workbook
tab**, next to query tabs, and survives restarts the way tabs do. It is saved in the library as its own file (§9).

### 5.2 Layout

- A 12-column grid, rows of 8 px, 12 px gaps (screen 1). Each widget stores `{x, y, w, h}` in grid units.
- **View mode** (screen 1) and **edit mode** (screen 2). In edit mode widgets show a drag grip, resize handles on the
  selected widget, their size (`8 × 18`), and a drop target. Widgets reflow upward when there is room (Grafana's
  behaviour). **My call.**
- Edit mode has undo/redo, Discard and Done. Done ends edit mode and leaves the workbook **dirty**; Save (Ctrl/⌘+S) writes
  it, and closing a dirty workbook asks, as a query tab does today. **My call.**
- Values changed in view mode (the parameter bar, widget-header controls) don't make the workbook dirty and aren't written
  to the file: the file holds the author's **defaults**. "Save current values as defaults" in the workbook menu is the
  explicit way to change them. This keeps runtime picks (a selected UPN, chosen subscriptions) out of a shared file.
  **My call.**
- Minimum widget size per type (for example a table 3 × 8). The builder picks the numbers.
- Narrow windows: below a breakpoint every widget takes the full width, in `y, x` order. **My call.**

### 5.3 Widget types

| Type | v | What it shows |
| --- | --- | --- |
| Markdown | 1 | Headings, text, links. `{name}` renders the current parameter value. Rendered with `react-markdown`: no raw HTML, unsafe URLs dropped (**Owner**: a library, not hand-rolled). |
| Chart | 1 | Time, line, area, column, bar, pie (reuses `results/chart-view.tsx` and `chart-shape.ts`). X, Y and series map to columns. |
| Table | 1 | The result grid (reuses `results/result-grid.tsx`): sort, its row filter, selection, tool buttons (§8). |
| Stat | 1 | One number from the first row, an optional comparison value and its change. Thresholds and colours are v2. |
| Section | 2 | A titled, collapsible group of widgets; can be shown only when a parameter has a value. |
| Parameter bar | 2 | A bar of workbook parameters placed inside the canvas, usually at the top of a section. |
| Tabs, links to workbooks, map, "repeat for each value" | later | |

Every widget's header shows: source badge, title, its widget parameters (§6.2), which workbook parameters it uses (a link
icon and the names), run time, and a ⋯ menu: Refresh, Open in query tab, Export (CSV, JSON, Markdown, reusing
`results/export.ts`), Full screen, and in edit mode Edit, Duplicate, Remove.

### 5.4 A data widget's query

Two forms (**Owner**), chosen in the widget editor (screen 3):

- **Chart settings** (type, X, Y, series) are in memory only today; a chart widget needs a saved shape for them in the
  workbook file.
- **Written in the widget:** `{ source, text, options }`, edited with the existing KQL editor and its completion for that
  source.
- **A saved query:** `{ savedId }`. The widget is **linked**: it always runs the library version, so editing the saved query
  changes every widget that uses it (**My call**: this is what "select from the saved queries" usually means, and a copy is
  one click away). The editor shows the saved query read-only with "Open in tab" and **Copy into widget**, which turns it
  into the first form.
- A linked query that has been deleted from the library: the widget shows an error with "Copy the last text into the
  widget", from the copy the workbook keeps (§9.2).
- `options` (hunting timespan, Resource Graph scope) come from the query as today, unless a workbook parameter is set to
  supply them (§6.4).

## 6. Parameters

### 6.1 Syntax and types

The same `{name}` placeholders (`params/find-params.ts`) and `ParameterDef` types: text, number, timespan, datetime, list.
Values are quoted for KQL by Kustodian as they are today, never spliced in as raw text.

### 6.2 Where a widget's value comes from

In the widget editor (screen 3) each placeholder in the widget's query gets one of:

- **Workbook:** follows the workbook parameter of the same name. The default when one exists.
- **Widget · shown:** a control in the widget header (screen 1: `SplitBy`, `Bin`, `Top`). Changing it reruns only that
  widget.
- **Fixed:** a set value, no control.

A saved query's parameters link to workbook parameters of the same name automatically. A placeholder with no workbook
parameter of that name starts as **Widget · shown** with the saved query's value.

Resolution, per widget, per parameter: the widget's own value if it is set to Widget or Fixed; otherwise the workbook value;
otherwise the parameter's default. A required parameter with no value stops that widget from running and says so on the
widget; the others still run.

### 6.3 Workbook parameters

Edited in a dialog (screen 4), shown in the bar under the workbook toolbar (screen 1). Each has: name, label, type, choices,
default, required. v1 adds to `ParameterDef`:

- **Multi-select** for a `list` with choices (a `list` already holds several values, one per line, but `params-form.tsx`
  shows choices as a single `<select>`). **v1.**
- **Offer "All"** for a `list` with fixed choices: All sends every choice, as the same `dynamic([...])` a list sends today,
  so authors write nothing special. Not offered for a list without fixed choices in v1; with query choices (v2) it sends
  every loaded choice. No change to host substitution (`ParameterSubstitution`) or `find-params.ts`. **My call.**
- **Remember my last value**, kept per user, not in the shared file. **v1.**
- **Choices from a query**: any source; first column the value, second the label. **v2.**
- **Set by a click**: a table row click (or a chart mark, using `markFilter`/`onPick` already on main) sets the parameter to a column's
  value (screen 1: `SelectedUser`). **v2.**

The dialog shows which widgets use each parameter, and flags unused ones.

### 6.4 Timespan and scope

- A workbook parameter of type `timespan` can be marked **the hunting timespan**: every hunting widget sends it as
  `options.timespan` unless the widget overrides it. One per workbook. **v1.** The parameter's value is a KQL literal
  (`7d`) while `options.timespan` must be ISO 8601 (`P7D` or `start/end`) and at most 30 days, so the value is converted,
  and a value that can't be is shown as an error on the parameter, not sent.
- A `list` parameter of subscription IDs can be marked **the Resource Graph scope** (screen 4): ARG widgets send it as
  `options.scope`. **v2** (it needs choices from a query to be usable).

### 6.5 What reruns

When a workbook parameter changes, the widgets whose resolved queries use it (by `findParams` on their text, after §6.2)
rerun. A text parameter reruns when the user stops typing (debounced) or presses Enter. **My call.**

## 7. Running

- Widgets run in parallel, up to a limit per source (the builder picks it; hunting and Graph throttle). Others queue and say
  "waiting".
- Each widget has its own status, error (the existing error view and report actions), row count and run time.
- **Refresh all** reruns every widget. **Auto refresh** (off, 5, 15, 60 min) is v2.
- A workbook tab keeps each widget's last result in memory while open. Results are never saved to disk or into the file, except what a widget's opt-in history keeps (§10).
- Widget runs use run ids `<tabId>/<widgetId>`: `QueryHandler` already accepts any non-empty tab id and cancels the
  previous run on the same id, so this needs no host change.
- Widget runs are **not** added to Recent (opening a workbook would flood it). `query.run` gets a flag for that. **My call.**
- Open in query tab opens a new query tab with the widget's resolved query and parameter values.

## 8. Selection and tool buttons

Builds on the existing external tools (`docs/external-tools.md`, `ExternalToolService`, `results/run-tool.tsx`,
`results/tool-args.ts`) rather than a new mechanism (**My call**).

- **Selection** (table widgets; screen 5): a checkbox column and select-all, on by default. Today selection (click,
  Shift, Ctrl/⌘) and Run tool live inside `result-grid.tsx`; that state moves out of the grid so the widget header can use
  it, and the existing Rows tab keeps working the same way. The editor (screen 6) can turn
  it off or allow only one row.
- **Tool buttons** are set up per widget on the editor's Tool buttons tab (screen 6):
  - label; placement (widget header or ⋯ menu);
  - **tool**: one from the user's `tools.json`, by name. The editor shows its command line for reading;
  - **column mapping** for each `{parameter}` in the tool's args, starting from `defaultMapping` (same name, then case-
    insensitive). Only result columns in v1: `ExternalToolService` fills arguments from columns only, and that path is
    the security-sensitive one. Filling an argument from a workbook parameter is v2 (screen 6's note shows it). **My call.**
  - **runs on**: the selected rows, or all rows the filter shows when none are selected (the default, **Owner**); or only
    the selected rows (the button is off with none selected);
  - **after it runs**: refresh this widget (default on), or the whole workbook.
- The button label carries the count: "Stop VM · 2", "Stop VM · all 14".
- Clicking it opens the existing run dialog: mapping, the command line for the first row, row count, then Run (screen 5).
  The confirmation can't be turned off. Output, Stop and closing behave as Run tool does today.
- `each` and `batch` tools both work. A `batch` tool gets the selected (or all) rows on stdin.
- **v2:** a button is on only when the selected rows match a condition, for example `powerState == "deallocated"` for
  Start VM.

## 9. Storage and sharing

### 9.1 In the library

- One file per workbook, `workbooks/<id>.json` next to `saved/`, written through `JsonFileStore` with the same gate and
  move-aside-on-corrupt behaviour as `LibraryService`. **My call.**
- The library side panel lists workbooks with saved queries, or under a Workbooks rail button (screen 1 shows a rail
  button; either is fine). Workbooks have folders, as saved queries do.

### 9.2 The file

`.kustodian-workbook.json`, the same JSON the library stores (screen 7 shows it):

```json
{
  "kind": "kustodian.workbook",
  "version": 1,
  "id": "…",
  "name": "VM hygiene",
  "folder": "Azure",
  "parameters": [ { "name": "Subscriptions", "type": "list", "value": "", "required": false,
                    "multi": true, "all": true } ],
  "widgets": [
    { "id": "vms", "type": "table", "title": "Virtual machines",
      "layout": { "x": 0, "y": 0, "w": 12, "h": 20 },
      "query": { "saved": { "id": "7c1e…", "name": "Azure / VMs by power state" },
                 "source": "arg", "text": "resources | …", "options": null },
      "parameters": { "PowerState": { "from": "widget", "value": "any" } },
      "selection": "multi",
      "tools": [ { "label": "Stop VM", "tool": "Stop VM", "mapping": { "id": "id" },
                   "runsOn": "selectedOrAll", "after": "refreshWidget", "placement": "header" } ] }
  ]
}
```

- A linked widget keeps `saved.id`, `saved.name` **and** the query's current `source`, `text` and parameters, refreshed on
  every save. That copy makes the file work for someone without the library entry, and covers a deleted saved query
  (§5.4). In the library the widget still runs the saved query, not the copy.
- `version` is the file format version. A newer version than the app knows is refused with a message; older ones are
  upgraded on read.
- "Remember my last value" values are kept outside the file (per user, per workbook id).
- **Session:** a workbook tab keeps the whole workbook JSON in `session.json`, as a dirty query tab keeps its text, so
  unsaved edits and "Open without saving" imports survive a restart. That is a new session tab kind. If the library copy
  was deleted meanwhile, the tab stays open as unsaved. **My call.**

### 9.3 Export and import

- **Export** (workbook ⋯ menu) saves the file with the existing file dialog. **Import** (library and command palette)
  opens one. Opening a file from the OS is out: Kustodian registers no file types today.
- Import shows a review before anything is saved or run (screen 7):
  - what is in it (widgets, parameters, sources), and that it holds no results or tokens;
  - **saved queries**: add them to my library (default) or copy them into the widgets. Added queries get **new ids** and
    the widgets' `saved.id` is rewritten, so a re-import never overwrites a library entry. They go in a folder named after
    the workbook (folders are one level, 1–80 characters, no `/`; the name is shortened and `/` replaced). **My call.**
  - **tool buttons**: each matched by name to the recipient's `tools.json`; unmatched ones choose one of the user's tools
    or are left off. Nothing from the file is ever written to `tools.json`;
  - **parameter values**: listed with their defaults. Checking them against the tenant (subscriptions not in it fall back
    to All, screen 7) is v2, with the Resource Graph scope parameter that marks a list as subscription IDs. **My call.**
  - Open without saving, or Save to my workbooks. An import with the id of an existing workbook asks: replace, or keep both
    (a new id).
- Nothing runs until the user closes the review. Widgets then run as on any open.

## 10. Result history (v2)

**Owner**: a widget can keep history so it can show change over time. Graph and Resource Graph only show current state,
and so do some Defender tables (`DeviceTvmSoftwareVulnerabilities`, `DeviceTvmSoftwareInventory`,
`DeviceTvmSecureConfigurationAssessment`): only latest values are kept. Whether history helps depends on the table, not
the source. Where the source keeps history (most hunting tables, 30 days), a comparison belongs in the query instead.

### 10.1 Two modes

One History setting per widget, **off by default**, with a mode (**My call**: two modes cover every case raised, and a
third, column-change tracking, waits for a case a filter can't express):

- **Values over time.** Stores each run's whole result with its run time. For small, summarised results only (at most
  500 rows; the builder may tune it). A Stat shows the change since a chosen point ("vs yesterday", "vs 7 days ago"); a
  chart plots the snapshots over time, split by a column as usual. Example: users with a device-bound passkey per day,
  `userRegistrationDetails | mv-expand m = methodsRegistered | where m startswith "passKeyDeviceBound" | summarize count() by tostring(m)`.
  The default for Stat and Chart widgets.
- **Row tracking.** The author picks **key columns** (one or more, for example `DeviceId` + `CveId`) and a few display
  columns. After each run, keys that are new get *first seen* = now, missing keys get *gone* = now, and a key that
  returns starts a new *first seen*. Storage grows with distinct keys, not with days. A table can then filter to **New
  since** or **No longer reported since** a date or the previous run, and a Stat can count either. State is expressed as
  presence: "users with a device-bound passkey", keyed on `id`, shows who added one and who no longer has one. The
  default for Table widgets. Today's run diff (`results/diff.ts`) matches on one column; row tracking needs several.

Labels say **No longer reported**, not "Patched" or "Removed": a row also disappears when a device is offboarded or
inactive, or a user is deleted.

### 10.2 When a snapshot is taken

- There is no scheduler: Kustodian is a desktop app and scheduled runs are a non-goal. A widget with history stores a
  snapshot when it runs and its last snapshot is older than its interval (default one day; the latest run in an interval
  replaces earlier ones in Values mode). Days nobody opened the workbook are **gaps**, drawn as gaps.
- A run that failed, was cancelled, or was cut off by a row limit or truncation is **never** recorded. A cut-off result
  would mark rows gone, or store a wrong count, and the widget says why it skipped.

### 10.3 What history belongs to

- History is keyed on the workbook id, widget id, and a hash of the resolved query text, source, options and parameter
  values. Each parameter combination has its own history.
- Editing the widget's query (or a linked saved query) asks before its history is cleared; the old history is deleted on
  yes, kept and the edit refused on no. Changing the mode or the key columns asks the same. **My call.**
- Mockups: screen 8 (widgets with history) and screen 9 (the editor's History tab).
- Retention per widget: 30, 90 or 365 days (Values) and how long a gone key is kept (Rows). **Clear history** in the
  widget menu.

### 10.4 Storage and privacy

- **Owner** (2026-11-07): one SQLite database, `history.db` in the data folder, through `Microsoft.Data.Sqlite` with its
  bundled native SQLite (no system library; the single-file publish carries and extracts it like Photino's). Why not JSON
  files: Row tracking on a TVM table holds hundreds of thousands of keys, and a file would be read and rewritten whole on
  every save and every "new since" filter. One store for both modes, not one per mode.
- Tables, roughly: a **series** per §10.3 key (workbook id, widget id, hash, mode); **snapshots** (series, taken at,
  result as JSON, Values mode); **rows** (series, key, display columns as JSON, first seen, gone or null, Rows mode),
  indexed on (series, key), (series, first seen) and (series, gone). A snapshot is written in one transaction, so a crash
  never leaves half a diff. Schema version in `PRAGMA user_version`; WAL mode; only the host process writes.
- **My call**: a database that can't be opened or fails its integrity check is renamed aside (`history.db.damaged-<time>`)
  and a new one started; widgets with history say it was reset. It never stops the app or a workbook from loading.
- Clear history, an edited query (§10.3) and a deleted workbook delete their series' rows; retention deletes old snapshots
  and gone keys when a series is saved. Screen 9's Size column shows stored snapshots or rows instead of MB, and its
  "Show history files" button is dropped (**my call**: the database isn't meant to be opened by hand).
- Local only: never in an exported workbook, never in error reports. Deleting a workbook deletes its history.
- Rows mode keeps only key and display columns, so what is stored is what the author chose to show.

## 11. Feature list

**v1**

- Workbook tab, view and edit modes, 12-column grid, drag, resize, duplicate, remove, undo.
- Widgets: Markdown, Chart (time, line, area, column, bar, pie), Table, Stat.
- Query in the widget, or a linked saved query with Copy into widget.
- Workbook parameters (text, number, timespan, datetime, list; several values, All, remember my value), widget
  parameters in the header, Workbook / Widget / Fixed per placeholder, hunting timespan from a parameter.
- Rerun only what a change affects; per-widget status and errors; Refresh all.
- Widget menu: refresh, open in query tab, export, full screen.
- Row selection and tool buttons on tables.
- Library storage, export and import with the review.

**v2**

- Parameter choices from a query; Resource Graph scope from a parameter.
- Row or chart click sets a parameter.
- Sections, conditional visibility, the in-canvas parameter bar.
- Auto refresh; thresholds and colours on Stat and table cells.
- Tool buttons enabled by a condition on the selected rows; tool arguments filled from workbook parameters.
- Import checks parameter values against the tenant.
- Result history: Values over time and Row tracking (§10).

**Later:** tabs, links between workbooks, maps, repeat-for-each-value. (Built-in template workbooks were dropped: Community Solutions ships ready-made workbooks.)

## 12. Code layout

- Web: `web/src/workbooks/` (workbook store, grid, widget frame, widget editor, parameters dialog, import review). Widgets
  wrap the existing chart view, result grid, Markdown via DOMPurify, KQL editor and params form, not copies of them.
- Host: a `WorkbookService` next to `LibraryService` and a `WorkbookHandler` for `workbook.list/get/save/delete/import/
  export`, plus the file dialogs. Wire types in `web/src/wire.ts`. In v2, a `WorkbookHistoryService` for §10, which
  records a snapshot from the run result on the host side so a cut-off result can be refused where its limits are known.
- Runs: today `query.run` is keyed by `tabId`. Widgets need their own run ids (for example `<tabId>/<widgetId>`) so runs can
  be told apart and cancelled one by one. The builder decides the exact shape.
- Grid drag and resize: no new dependency if pointer events and CSS grid are enough; ask before adding one.

## 13. Testing and verification

- Unit: parameter resolution (§6.2), what reruns (§6.5), layout reflow and collision, file read/write and version upgrade,
  import matching of saved queries and tools, tool-button row choice (selected / all / none).
- History: a cut-off or failed run records nothing; keys come, go and return correctly; a parameter change uses its own
  history; a query edit asks before clearing; gaps stay gaps.
- Host: `WorkbookService` round-trip, corrupt file moved aside, refused newer version, import never touches `tools.json`.
- UI: a workbook with three sources renders and reruns only the widgets a parameter change affects; a failing widget
  leaves the others working; tool buttons show the confirmation with the right command line.
- `dotnet build -warnaserror`, `oxlint` and `tsc` clean, per `CLAUDE.md`.

## 14. What is left to the builder

- History row caps, file layout inside `history/`, and how the editor detects tables with no time column to suggest
  history.
- Concurrency limits per source, debounce timing, minimum widget sizes, the narrow-window breakpoint.
- Whether workbooks share the library panel or get their own rail button.
- Grid interaction details (keyboard move and resize must work; how is the builder's call).
