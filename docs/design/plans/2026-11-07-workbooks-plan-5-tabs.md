# Workbooks plan 5: tabs, implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `tabs` container widget whose tabs each hold a grid of widgets. Only the visible tab runs, and widgets move
between tabs by drag or by "Move to…".

**Architecture:** Widgets stay one flat list. A widget inside a tab carries `in: {tabs, tab}`, and every grid operation
(`layout.ts`) works on one *place*'s siblings. Pure helpers in a new `web/src/workbooks/tabs.ts` own places, moves and
repairs. The workbook store gains view state (`activeTabs`, `stale`) and runs only visible widgets. The view gets a reusable
`WidgetGrid` that renders a place, and a `TabsWidget` that renders a tab bar over a `WidgetGrid`.

**Tech Stack:** React 19, TypeScript, zustand, vitest + Testing Library (web); .NET 10, xUnit (host).

**Spec:** `docs/design/specs/2026-11-06-workbooks-design.md` §15 (with §5.2, §6.5, §7, §9.2 for the existing behaviour).

## Global Constraints

- CLAUDE.md: warnings are fixed, never suppressed. `dotnet build -warnaserror`, `npm run lint` (oxlint) and `npm run typecheck` must be clean, apart from the two known warnings (TanStack Virtual `incompatible-library`, Vite's Monaco chunk size).
- No new dependencies. Drag uses the existing pointer-event code in `widget-frame.tsx` (spec §12).
- Widget type name `tabs`; the file field is `in: {tabs: "<tabs widget id>", tab: "<tab id>"}`; the tabs widget carries `tabs: [{id, name}]`.
- `version` is **2** only when the doc has a tabs widget, otherwise **1**. The host accepts 1 and 2 and refuses 3 or more with "This workbook needs a newer Kustodian."
- `MAX_WIDGETS = 100` counts every widget, inside tabs or not.
- A tab name is required and at most **40** characters. Duplicates are allowed. A new tabs widget has one tab named **"Tab 1"**, and its title is hidden (`hideTitle: true`).
- No tabs inside tabs. A tabs widget is always at the top level.
- The visible tab is view state: never in the doc, never in the file, not dirty, not in undo.
- UI copy, verbatim: "No widgets on this tab"; in edit mode "Drag a widget here or use Move to…"; tab marks "not run" and "out of date"; menu item "Move to…" with the entry "Top level" and the group label being the tabs widget's title or "Tabs".
- CHANGELOG line under Unreleased for the app change.
- Work in a worktree (several agents share this repo).

## Review Focus

1. **A parameter changed while a tab is hidden, then the tab is shown.** Its affected widgets run once, with the new value, and no longer show "out of date". Test in Task 3.
2. **Delete a tab (or remove a tabs widget) that holds widgets, then Undo.** Every widget comes back in its tab, at its old layout, with the same id. Test in Task 5.
3. **Moving the last widget out of a tab, or a widget with history.** The tab shows its empty text, and the moved widget keeps its id (so its history stays). Test in Task 2.
4. **Removing the last tabs widget, then saving or exporting.** The file is written as version 1, so older apps open it. Test in Task 1.
5. **Duplicating a tabs widget that would exceed 100 widgets in total.** Duplicate is refused, the same way a single widget's Duplicate is at the limit, and nothing is half-copied. Test in Task 2.

---

## File structure

- `web/src/workbooks/model.ts`: types, `newWidget('tabs')`, parse and repair, `withFileVersion`.
- `web/src/workbooks/tabs.ts` (new): places, sibling-scoped layout, moves, tab edits, duplicate. Pure, no React.
- `web/src/workbooks/workbook-store.ts`: `activeTabs`, `stale`, `showTab`, visible-only runs.
- `web/src/workbooks/widget-grid.tsx` (new): renders one place's grid of `WidgetFrame`s (moved out of `workbook-view.tsx`).
- `web/src/workbooks/tabs-widget.tsx` (new): tab bar plus the active tab's `WidgetGrid`, view and edit mode.
- `web/src/workbooks/widget-frame.tsx`: sibling-scoped drag, cross-grid drop, "Move to…", tabs-aware Duplicate and Refresh.
- `web/src/workbooks/workbook-view.tsx`: uses `WidgetGrid`, the add menu gets "Tabs", and add goes into the selected tab.
- `web/src/workbooks/widget-editor.tsx`: for a tabs widget, only Title and Hide title.
- `web/src/styles.css`: tab bar and in-widget grid styles.
- `src/Kustodian/Workbooks/WorkbookService.cs`: accept versions 1 and 2.
- `docs/workbooks.md`, `CHANGELOG.md`.

---

### Task 1: Model, file format and host version

**Files:**
- Modify: `web/src/workbooks/model.ts`, `web/src/workbooks/workbook-store.ts` (`saveWorkbook`), `web/src/workbooks/sharing.ts` (export and import saves), `web/src/bridge.mock.ts` (accept version 2)
- Modify: `src/Kustodian/Workbooks/WorkbookService.cs:233`
- Test: `web/src/workbooks/model.test.ts`, `tests/Kustodian.Tests/Workbooks/WorkbookServiceTests.cs`

**Interfaces:**
- Produces:
  - `WidgetType = 'markdown' | 'chart' | 'table' | 'stat' | 'tabs'`
  - `interface Tab { id: string; name: string }`
  - `interface Place { tabs: string; tab: string }`
  - `Widget.tabs?: Tab[]` (tabs widgets only), `Widget.in?: Place` (absent at top level)
  - `WORKBOOK_VERSION = 2`, `WorkbookDoc.version: 1 | 2`
  - `MIN_SIZE.tabs = { w: 4, h: 12 }`
  - `MAX_TAB_NAME = 40`
  - `newWidget('tabs', layout)` returns `{type: 'tabs', title: '', hideTitle: true, tabs: [{id, name: 'Tab 1'}]}`, with no query
  - `newTabId(): string`
  - `withFileVersion(doc: WorkbookDoc): WorkbookDoc`, which sets `version` to 2 if any widget has `type === 'tabs'`, else 1
- [ ] **Step 1: Write the failing tests** in `model.test.ts`:
  - `parseWorkbook reads a version 2 file with a tabs widget`: tabs, names and children's `in` are kept.
  - `parseWorkbook refuses version 3`: returns `'This workbook needs a newer Kustodian.'`
  - `repairs: a child whose in points to a missing tabs widget or tab, or to a non-tabs widget, goes to the top level at the bottom`: `in` is gone and `layout.y` is at or below every top-level widget's bottom.
  - `repairs: a tabs widget with no tabs gets one "Tab 1"`.
  - `repairs: repeated tab ids in one tabs widget are made unique`, and children keep pointing at the first of them.
  - `repairs: a tabs widget with in is moved to the top level` (no nesting).
  - `repairs: tab names are trimmed to 40 characters, and an empty name becomes "Tab N"` (N is its position from 1).
  - `overlaps are repaired per place`: two widgets with the same layout, one top level and one in a tab, both keep their layout.
  - `withFileVersion writes 1 without a tabs widget and 2 with one` (Review Focus 4: build a doc with tabs, remove the tabs widget, and expect 1).
  - `newWidget('tabs') has one tab "Tab 1", hideTitle, and no query`.
- [ ] **Step 2: Run** `cd web && npx vitest run src/workbooks/model.test.ts`. Expected: the new tests fail.
- [ ] **Step 3: Implement** the types and `newWidget` case. In `parseWidget`, read `tabs` (only for type `tabs`) and `in`. Clamp a tabs widget's layout like the others, using `MIN_SIZE.tabs`.
  - In `parseWorkbook`, after `uniqueIds`, call a new `repairTabs(widgets: Widget[]): Widget[]`, kept in `model.ts`, which applies the repairs tested above. Then run `repairOverlaps` once per place, grouping widgets by `placeKey`. Top-level widgets moved by the repair go below the top-level bottom.
  - `parseWorkbook` sets `version` with `withFileVersion`.
  - Apply `withFileVersion` to the doc sent by `saveWorkbook` (`workbook.save`), by sharing's export (`file.saveAs` content), and by import's `workbook.save` and `workbook.check`.
  - The widget editor's exhaustive `switch`es over `WidgetType` get a `tabs` case so `tsc` passes. Its UI is done in Task 4.
- [ ] **Step 4: Host.**
  - Test: `WorkbookServiceTests` gets `Save_accepts_version_2` and `Save_refuses_version_3` (the message is "This workbook needs a newer Kustodian.").
  - Then change the check at `WorkbookService.cs:233` to `number is < 1 or > 2`, and update `bridge.mock.ts` the same way.
- [ ] **Step 5: Run** `cd web && npm test && npm run typecheck && npm run lint`, then `dotnet build -warnaserror && dotnet test`. Expected: all pass, with no new warnings.
- [ ] **Step 6: Commit** `feat(workbooks): tabs widget in the model and file format (version 2)`.

### Task 2: Places, moves and tab edits (`tabs.ts`)

**Files:**
- Create: `web/src/workbooks/tabs.ts`, `web/src/workbooks/tabs.test.ts`

**Interfaces:**
- Consumes (from Task 1): `Widget`, `Tab`, `Place`, `newTabId`, `MAX_WIDGETS`, `MAX_TAB_NAME`.
- Consumes (from `layout.ts`): `place`, `compact`.
- Produces:
  - `placeOf(w: Widget): Place | null`
  - `placeKey(p: Place | null): string`, which is `''` for the top level, else `${tabs}/${tab}`
  - `siblings(widgets: Widget[], p: Place | null): Widget[]`
  - `withinPlace(widgets: Widget[], p: Place | null, change: (sibs: Widget[]) => Widget[]): Widget[]`, which applies a layout change to one place and leaves the rest untouched
  - `childrenOf(widgets: Widget[], tabsId: string, tab?: string): Widget[]`
  - `moveTo(widgets: Widget[], id: string, to: Place | null, at?: { x: number; y: number }): Widget[]`. The widget keeps its id and size (w clamped to 12). Without `at` it lands at the bottom of the destination; with `at` it goes there and the destination reflows (`layout.move` on the destination siblings). The source place is compacted. A tabs widget, or a `to` that names a missing tab, returns `widgets` unchanged.
  - `addTab(widgets, tabsId, name?: string): { widgets: Widget[]; tab: Tab }`. The default name is `Tab ${n + 1}`.
  - `renameTab(widgets, tabsId, tabId, name: string): Widget[]`. The name is trimmed and cut to 40; an empty name returns `widgets` unchanged.
  - `moveTab(widgets, tabsId, tabId, by: -1 | 1): Widget[]`
  - `reorderTab(widgets, tabsId, tabId, toIndex: number): Widget[]`
  - `deleteTab(widgets, tabsId, tabId, children: 'move' | 'delete'): Widget[]`. `move` sends the tab's widgets to the neighbouring tab (the next one, else the previous one), at the bottom. Deleting the last tab removes the tabs widget and treats its children by `children`, where `move` means the top level.
  - `removeTabs(widgets, tabsId, children: 'move' | 'delete'): Widget[]`. `move` sends every child to the top level, below everything, keeping each tab's widgets together in tab order.
  - `duplicateWidget(widgets, id): Widget[] | null`. For a tabs widget it copies the tabs (with new tab ids) and every child (with new widget ids, `in` remapped). The copies carry no `history` field. It returns `null` when the result would have more than `MAX_WIDGETS` widgets. The copy is placed with `layout.place` among its siblings.
  - `destinations(widgets): { label: string; to: Place | null }[]` for "Move to…": `{label: 'Top level', to: null}`, then each tabs widget's tabs in order, labelled by tab name. Group by `group: string` (the tabs widget's title, or `'Tabs'`).
- [ ] **Step 1: Write the failing tests** in `tabs.test.ts`, one per function above, including:
  - `moveTo out of the last widget of a tab leaves the tab empty and keeps the id` (Review Focus 3).
  - `moveTo keeps history on the moved widget`.
  - `moveTo with at reflows the destination and compacts the source`.
  - `moveTo refuses a tabs widget and a missing tab`.
  - `deleteTab move sends children to the next tab, else the previous`.
  - `deleteTab of the last tab removes the tabs widget and moves children to the top level`.
  - `removeTabs delete removes every child`.
  - `duplicateWidget copies a tabs widget with new tab and widget ids and remapped in`.
  - `duplicateWidget returns null over 100 widgets and changes nothing` (Review Focus 5: 60 widgets including a tabs widget with 45 children).
  - `renameTab cuts to 40 and ignores empty`.
  - `destinations lists Top level then tabs grouped by title or "Tabs"`.
- [ ] **Step 2: Run** `cd web && npx vitest run src/workbooks/tabs.test.ts`. Expected: the tests fail.
- [ ] **Step 3: Implement** `tabs.ts`.
- [ ] **Step 4: Run** the same command. Expected: PASS. Then run `npm run typecheck && npm run lint`.
- [ ] **Step 5: Commit** `feat(workbooks): place-scoped moves and tab edits`.

### Task 3: Running only what is visible (store)

**Files:**
- Modify: `web/src/workbooks/workbook-store.ts`
- Test: `web/src/workbooks/workbook-store.test.ts`

**Interfaces:**
- Consumes: `placeOf`, `childrenOf` (Task 2).
- Produces:
  - `WorkbookState.activeTabs: Record<string, string>`, mapping tabs widget id to tab id. It is view state, and a missing entry means the first tab.
  - `WorkbookState.stale: Record<string, true>`: widget ids whose shown result is out of date.
  - `visibleTab(s: WorkbookState, tabsId: string): string | undefined`. This is the active tab if it still exists, else the first tab.
  - `isVisible(s: WorkbookState, w: Widget): boolean`
  - `WorkbookActions.showTab(tabId: string, tabsId: string, tab: string): void`. It sets `activeTabs` and runs that tab's data widgets whose run is `idle` or that are `stale`. A widget that is waiting or running is left alone.
  - `WorkbookActions.refreshTab(tabId: string, tabsId: string): Promise<void>`, which runs the visible tab's widgets with `{refresh: true}`.
- Behaviour changes:
  - `runAll` runs only visible data widgets. Hidden ones whose run is `done` or `failed` are marked `stale`, and `idle` ones stay idle. This covers load, Refresh all, a tool button's `refreshWorkbook` and the parameters dialog.
  - `setWorkbookValue`'s rerun runs the visible widgets from `widgetsUsing` and marks the hidden ones `stale` (only those that have run; idle ones stay idle).
  - `runWidget` clears `stale` for that widget when it queues the run.
  - Leaving a tab never drops its jobs.
- [ ] **Step 1: Write the failing tests** in `workbook-store.test.ts`, using the existing bridge mock:
  - `load runs plain widgets and each tabs widget's first tab only`.
  - `showTab runs an unrun tab once`.
  - `showTab back to a tab that ran doesn't rerun`.
  - `a parameter change reruns visible widgets and marks hidden ones that ran as stale` (only those that use the parameter).
  - `showTab on a stale tab reruns its stale widgets once with the new value, and clears stale` (Review Focus 1: the run's parameters show the new value, and the bridge got exactly one `query.run` per widget).
  - `Refresh all marks hidden tabs stale`.
  - `leaving a tab mid-run lets the run finish and keeps its result`.
  - `visibleTab falls back to the first tab when the active one was deleted`.
  - `activeTabs isn't in the doc and doesn't make it dirty`.
- [ ] **Step 2: Run** `cd web && npx vitest run src/workbooks/workbook-store.test.ts`. Expected: the new tests fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the full web suite with typecheck and lint. Expected: all pass.
- [ ] **Step 5: Commit** `feat(workbooks): only the visible tab runs`.

### Task 4: Showing tabs (view mode) and adding a tabs widget

**Files:**
- Create: `web/src/workbooks/widget-grid.tsx`, `web/src/workbooks/tabs-widget.tsx`, `web/src/workbooks/tabs-widget.test.tsx`
- Modify: `web/src/workbooks/workbook-view.tsx`, `web/src/workbooks/widget-frame.tsx` (Refresh on a tabs widget calls `refreshTab`, and a tabs widget's ⋯ menu has only Refresh and Full screen), `web/src/workbooks/widget-editor.tsx` (a tabs widget shows only Title and "Hide the title bar outside edit mode"), `web/src/styles.css`
- Test: `web/src/workbooks/workbook-view.test.tsx`, `web/src/workbooks/edit-mode.test.tsx`

**Interfaces:**
- Consumes: `siblings`, `childrenOf` (Task 2); `activeTabs`, `stale`, `visibleTab`, `showTab`, `refreshTab` (Task 3).
- Produces:
  - `WidgetGrid({ tabId, place, editing, body }: { tabId: string; place: Place | null; editing: GridEditing | undefined; body: (w: Widget) => ReactNode })`. This is the existing grid markup moved out of `workbook-view.tsx` (`narrowOrder` over `siblings`). The grid element carries `data-wb-place={placeKey(place)}`.
  - `GridEditing` holds what the view passes today per widget (`selected`, `onSelect`, `onEditWidget`, `onRemove`, `announce`), plus `selectedPlace` and `onSelectPlace(p: Place | null)`.
  - `TabsWidget({ tabId, widget, editing, body })` has a `role="tablist"` bar with one `role="tab"` per tab (`aria-selected`, roving focus with arrow keys, Home/End). Each tab carries `data-wb-tab={tabId}` and `data-wb-tabs={widget.id}`, and shows the "not run" mark when any of its data widgets is `idle`, or "out of date" when any is `stale`. Under the bar is a `role="tabpanel"` holding `WidgetGrid` for the visible tab, scrolling inside the widget's height. An empty tab shows "No widgets on this tab"; in edit mode it shows "Drag a widget here or use Move to…".
- [ ] **Step 1: Write the failing tests** in `tabs-widget.test.tsx` and `workbook-view.test.tsx`:
  - `a workbook with a tabs widget shows plain widgets and the first tab's widgets only`.
  - `clicking a tab shows its widgets and calls showTab`.
  - `arrow keys move between tabs`.
  - `tab marks show "not run" and "out of date"`.
  - `an empty tab shows its text`, in both view and edit mode.
  - `the add menu has Tabs, which adds a tabs widget with Tab 1`.
  - `a widget added while a tab's grid is selected goes into that tab`. Selecting a tab's grid means clicking its empty area in edit mode, which sets `selectedPlace`.
  - `the tabs widget's Refresh reruns the visible tab only`.
  - `Edit widget on a tabs widget shows only Title and Hide title`.
  - `narrow: the tab's grid stacks full width like the top level` (the `wb-grid` class is on the inner grid).
- [ ] **Step 2: Run** these tests. Expected: they fail.
- [ ] **Step 3: Implement.** `workbook-view.tsx`'s `body` gets `case 'tabs'`, which renders `TabsWidget`. `addNew` and `addSaved` place the new widget with `layout.place(siblings(...))` and set `in` to `selectedPlace` when it is a tab. "Tabs" is an add-menu entry (it is disabled when `full`, like the others).
- [ ] **Step 4: Run** the full web suite with typecheck and lint.
- [ ] **Step 5: Commit** `feat(workbooks): tabs widget view and add`.

### Task 5: Editing tabs

**Files:**
- Modify: `web/src/workbooks/tabs-widget.tsx`, `web/src/workbooks/widget-frame.tsx` (Duplicate and Remove on a tabs widget), `web/src/workbooks/workbook-view.tsx` (`removeWidget` for tabs)
- Test: `web/src/workbooks/tabs-widget.test.tsx`, `web/src/workbooks/edit-mode.test.tsx`

**Interfaces:**
- Consumes: `addTab`, `renameTab`, `moveTab`, `reorderTab`, `deleteTab`, `removeTabs`, `duplicateWidget`, `childrenOf` (Task 2). Every change goes through `store.edit` (undo plus dirty).
- Produces the edit-mode UI:
  - **"+" button.** "Add tab" adds a tab, shows it, and focuses its name for renaming.
  - **Renaming.** Double-click or Enter on a focused tab opens an inline rename box. Enter or blur commits, and Esc cancels. `maxLength` is 40, and an empty name keeps the old one.
  - **The tab menu** (a small ⋯ on the selected tab, using `MenuButton`) has Rename, Move left, Move right and Delete. Move left and Move right are disabled at the ends.
  - **Dragging a tab** in the bar reorders it with pointer events (`reorderTab`).
  - **Delete-tab confirm**, only when the tab has widgets: "Delete <name>? It has N widgets." Its buttons are "Move them to <neighbour name>" (the default, autofocused), "Delete them too" and Cancel. On the last tab, the move button says "Move them to the top level".
  - **Removing a tabs widget** that has children shows the same confirm, titled "Remove <title or 'Tabs'>? It has N widgets.", with "Move widgets to the top level" (the default), "Delete them too" and Cancel.
  - **Duplicate on a tabs widget** uses `duplicateWidget`. When it returns `null`, Duplicate is disabled with the existing at-the-limit title.
  - Model the confirm on `ClearConfirm`'s structure (`role="dialog"`, focus back to the opener).
- [ ] **Step 1: Write the failing tests:**
  - `Add tab adds and focuses a rename box`.
  - `rename commits on Enter, cancels on Esc, and keeps the old name when empty`.
  - `Move left and Move right reorder, and are disabled at the ends`.
  - `deleting an empty tab asks nothing`.
  - `deleting a tab with widgets asks, and Move them moves them to the next tab`.
  - `Delete them too deletes them`.
  - `Undo after deleting a tab with widgets brings back the tab and its widgets with the same ids and layouts` (Review Focus 2).
  - `removing a tabs widget asks, moves widgets to the top level, and Undo restores everything` (Review Focus 2).
  - `Duplicate on a tabs widget copies its tabs and children`, and is disabled over the limit.
- [ ] **Step 2: Run** these tests. Expected: they fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the full web suite with typecheck and lint.
- [ ] **Step 5: Commit** `feat(workbooks): add, rename, reorder and delete tabs`.

### Task 6: Moving widgets between tabs

**Files:**
- Modify: `web/src/workbooks/widget-frame.tsx`, `web/src/workbooks/tabs-widget.tsx`, `web/src/styles.css`
- Test: `web/src/workbooks/edit-mode.test.tsx`

**Interfaces:**
- Consumes: `siblings`, `withinPlace`, `moveTo`, `destinations`, `placeOf` (Task 2); `showTab` (Task 3); the `data-wb-place` and `data-wb-tab` attributes (Task 4).
- Behaviour:
  - **Within one grid.** `shifted` and `commit` work on `siblings(doc.widgets, placeOf(widget))` through `withinPlace`, so a move or resize inside a tab never touches widgets in other places. The keyboard grip moves stay within the place.
  - **Across grids.**
    - On pointer move, `document.elementFromPoint` finds the `[data-wb-place]` under the pointer. A different place gets the `wb-drop` class (an outlined grid).
    - Over a `[data-wb-tab]` that isn't shown, a 500 ms hover timer calls `showTab`. The timer is cancelled when the pointer leaves the tab.
    - On pointer up over a different place, the cell under the pointer is computed from that grid's rect (column pitch `(width + GAP_PX) / COLUMNS`, row pitch `ROW_PX + GAP_PX`), and one `edit` applies `moveTo(..., to, at)`.
    - A tabs widget can only drop at the top level: over a tab's grid, its drop does nothing.
    - Esc still cancels the drag, and announces "Moved to <tab name>" or "Moved to the top level".
  - **"Move to…"** is in the ⋯ menu in edit mode, for widgets other than tabs widgets. It opens a submenu (or a small listbox popover, keyboard-operable) listing `destinations(doc.widgets)` grouped by `group`, with the current place marked "(here)" and disabled. Choosing an entry applies `moveTo` without `at`, announces it, and keeps focus on the moved widget's grip.
- [ ] **Step 1: Write the failing tests:**
  - `moving or resizing a widget inside a tab leaves top-level widgets untouched`.
  - `Move to… lists Top level and each tab, grouped, with here disabled`.
  - `Move to… moves a widget to another tab at the bottom, keeps its id, and announces it`.
  - `Move to… works from the keyboard`.
  - `a tabs widget has no Move to…`.
  - `a pointer drag dropped over another tab's grid moves the widget there`. Stub `document.elementFromPoint` and `getBoundingClientRect` in jsdom.
  - `hovering a hidden tab for 500 ms while dragging shows it` (fake timers).
  - `Undo after a move puts the widget back`.
- [ ] **Step 2: Run** these tests. Expected: they fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the full web suite with typecheck and lint.
- [ ] **Step 5: Commit** `feat(workbooks): move widgets between tabs by drag or Move to`.

### Task 7: Docs and full check

**Files:**
- Modify: `docs/workbooks.md` (a "Tabs" section: what it is, only the visible tab runs, marks, adding and editing tabs, moving widgets, "files with tabs need this version or later"), `CHANGELOG.md` (Unreleased → Added: "Workbooks can group widgets in tabs. Only the tab you're looking at runs its queries.")
- [ ] **Step 1: Write the docs and the CHANGELOG line.**
- [ ] **Step 2: Full check.** Run `cd web && npm test && npm run typecheck && npm run lint && npm run build`, then `dotnet build -warnaserror && dotnet test`. Expected: all pass, with only the two known warnings.
- [ ] **Step 3: Browser check** with the web build and the bridge mock: build a workbook with a tabs widget of three tabs, then:
  - check that switching tabs runs each one once;
  - change a parameter and see "out of date" on the hidden tabs;
  - move a widget by drag and by "Move to…";
  - delete a tab with widgets and undo it.
  Take a screenshot for the PR.
- [ ] **Step 4: Commit** `docs(workbooks): tabs`.
