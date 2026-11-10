# Result workflow, plan 5: Add to workbook

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Once a query looks right, **Add to workbook…** puts it on an existing or new workbook as a Table, Chart or Stat widget, with its chart settings, parameters and highlight rules. It links to the saved query when it can, places the widget below the others, saves, and shows it.

**Architecture:**
- A pure module `web/src/workbooks/add-to-workbook.ts` builds the widget from the tab and adds it to a workbook doc,
  covering parameters and placement.
- The Chart tab's picks and which result tab is showing move from `ResultPanel` state to runtime-only per-tab state in
  the tab store, like `groupings`. That way the command palette can read them too.
- A dialog chooses the workbook, widget kind and title. An apply step writes the change:
  - through the workbook store when the workbook is open in a tab, saving it unless that tab has unsaved edits;
  - through `workbook.get` / `workbook.save` when it isn't open.

  Then it opens or focuses the tab and reveals the widget.

**Tech Stack:** React, TypeScript, Zustand, Vitest. There's no host change, since workbooks are opaque to the host.

**Spec:** `docs/design/specs/2026-11-10-result-workflow-design.md` §8.

**Branch:** `feat/add-to-workbook`, in the worktree `.worktrees/add-to-workbook`, off `origin/main` at `6e60ac2`.

## Global Constraints

- No warnings, none suppressed: `npm run format:check` (CI runs it first), `npm run lint` and `npm run typecheck` in
  `web/`.
  - The known open oxlint warnings are `react(incompatible-library)` in `result-grid.tsx`, and `react(immutability)` in
    `explain-view.tsx` and `kql-editor.tsx`.
  - Non-component helpers go in non-component modules.
- **Offered for** query tabs whose source is `graph`, `hunting`, `arg` or `logs` and whose last run went to that source
  and kept its text. That is `filterable(tab)` from `web/src/results/smart-filter.ts`, with the run's outcome `ok`.
  Not offered for raw request or workbook tabs.
- **Default widget kind:**
  - **Chart** when the tab's result view is the Chart tab.
  - **Stat** for a one-row result whose only number column is its only column, or a one-row, one-column number result.
  - **Table** otherwise.
- **Title** defaults to the tab's title.
- **Query:**
  - The widget **links** when the tab has a `savedId` and isn't dirty: `saved: { id, name }`, with source, text, options,
    parameters and highlights copied as the last copy, exactly as `fromSaved` and `addSaved` do. Otherwise the query is
    **copied in** (`saved: null`).
  - The dialog shows `Save the query first to link it.` when copying.
  - Source, options and highlight rules always come along. `withHighlights` leaves the key out when there are none.
- **Chart settings:** for a Chart widget, the tab's Chart picks (type, x axis, values, split, stacking: `Picked`) become
  the widget's `chart`.
- **Parameters:** each `{name}` in the query text (`findParams`) becomes a workbook parameter, made from the tab's
  `ParameterDef`, when the workbook has no parameter of that name. The widget takes it as `{ from: 'workbook', value: '' }`.
  If one of that name exists, the widget uses it as it is.
  - New workbook parameters get `label: null, multi: false, all: false, remember: false, huntingTimespan: false`.
- **Place:** at the top level, below the lowest top-level widget. Table and Chart are full width (`COLUMNS` = 12), with
  `MIN_SIZE`'s height for their type. A Stat is `MIN_SIZE.stat`.
  - A workbook already at `MAX_WIDGETS` (100) can't take more: the workbook is listed but disabled, with the title
    `This workbook is full`.
- **Saving:**
  - Workbook open in a tab, no unsaved edits: add through `useWorkbooks.getState().edit(...)`, then `saveWorkbook(tabId)`.
  - Open with unsaved edits: add to the draft through `edit`, don't save, and show the notice
    `Added to your unsaved changes in <name>.`
  - Not open: `workbook.get` → `parseWorkbook` → add → `workbook.save` (with `withFileVersion`) → open it in a tab.
  - New workbook: `newWorkbook(name)` with the folder → add → `workbook.save` → open it in a tab.

  Then the workbook's tab comes to the front and the new widget is revealed: scrolled into view and focused.
- **Copy:**
  - The command and menu item: `Add to workbook…`. The dialog title: `Add to workbook`.
  - Sections: `Workbook` (a search box `Find a workbook`, the list grouped by folder, and `New workbook` with `Name` and
    `Folder`), `Widget` (Table, Chart, Stat) and `Title`.
  - The buttons: `Add` and `Cancel`.
  - Errors use the codebase's `… couldn’t be …` style, e.g. `The query couldn’t be added: <reason>.`
- **Accessibility:** the dialog is `role="dialog"` with a label. Esc cancels. Focus starts in the search box and returns to
  where it was. The workbook list is keyboard navigable, as a radio group or listbox.

## Rulings in this plan (for the owner to check)

- **Where it's offered.** Query tabs have no ⋯ menu, and the result bar has no room for another button (plan 3). So
  **Add to workbook…** is in the command palette and in the result bar's **Export** menu, as its last item after a
  separator. The spec's "⋯ menu, result bar and palette" becomes "Export menu and palette".
- **Log Analytics tabs are included.** Workbooks support Log Analytics widgets, which came after the spec.
- **The Chart picks and the shown result tab** become runtime-only per-tab state in the tab store, never saved, so the
  palette command knows them.

## Review Focus

1. **A dirty open workbook:** the widget goes into the draft and the file isn't written. The notice shows. Pinned in Task 3.
2. **A workbook read that fails, or a workbook that's gone** (`workbook.get` returns null): an error notice, nothing written,
   no tab opened. Pinned in Task 3.
3. **Parameters already in the workbook:** they're never changed or duplicated, even when the tab's definition differs.
   Pinned in Task 1.
4. **Linked when saved and clean, copied otherwise:** a dirty saved tab copies, and shows the note. Pinned in Tasks 1 and 3.
5. **Solution hash:** a copied widget without highlights has no `highlights` key, so an installed workbook isn't touched in
   an unexpected way. Pinned in Task 1.

---

### Task 1: Building the widget and adding it to a doc

**Files:**
- Create: `web/src/workbooks/add-to-workbook.ts`
- Test: `web/src/workbooks/add-to-workbook.test.ts`

**Interfaces:**
- Consumes: `Tab` (tab-store), `RunResult` and `ParameterDef` (wire), `Picked` (results/chart-view), and `WorkbookDoc`,
  `Widget`, `WidgetType`, `MIN_SIZE`, `MAX_WIDGETS`, `newWidget`, `withHighlights` and `withFileVersion` (workbooks/model).
  Also `COLUMNS` (workbooks/layout) and `findParams` (params/find-params).
- Produces:

```ts
export type AddKind = 'table' | 'chart' | 'stat';
export type ResultView = 'rows' | 'chart' | 'json' | 'diagnostics'; // or the existing ResultTab type if exported
/** Chart when the view is the chart, Stat for a one-row single-number result, Table otherwise. */
export function defaultKind(result: RunResult, view: ResultView | undefined): AddKind;
/** Whether the widget will link to the tab's saved query (saved and not dirty). */
export function linksSaved(tab: Pick<Tab, 'savedId' | 'dirty'>): boolean;
/** The widget for the tab: query linked or copied, chart picks for a chart, title; layout x/y left 0 (addWidget places it). */
export function widgetFromTab(tab: Tab, kind: AddKind, title: string, chart: Picked | undefined): Widget;
/** The doc with the widget placed below the lowest top-level widget and the tab's {name} parameters added where missing. */
export function addWidget(doc: WorkbookDoc, widget: Widget, tabParameters: ParameterDef[]): WorkbookDoc;
export const isFull = (doc: Pick<WorkbookDoc, 'widgets'>): boolean => doc.widgets.length >= MAX_WIDGETS;
```

- [ ] **Step 1: Write the failing tests.**
  - `defaultKind`:
    - Chart view gives `chart`.
    - One row with one `long` column gives `stat`.
    - One row with two columns where one is a number gives `table`.
    - Three rows give `table`.
  - `widgetFromTab`:
    - A saved, clean tab gives `saved: {id, name: tab.title}` and copies text, source, options and parameters.
    - A dirty saved tab gives `saved: null`.
    - Highlights come along. With none, there's no `highlights` key.
    - A chart widget gets `chart` equal to the picks. A table widget gets no `chart`.
    - The title is set.
    - A table has `selection: 'multi'` and `tools: []`, as `newWidget` gives.
  - `addWidget`:
    - On an empty doc, a table goes to `{x:0, y:0, w:12, h:MIN_SIZE.table.h}`.
    - Below a widget ending at y 20, it goes to y 20.
    - Widgets inside a tabs widget (`in` set) are ignored for "lowest".
    - A Stat gets `MIN_SIZE.stat`.
    - Text `T | where a == {who} and b == {when}`, with a doc already having `who`, adds only `when` (from the tab's def).
      `who` stays as it was. The widget's parameters are `{ who: {from:'workbook', value:''}, when: {from:'workbook', value:''} }`.
    - The doc's other fields don't change.
  - `isFull` at 100.
- [ ] **Step 2: Run them and see them fail.** `cd web && npx vitest run src/workbooks/add-to-workbook.test.ts`
- [ ] **Step 3: Implement.** Reuse `newWidget` for the base widget, and follow `addSaved` in `workbook-view.tsx` for the
  linked-copy shape.
- [ ] **Step 4: Run them and see them pass,** then run `npm run format:check && npm run lint && npm run typecheck`.
- [ ] **Step 5: Commit.** `git commit -m "Build a workbook widget from a query tab"` (add the new files)

### Task 2: The result view kept per tab

**Files:**
- Modify:
  - `web/src/tabs/tab-store.ts`: `resultViews: Record<string, { view?: ResultView; chart?: Picked }>`, plus
    `setResultView(id, change: Partial<{ view: ResultView; chart: Picked }>)`, dropped on `close` and reset on `restore`.
    It is never in the session.
  - `web/src/results/result-panel.tsx`: the chosen result tab and the Chart picks are read from and written to the store
    instead of `useState`. Behaviour is unchanged: switching tabs and back keeps them, and a new result keeps the picks as
    today.
- Test: `web/src/tabs/tab-store.test.ts`, `web/src/results/result-panel.test.tsx`

**Interfaces:**
- Produces: `useTabs.getState().resultViews[id]` and `setResultView`. Task 3 reads them.

- [ ] **Step 1: Write the failing tests.**
  - The store sets and merges per tab, `close` drops the tab's entry, and the session snapshot never includes it.
  - The panel: choosing Chart and a type survives an unmount and remount for the same tab, and is in the store.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.** Keep `ResultPanel`'s existing reset rules, for example what happens on a new result, the same
  as today.
- [ ] **Step 4: Run them and see them pass,** plus the full web checks.
- [ ] **Step 5: Commit.** `git commit -am "Keep a tab's result view while the app runs"`

### Task 3: The dialog and applying it

**Files:**
- Create: `web/src/workbooks/add-to-workbook-dialog.tsx`, which exports `AddToWorkbookDialog`.
- Create: `web/src/workbooks/apply-add.ts`, which exports `applyAdd`.
- Modify:
  - `web/src/workbooks/workbook-store.ts`: `reveal(tabId: string, widgetId: string)` state and setter, cleared after use.
  - `web/src/workbooks/workbook-view.tsx`: scroll the revealed widget into view and focus its frame, by widget id.
- Test: `web/src/workbooks/add-to-workbook-dialog.test.tsx`, `web/src/workbooks/apply-add.test.ts`, `web/src/workbooks/workbook-view.test.tsx`

**Interfaces:**
- Consumes: Task 1, Task 2's `resultViews`, `workbook.list` (`WorkbookList`), `workbook.get`, `workbook.save`,
  `parseWorkbook`, `useWorkbooks` (`byTab`, `edit`), `saveWorkbook`, and `useTabs` (`openWorkbook`, `activate`, `tabs`).
- Produces:
  - `AddToWorkbookDialog({ tab, onClose }: { tab: Tab; onClose: () => void })`.
  - `applyAdd(target: { kind: 'existing'; id: string; name: string } | { kind: 'new'; name: string; folder: string | null }, widget: Widget, tabParameters: ParameterDef[]): Promise<{ notice?: string }>`:
    - It throws an `Error` with the user text on failure.
    - It finds an open workbook tab by `tab.workbook?.id === id` or `tab.savedId === id`.
    - It ends with that tab active and `reveal` set.

- [ ] **Step 1: Write the failing tests.** Use the mock bridge and the existing workbook-store test patterns.
  - `applyAdd`, existing workbook not open:
    - `workbook.get` returns it.
    - `workbook.save` is called with the widget added and its parameters merged.
    - A workbook tab opens, active, with the widget revealed.
  - `applyAdd`, existing workbook open and clean: the store's doc has the widget, `saveWorkbook` is called (check
    `workbook.save`), and the tab is active.
  - `applyAdd`, open and dirty:
    - The draft has the widget.
    - There's no `workbook.save`.
    - The result is `{ notice: 'Added to your unsaved changes in <name>.' }`.
  - `applyAdd`, new workbook: `workbook.save` gets a doc with the given name and folder and one widget. It opens.
  - `applyAdd`, `workbook.get` returns null: it throws `<name> no longer exists.`, with no save and no tab.
  - Dialog:
    - It lists workbooks by folder, and searching narrows the list.
    - A full workbook is disabled with the title `This workbook is full`.
    - `New workbook` needs a name, so `Add` is disabled until one is typed.
    - The widget kind defaults per `defaultKind`, from the tab's result and its `resultViews` view.
    - The title defaults to the tab title.
    - A dirty saved tab shows `Save the query first to link it.`
    - Esc cancels.
    - `Add` calls `applyAdd` and closes. On error it shows `The query couldn’t be added: <message>` and stays open.
  - Workbook view: setting `reveal` scrolls the widget's frame into view (mock `scrollIntoView`), focuses it, and clears
    `reveal`.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.** Reuse `SaveWorkbookDialog`'s name and folder fields and validation (`MAX_NAME_LENGTH`,
  `MAX_FOLDER_LENGTH`) and the existing dialog styling.
- [ ] **Step 4: Run them and see them pass,** plus the full web checks.
- [ ] **Step 5: Commit.** `git commit -am "Add a query to a workbook from a dialog"` (add the new files)

### Task 4: Where it's offered

**Files:**
- Modify:
  - `web/src/app.tsx`: a palette command `{ id: 'workbook.addQuery', title: 'Add to workbook…', group: 'Workbooks' }`,
    enabled per the Global Constraints, which opens the dialog for the active tab. Render `AddToWorkbookDialog` when open,
    the same way the other dialogs are rendered, so it counts for `dialogOpen`.
  - `web/src/results/result-panel.tsx`: the Export menu gets a separator and `Add to workbook…` when an `onAddToWorkbook`
    prop is given. `app.tsx` passes it only when the command is enabled.
- Test: `web/src/app.test.tsx`, `web/src/results/result-panel.test.tsx`

**Interfaces:**
- Consumes: Task 3's dialog.
- Produces: the palette command and the Export menu item.

- [ ] **Step 1: Write the failing tests.**
  - The palette lists `Add to workbook…` for a hunting tab after an ok run, and opens the dialog.
  - It's disabled for a raw tab, a workbook tab, a tab that hasn't run, and a tab whose source changed since the run.
  - The Export menu shows `Add to workbook…` only with `onAddToWorkbook`, and choosing it calls the prop.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and see them pass,** plus the full web checks.
- [ ] **Step 5: Commit.** `git commit -am "Offer Add to workbook from the palette and the Export menu"`

### Task 5: Docs

**Files:**
- Modify: `CHANGELOG.md` (Unreleased › Added), `docs/workbooks.md` (adding a query from a query tab), `README.md` (the
  Workbooks bullet, if it fits), and `docs/manual-checks.md` (a new `### Add to workbook (2026-11-10)` section after
  Highlight rules).

- [ ] **Step 1: Write the docs.**
  - Changelog: **Add to workbook**:
    - Put a query on a workbook from the Export menu or the palette.
    - Choose a workbook or make one, and choose a Table, Chart or Stat widget.
    - A saved query is linked, and anything else is copied in.
    - Chart settings, parameters and highlight rules come along.
  - Manual checks:
    - Add a saved query as a Table to a closed workbook: it opens, scrolled to the widget, which is linked.
    - Add a dirty query as a Chart to an open workbook with no edits: it saves, and the widget has the chart picks.
    - Add to an open workbook with unsaved edits: you see the notice, and the file isn't saved.
    - Add to a new workbook.
    - A query with `{name}` parameters adds them to the workbook.
    - Light and dark themes.
- [ ] **Step 2: Run the full checks.** `dotnet build -warnaserror && dotnet test`, and `cd web && npm run format:check && npm run lint && npm run typecheck && npm test`.
- [ ] **Step 3: Commit.** `git commit -am "Document Add to workbook"`. Don't push.
