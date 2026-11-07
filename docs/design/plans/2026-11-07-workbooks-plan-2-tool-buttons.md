# Workbooks, plan 2: selection and tool buttons — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A table widget has a checkbox selection column and tool buttons. Each button names one of the user's own tools
from `tools.json` and maps result columns to its parameters. It runs on the selected rows, or on every row the filter
shows when none are selected, after the existing run dialog asks, and then refreshes the widget or the workbook. The
buttons and the selection setting are saved in the workbook file.

**Architecture:**

- **Web only.** The host already does what a button needs. `tools.run` looks a tool up by name in the user's
  `tools.json`, fills arguments only from result columns, and starts the command without a shell. `WorkbookService` and
  the session store a workbook as an opaque document, so new widget fields are saved with no host change.
- **Selection moves out of the grid.** `ResultGrid` takes an optional controlled selection and reports which rows the
  filter shows. A table widget keeps both in the workbook store, so the widget header can count them. The Rows tab passes
  neither and works as it does today.
- **A button holds only `{ label, tool, mapping, runsOn, after, placement }`.** At click time the frame reads
  `tools.list`, finds the tool by name and opens the existing `RunToolDialog` with the chosen rows and the saved mapping.
  When the run ends it refreshes. A pure `toolTarget` chooses the rows.
- **Not in this plan:** export and import (plan 3), buttons enabled by a condition, tool arguments filled from workbook
  parameters, a row click that sets a parameter (all v2 in the spec).

**Tech Stack:** React 19 + TypeScript, zustand, TanStack Table v9, Vitest + Testing Library, oxlint. No new dependencies.

**Spec:** `docs/design/specs/2026-11-06-workbooks-design.md` §8, plus the `tools` and `selection` fields in §9.2's example
file, §4's first anti-goal and §13's "tool-button row choice". Mockups: screens 5 (`Actions`) and 6 (`WidgetActions`) on
the canvas linked from the spec. Plan 1 (`docs/design/plans/2026-11-06-workbooks-plan-1-core.md`) built everything this
plan extends. Read both first.

## Global Constraints

- No warning suppressions: `dotnet build -warnaserror`, `oxlint` and `tsc` pass clean (`CLAUDE.md`). The two known open
  warnings stay as they are.
- Work only in a worktree; run each git command on its own. Commit after each task.
- No new npm or NuGet dependency.
- **A workbook never carries a command line** (spec §4, **Owner**). A tool button stores a tool **name** and a column
  mapping, nothing else. Parsing drops every other field on a button, so a hand-edited or shared file can't carry a
  `command` or `args` through a save.
- **Every run shows the existing confirmation** (**Owner**). A button only opens `RunToolDialog` at its `confirm` stage.
  There is no option to skip it.
- Arguments come from **result columns only** in this plan (spec §8). Filling from workbook parameters is v2.
- Selection and the rows the filter shows are view state. They never go into the doc, never make the workbook dirty, and
  a new result clears them, as the Rows tab clears its selection today.
- No host change. If a task seems to need one, stop and ask the owner.
- Copy, from the spec and the mockups: "Tool buttons", "+ Add tool button", "Rows can be selected", "Several rows at once",
  "Button label", "Placement", "In the widget header", "In the ⋯ menu", "Tool", "Runs on", "The selected rows; all rows
  the filter shows when none are selected", "Only selected rows (button is off with none selected)", "After it runs",
  "Refresh this widget", "Refresh the whole workbook", "Nothing". Button label `Stop VM · 2` / `Stop VM · all 14`. Dialog
  title `Stop VM on 2 selected rows` / `Stop VM on all 14 rows`. Header `2 of 14 selected`.
- Match the surrounding code: `call()` from `web/src/bridge.ts`, `errorText`/`reportIdOf` for errors, `NoticeLine` for
  a widget's notices, `MenuButton` items with `role="menuitem" tabIndex={-1}`.

## Review Focus

1. **A button's tool is missing from the user's `tools.json`, was renamed, or `tools.json` has a problem** (common with
   a workbook from someone else): clicking the button shows a notice on the widget ("There's no tool named Stop VM in
   your tools.json." or the list's problem) with **Edit tools…**, and nothing runs. Tested in Task 5.
2. **The saved mapping names a column the result no longer has** (the query was edited): that parameter starts from
   `defaultMapping`, or unmapped, and the dialog's Run stays off until it has a column. A stale column is never sent.
   Tested in Task 4.
3. **A hand-edited or shared file puts `command`, `args` or `mode` on a tool button, or `tools` on a non-table widget:**
   parsing drops them, and a save writes none of them back. Tested in Task 1.
4. **Rows are selected, then the filter hides some, or the widget reruns:** hidden selected rows aren't counted or run,
   and with all of them hidden the button falls back to "all N". A new result clears the selection. Tested in Tasks 2
   and 3.
5. **The widget reruns while the run dialog is open** (the refresh after the run, or a parameter change): the dialog keeps
   the rows it opened with and its output. The refresh happens once, when the run ends; Cancel refreshes nothing. Tested
   in Task 5.

---

## File structure

| File | Responsibility |
| --- | --- |
| `web/src/workbooks/model.ts` | `ToolButton`, `RowSelectionMode`; parse and defaults for `tools` and `selection`. |
| `web/src/results/result-grid.tsx` | optional controlled selection, checkbox column, select-all, single mode, `onShownChange`. |
| `web/src/workbooks/tool-buttons.ts` | `toolTarget`: which rows a button runs on, and its count and heading. |
| `web/src/workbooks/workbook-store.ts` | per-widget `selections` (view state), cleared on a new result. |
| `web/src/results/tool-args.ts` | `startMapping`: a saved mapping checked against the tool and the result. |
| `web/src/results/run-tool.tsx` | `RunToolDialog` gains `title`, `initialMapping`, `onRan`. |
| `web/src/workbooks/tool-run.tsx` | `useToolRun` and `ToolButtonItems`: header buttons, menu items, the dialog. |
| `web/src/workbooks/widgets/table-widget.tsx`, `widget-frame.tsx` | wire selection and buttons into the widget. |
| `web/src/workbooks/widget-editor.tsx` | the Tool buttons tab. |
| `docs/workbooks.md`, `docs/external-tools.md`, `CHANGELOG.md` | docs. |

---

### Task 1: Model

**Files:**
- Modify: `web/src/workbooks/model.ts`
- Test: `web/src/workbooks/model.test.ts`

**Interfaces:**
- Produces:

```ts
export type RowSelectionMode = 'multi' | 'single' | 'none';
export interface ToolButton {
  label: string;
  /** A tool's name in the user's tools.json. Never a command (spec §4). */
  tool: string;
  /** Tool parameter → result column; '' or missing means "as defaultMapping picks". */
  mapping: Record<string, string>;
  runsOn: 'selectedOrAll' | 'selected';
  after: 'refreshWidget' | 'refreshWorkbook' | 'none';
  placement: 'header' | 'menu';
}
// on Widget:
  selection?: RowSelectionMode;   // table widgets only
  tools?: ToolButton[];           // table widgets only
export function newToolButton(): ToolButton; // { label:'', tool:'', mapping:{}, runsOn:'selectedOrAll', after:'refreshWidget', placement:'header' }
```

- [ ] **Step 1: Write the failing tests** in `model.test.ts`:
  - `newWidget('table', …)` has `selection: 'multi'` and `tools: []`. Chart, stat and markdown widgets have neither key.
  - The spec §9.2 example's table widget parses to exactly
    `tools: [{ label:'Stop VM', tool:'Stop VM', mapping:{ id:'id' }, runsOn:'selectedOrAll', after:'refreshWidget', placement:'header' }]`
    and `selection: 'multi'`.
  - **Review Focus 3:** a button with `command`, `args`, `mode` and `"x": 1` parses without any of those keys, and
    `JSON.stringify(parseWorkbook(file))` contains neither `"command"` nor `"args"`.
  - **Review Focus 3:** a chart widget with `tools: [{ tool: 'X', command: '/bin/sh' }]` and `selection: 'single'` parses
    without `tools` or `selection`.
  - A button without a non-empty string `tool` is dropped. An empty `label` becomes the tool's name. Mapping entries
    whose value isn't a string are dropped. Unknown `runsOn` / `after` / `placement` values fall back to
    `selectedOrAll` / `refreshWidget` / `header`. `tools` that isn't an array becomes `[]`.
  - `selection` values other than `'single'` and `'none'` become `'multi'`. A table widget without `selection` gets
    `'multi'`.
- [ ] **Step 2: Run** `npx vitest run src/workbooks/model.test.ts` in `web/`. Expected: FAIL.
- [ ] **Step 3: Implement.** In `parseWidget`, take `tools` and `selection` out of `rest` as `query`, `chart` and `stat`
  already are, and add them back only for `type === 'table'`. Write `parseToolButton(v: unknown): ToolButton | null` to
  build a **new object from the six known fields only**, unlike the rest of the model, which keeps unknown fields. A
  comment says why: spec §4.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit**: `feat: tool buttons and row selection in the workbook model`

### Task 2: Grid selection out of the grid

**Files:**
- Modify: `web/src/results/result-grid.tsx`
- Test: `web/src/results/result-grid.test.tsx`

**Interfaces:**
- Produces, on `GridProps`:

```ts
/** A selection the caller keeps (a table widget), by row index in `rows`, with a checkbox column; 'none' turns selection
 * off. Without it the grid keeps its own selection and has no checkbox column, as the Rows tab does. */
selection?: GridSelection | 'none';
/** The indexes in `rows` of every row the filter lets through, in the order shown; called after a render that changed them. */
onShownChange?: (shown: number[]) => void;

export interface GridSelection {
  mode: 'multi' | 'single';
  selected: ReadonlySet<number>;
  onChange: (selected: ReadonlySet<number>) => void;
}
```

Behaviour (screen 5):
- The internal selection changes from row ids to `row.index` numbers, so the grid has one representation whether it owns
  the selection or not. The existing click, Shift, Ctrl/⌘ and arrow-key behaviour stays as it is for `multi`.
- With a `GridSelection`, a first column holds a checkbox per leaf row (`aria-label="Select row N"`, N 1-based as the
  inspect button counts). Its header holds **Select all rows**: checked when every shown row is selected, indeterminate
  when some are. Clicking it selects every shown row, or clears the selection when all are selected. A row checkbox
  toggles that row in `multi` and makes it the only one in `single` (or clears it). Its click doesn't reach the row's
  `onClick`. Group rows span one more column.
- In `single`, Shift-click and Ctrl/⌘-click act as a plain click.
- With `'none'`, there's no checkbox column, and clicks and arrows select nothing.
- `onShownChange` is called from an effect whose dependencies are `rows`, the global filter, `cellFilters`, sorting and
  grouping. It sends `leaves(table.getSortedRowModel().rows).map((r) => r.index)`.
- The grid's own Run tool menu and Copy use the same chosen rows as before, whichever side owns the selection.

- [ ] **Step 1: Write the failing tests:**
  - `grid_checkbox_column_selects_rows_through_the_caller`: a controlled grid with 3 rows. Clicking "Select row 2" calls
    `onChange` with `{1}`. Re-rendered with `selected={1}`, row 2 is `aria-selected` and "Select all rows" is
    indeterminate.
  - `grid_select_all_selects_only_rows_the_filter_shows`: filter to 2 of 3 rows, then Select all rows → `onChange` with
    those two indexes.
  - `grid_single_mode_keeps_one_row`: with `{0}` selected, Ctrl-click row 3 → `onChange({2})`. There's no Select all
    checkbox.
  - `grid_selection_none_has_no_checkboxes_and_selects_nothing`.
  - `grid_reports_shown_rows_in_order`: sort by a column descending, then filter → `onShownChange`'s last call is the
    matching indexes in that order.
  - The existing tests (`grid_shift_click_selects_range_and_copies_csv`,
    `grid_selected_count_leaves_out_rows_the_filter_hides`, `grid_opens_row_on_double_click_and_enter`) pass unchanged
    and render no checkbox.
- [ ] **Step 2: Run** `npx vitest run src/results/result-grid.test.tsx`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run src/results` and `npm run lint` in `web/`. Expected: PASS, with no new oxlint
  warning beyond the known `useVirtualizer` one.
- [ ] **Step 5: Commit**: `feat: result grid selection the caller can own, with a checkbox column`

### Task 3: Row choice and the store's selection

**Files:**
- Create: `web/src/workbooks/tool-buttons.ts`, `web/src/workbooks/tool-buttons.test.ts`
- Modify: `web/src/workbooks/workbook-store.ts`
- Test: `web/src/workbooks/workbook-store.test.ts`

**Interfaces:**
- Consumes: Task 1's `ToolButton`; `Row` from `results/export.ts`.
- Produces:

```ts
// tool-buttons.ts
export interface RowSelection { selected: readonly number[]; shown: readonly number[] | null } // shown null: every row
export interface ToolTarget {
  rows: Row[];      // in shown order; empty means the button is off
  count: string;    // '2' | 'all 14'
  heading: string;  // 'on 2 selected rows' | 'on all 14 rows' | 'on 1 selected row'
}
export function toolTarget(runsOn: ToolButton['runsOn'], rows: Row[], selection: RowSelection): ToolTarget;

// workbook-store.ts, on WorkbookState
selections: Record<string, RowSelection>; // by widget id; view state
// on WorkbookActions
setSelection(tabId: string, widgetId: string, selected: number[]): void;
setShown(tabId: string, widgetId: string, shown: number[]): void; // no state change when equal to the current one
```

- [ ] **Step 1: Write the failing tests:**
  - `toolTarget`, 14 rows, `shown` = 0…13:
    - selected `[3, 1]`: rows 1 and 3 in shown order, count `'2'`, heading `'on 2 selected rows'`.
    - none selected, `selectedOrAll`: all 14, count `'all 14'`, heading `'on all 14 rows'`.
    - none selected, `selected`: no rows, count `'0'`.
    - **Review Focus 4:** selected `[20]` with `shown` = `[0, 1]`: treated as none selected, so `'all 2'`.
    - `shown: null`: every row. `shown: []`: no rows, even for `selectedOrAll`.
    - One selected row: heading `'on 1 selected row'`.
  - Store: `setSelection` then a rerun whose answer arrives → `selections[widgetId]` is gone (Review Focus 4).
    `setSelection` doesn't change `doc` or `dirty`. A second `setShown` with an equal array leaves the state object
    identical (`toBe`).
- [ ] **Step 2: Run** `npx vitest run src/workbooks/tool-buttons.test.ts src/workbooks/workbook-store.test.ts`.
  Expected: FAIL.
- [ ] **Step 3: Implement.** The store clears the widget's entry where `runWidget`'s `onAnswer` sets a `done` run.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit**: `feat: which rows a tool button runs on`

### Task 4: The run dialog takes a button's settings

**Files:**
- Modify: `web/src/results/tool-args.ts`, `web/src/results/run-tool.tsx`
- Test: `web/src/results/run-tool.test.tsx`

**Interfaces:**
- Produces:

```ts
// tool-args.ts
/** A tool button's mapping for this result: the saved column for each of the tool's parameters when the result has that
 * column, else what defaultMapping picks. Only the tool's current parameters are keys. */
export const startMapping = (tool: ExternalTool, columns: ResultColumn[], saved: ColumnMapping): ColumnMapping;

// RunToolDialog props, all optional; the Rows tab passes none of them
title?: string;                  // default `Run ${tool.name}`
initialMapping?: ColumnMapping;  // default defaultMapping(tool, columns)
onRan?: () => void;              // once, when a started run ends: answered, failed or stopped. Not on Cancel.
```

- [ ] **Step 1: Write the failing tests:**
  - `startMapping` with saved `{ id: 'resourceId' }` and a result that has `resourceId` and `id` → `{ id: 'resourceId' }`.
  - **Review Focus 2:** saved `{ id: 'gone' }` and a result with `id` → `{ id: 'id' }`. With no column matching either →
    `{ id: '' }`, and the dialog opened with it has Run disabled.
  - A saved key the tool no longer has is left out of the result.
  - `onRan` is called once after `tools.run` answers, once after it rejects, never after Cancel.
  - `title` replaces the heading. Without the new props, the existing tests pass unchanged.
- [ ] **Step 2: Run** `npx vitest run src/results/run-tool.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement.** `onRan` fires in the `finally` of the `tools.run` call.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit**: `feat: the run dialog can start from a saved mapping and report when the run ends`

### Task 5: Buttons on the widget

**Files:**
- Create: `web/src/workbooks/tool-run.tsx`, `web/src/workbooks/tool-run.test.tsx`
- Modify: `web/src/workbooks/widgets/table-widget.tsx`, `web/src/workbooks/widget-frame.tsx`,
  `web/src/workbooks/workbook-view.tsx` (pass `tabId` to `TableWidget`)

**Interfaces:**
- Consumes: Tasks 1–4; `ToolItems`' `tools.list` / `tools.edit` calls; `NoticeLine`; `MenuButton`.
- Produces:

```ts
// tool-run.tsx
/** Opens a button's run: reads tools.list, finds the tool by name, and shows RunToolDialog on the rows toolTarget chooses.
 * Problems go to onNotice. */
export function useToolRun(tabId: string, widget: Widget, onNotice: (n: Notice) => void): { open(button: ToolButton): void; dialog: ReactNode };
/** A widget's buttons for one placement: `btn`s for 'header', menu items for 'menu'. Each is labelled `${label} · ${count}`
 * and is off while its target has no rows or the widget has no ok result. */
export function ToolButtonItems(props: { tabId: string; widget: Widget; placement: ToolButton['placement']; onOpen: (b: ToolButton) => void }): ReactNode;

// table-widget.tsx
export function TableWidget(props: { widget: Widget; run: WidgetRun; tabId?: string }); // with tabId: selection through the store
```

Behaviour (screen 5):
- `TableWidget` with a `tabId` passes `selection` (from `widget.selection ?? 'multi'` and the store's `selections`, or
  `'none'`) and `onShownChange` → `setShown`. Without one, as in the editor's preview, it keeps today's behaviour.
- In the frame header, after the grow spacer and before the run time, a table widget with an ok result shows
  `2 of 14 selected` when at least one shown row is selected, then its header buttons. Menu buttons come in ⋯ after the
  Export items.
- `open(button)`: call `tools.list`. If it reports a `problem`, or doesn't answer, show a bad notice with that text and an
  **Edit tools…** action. If no tool has `button.tool` as its name, show the notice
  `There's no tool named ${button.tool} in your tools.json.` with **Edit tools…** (Review Focus 1). Otherwise show
  `RunToolDialog` with `title = `${button.label} ${target.heading}``, the target's rows **as a snapshot**, the result's
  columns and `initialMapping = startMapping(tool, columns, button.mapping)`.
- `onRan`: `after === 'refreshWidget'` → `runWidget(tabId, widget.id, { refresh: true })`; `'refreshWorkbook'` →
  `runAll(tabId, { refresh: true })`; `'none'` → nothing. The dialog belongs to the frame, outside the widget body, so a
  rerun's spinner doesn't unmount it (Review Focus 5).

- [ ] **Step 1: Write the failing tests** (`tool-run.test.tsx`, mock bridge, a workbook tab with one table widget whose
  result has `name` and `id` and 3 rows, and the button `Stop VM` mapped `{ id: 'id' }`):
  - The header shows `Stop VM · all 3`. Tick two rows → `2 of 3 selected` and `Stop VM · 2`.
  - Clicking it shows the dialog titled `Stop VM on 2 selected rows`, with the first selected row's command line
    (`commandLine` of the mock tool's command and that row's `id`). `tools.run` isn't called until **Run**, and then gets
    those 2 rows and `mapping: { id: 'id' }`.
  - `runsOn: 'selected'` with nothing selected: the button is disabled.
  - A button naming a `batch` tool, with nothing selected, says "Runs once, with 3 rows on stdin as JSON:", and Run
    sends all 3 rows.
  - A `placement: 'menu'` button is a menu item in ⋯, not in the header.
  - **Review Focus 1:** with the tool missing from `tools.list`, the click shows "There's no tool named Stop VM in your
    tools.json." and no dialog. With `problem: 'tools.json line 3: …'`, it shows that problem.
  - **Review Focus 5:** after Run answers, `query.run` is sent once for the widget with `refresh: true`. The dialog stays
    open with the output until Close. Cancel sends no `query.run`. `after: 'refreshWorkbook'` reruns every data widget.
- [ ] **Step 2: Run** `npx vitest run src/workbooks/tool-run.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run src/workbooks` and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit**: `feat: tool buttons on table widgets`

### Task 6: The editor's Tool buttons tab

**Files:**
- Modify: `web/src/workbooks/widget-editor.tsx`
- Test: `web/src/workbooks/widget-editor.test.tsx`

**Interfaces:**
- Consumes: Task 1 (`newToolButton`); `tools.list`, `tools.edit`; `commandLine`, `toolColumns`, `defaultMapping` from
  `results/tool-args.ts`; the existing `ColumnSelect`.
- Produces: a `'tools'` section, **Tool buttons**, shown only for table widgets. It edits `draft.tools` and
  `draft.selection`. Apply writes them in the same single `edit` as everything else.

Behaviour (screen 6):
- Left column: the buttons in order (label, `each` or `batch`, "in ⋯" for menu ones), **+ Add tool button**
  (`newToolButton()`, selected), then **Rows can be selected** (off → `selection: 'none'`) and **Several rows at once**
  (`multi` / `single`; disabled while selection is off).
- Right column, for the selected button: **Button label**, **Placement** (In the widget header / In the ⋯ menu), **Tool**
  (one option per tool from `tools.list`, as `${name} · once per row` or `${name} · once, rows on stdin`. A saved name
  that isn't in the list stays as `${name} (not in your tools.json)`), the chosen tool's
  `commandLine(tool.command, tool.args)` read-only in a `codeblock`, and the line "Tools come from your tools.json
  (**Edit tools…**). The workbook saves the tool's name and this column mapping, never the command."
- **Parameters from the result** (for an `each` tool): one `ColumnSelect` per `toolColumns(tool)`. Its columns come from
  the preview's result, else the widget's last result. '' ("Automatic") means `defaultMapping` picks at run time. A
  `batch` tool shows "A batch tool gets the rows on stdin as JSON." instead.
- **Runs on**: the two radios from the copy list. "Only selected rows" is disabled while selection is off, and turning
  selection off sets every button to `selectedOrAll`.
- **After it runs**: radios **Refresh this widget**, **Refresh the whole workbook**, **Nothing**.
- **Remove** removes the selected button.
- Choosing a tool sets `mapping = defaultMapping(tool, columns)`. It also sets the label to the tool's name when the label
  is empty or still the previous tool's name.
- Apply is off, with the hint "Choose a tool for each button.", while any button has no tool.

- [ ] **Step 1: Write the failing tests:**
  - A table widget has a Tool buttons tab. A chart widget doesn't.
  - Add tool button → choose `Stop VM` from the mocked list: the label becomes `Stop VM`, the command line shows, and
    `{id}` maps to `id` from the last result. Apply → the doc's widget has exactly
    `tools: [{ label:'Stop VM', tool:'Stop VM', mapping:{ id:'id' }, runsOn:'selectedOrAll', after:'refreshWidget', placement:'header' }]`
    in one undo step.
  - A widget whose button names `Gone tool` shows `Gone tool (not in your tools.json)` selected, and Apply keeps it.
  - Unticking Rows can be selected sets `selection: 'none'`, disables Only selected rows and resets a `selected` button
    to `selectedOrAll`.
  - With a new button and no tool chosen, Apply is disabled and the hint shows. Cancel leaves the doc unchanged.
- [ ] **Step 2: Run** `npx vitest run src/workbooks/widget-editor.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit**: `feat: tool buttons tab in the widget editor`

### Task 7: Docs and full check

**Files:**
- Modify: `docs/workbooks.md` (a "Selection and tool buttons" section), `docs/external-tools.md` (one paragraph: table
  widgets can have tool buttons, which name a tool here and never copy its command), `CHANGELOG.md` (Unreleased entry)

- [ ] **Step 1: Write the docs** in the spec's wording. Say plainly that a workbook stores the tool's name and column
  mapping, never a command, that a workbook from someone else only works with a tool of the same name in your own
  `tools.json`, and that every run asks first.
- [ ] **Step 2: Run the full check:** `dotnet build -warnaserror` and `dotnet test`, then in `web/`: `npm run lint`,
  `npm run typecheck`, `npm test`, `npm run build`. Expected: all pass. The only warnings are the two known ones in
  `CLAUDE.md`.
- [ ] **Step 3: Run the app** (the `run` skill) with the mock bridge. Add a table widget, give it a Stop VM button, tick
  two rows, and see `Stop VM · 2` and the dialog with the first row's command line. Run it and watch the widget refresh.
  Untick both rows, filter, and see `all N` follow the filter. Save, close, reopen, and see the button still there.
  Rename the tool in the mock list and see the notice.
- [ ] **Step 4: Commit**: `docs: workbook tool buttons`
