# Result workflow, plan 3: grouping

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Grouping in the Rows grid goes up to three nested columns, can be chosen from a column header's menu, shows a `Grouped by A › B` chip, sorts groups by size, offers Filter by / Exclude on a group row, works from the keyboard, and survives tab switches and reruns while the app runs.

**Architecture:** This extends the existing TanStack grouping in `web/src/results/result-grid.tsx`.

- First, a pure refactor moves `Menu`, `MenuButton` and `FilterItems` into their own module. That ends the grid ↔ popover
  import cycle and the copied clamp code that plan 2's reviews flagged.
- Grouping state moves from the grid component to the tab store as runtime-only per-tab state, like `cursors`. It is
  never written to the session.
- The grid takes it as controlled props, and falls back to its own state for table widgets and the Compare view.

**Tech Stack:** React, TypeScript, Zustand, TanStack Table, Vitest.

**Spec:** `docs/design/specs/2026-11-10-result-workflow-design.md` §6 (and §3: grouping isn't saved, and isn't in workbook widgets).

**Branch:** `feat/grouping`, in the worktree `.worktrees/grouping`, off `origin/main` at `6abe2bc`.

## Global Constraints

- No warnings, none suppressed: `npm run format:check` (CI runs it first), `npm run lint` and `npm run typecheck`. The known
  open warnings are `react(incompatible-library)` in `result-grid.tsx` and `react(immutability)` in `explain-view.tsx` and
  `kql-editor.tsx`. Add none. A non-component export from a component module trips `react(only-export-components)`, so put
  helpers in non-component modules.
- At most **3** grouping columns, nested in the order chosen.
- Groups start **closed**. Groups are sorted by row count, largest first, at every level. Ties keep the order TanStack
  gives (value order).
- Grouping is kept per query tab while the app runs: across tab switches, and across reruns for each column the new result
  still has. It is never saved: not in the session, the library or workbooks.
- Sorting, the row filter, row selection, Run tool, row details, copy and export keep working on the rows inside groups.
  Export and copy write the rows ungrouped.
- Copy:
  - The header menu item is `Group by this column`. When the column is already grouped it reads `Stop grouping by this
    column`. When three columns are already grouped, the item is disabled with the title `Up to 3 columns`.
  - The chip reads `Grouped by A › B`, and its clear button is labelled `Clear grouping`.
  - A group row reads `<column>: <value> · <count>`, with `null` for an empty value.
- Workbook table widgets, history tables and the Compare view keep their own grid state and get no header menu (no
  `statistics` prop). They keep today's single-column toolbar grouping behaviour, apart from the count order.

## Rulings in this plan (for the owner to check)

- **The toolbar Group by menu becomes multi-select.** Today its items are radio buttons for a single column. They become
  `menuitemcheckbox` items: checking one adds it at the end, unchecking removes it. At three columns the unchecked ones are
  disabled. `No grouping` clears all. The button text becomes `Group by: A › B`. This is how "both add to the same grouping"
  (spec §6) works with nesting.
- **A group row's Filter by / Exclude value** is the first leaf row's original value in that column. The grouping value
  itself is display text (`cellText`), so it can't be used.

## Review Focus

1. **A rerun whose result drops a grouped column:** grouping keeps the columns that still exist, in order, and the chip
   says so. It never groups by a missing column or throws. Pinned in Task 2.
2. **Closing a tab:** its grouping is dropped from the store, so it doesn't leak memory or come back if the id is reused.
   Pinned in Task 2.
3. **Selection and Run tool with groups closed:** "All n rows" still means every row the filter lets through, including
   rows in closed groups (`filteredLeaves`). Pinned in Task 3.
4. **Keyboard:** Tab reaches a group row's toggle. Right opens it, Left closes it, and Left on an open child level doesn't
   close the parent. Up/Down selection still skips group rows. Pinned in Task 3.
5. **An empty group value:** `null` shows. Filter by on it writes `isempty(Col)` / `isnull(Col)` through the existing
   `filterCondition`. Pinned in Task 3.

---

### Task 1: Menu components in their own module

**Files:**
- Create: `web/src/results/menu.tsx` (`Menu`, `MenuButton`, `FilterItems`, `OnFilter`, `FILTER_VERB`, moved verbatim with
  their doc comments).
- Create: `web/src/results/keep-inside.ts`: `export function keepInside(el: HTMLElement, at: { x: number; y: number }, opts?: { capHeight?: boolean }): void`.
  It holds the clamp `Menu` and `ColumnStatsPopover` both use today. With `capHeight`, it also sets `maxHeight` from the
  parent's `clientHeight`, as the popover does now.
- Modify: `web/src/results/result-grid.tsx`, `web/src/results/column-stats-popover.tsx`, `web/src/results/row-details.tsx`,
  and every other importer of those names (grep for them), to import from `./menu`.
- Test: the existing tests stay green. Add `web/src/results/keep-inside.test.ts` with mocked sizes, covering both the clamp
  and the cap.

**Interfaces:**
- Produces: `./menu` exports exactly the names above, with unchanged signatures, and `./keep-inside` exports `keepInside`.

- [ ] **Step 1: Write `keep-inside.test.ts`** (clamps x and y into the parent; caps `maxHeight` only with `capHeight`) and see it fail.
- [ ] **Step 2: Move the code.** Make no behaviour change. `result-grid.tsx` no longer exports any component other than
  `ResultGrid` (and what it already exported for other modules, which must now come from `./menu`).
- [ ] **Step 3: Check there is no cycle:** `grep -n "from './result-grid'" web/src/results/menu.tsx web/src/results/column-stats-popover.tsx`
  prints nothing.
- [ ] **Step 4: Run** `cd web && npm run format:check && npm run lint && npm run typecheck && npm test`. Expected: all pass,
  and lint shows only the known warnings.
- [ ] **Step 5: Commit.** `git commit -m "Move the result menus into their own module"` (add the new files first).

### Task 2: Grouping kept per tab

**Files:**
- Modify: `web/src/tabs/tab-store.ts`: `groupings: Record<string, string[]>`, `setGrouping(id: string, columns: string[]): void`,
  and the tab's entry removed on `close`. Not in the session: check `Session`/`SessionTab` building is untouched, and add a test.
- Modify: `web/src/results/result-grid.tsx`: optional controlled props `grouping?: string[]` and
  `onGroupingChange?: (columns: string[]) => void`. Without them, the grid keeps its own state as today.
- Modify: `web/src/results/result-panel.tsx`: read and write the tab's grouping from the store, for the Rows grid only.
- Test: `web/src/tabs/tab-store.test.ts`, `web/src/results/result-grid.test.tsx`, `web/src/results/result-panel.test.tsx`

**Interfaces:**
- Produces:
  - `useTabs.getState().groupings[id]` and `setGrouping(id, columns)`.
  - `ResultGrid` props `grouping?` and `onGroupingChange?`.
  - The grid shows only the grouping columns the current `columns` have. When a rerun drops one, it calls
    `onGroupingChange` once with the filtered list. Expanded state resets to all closed on new rows.

- [ ] **Step 1: Write the failing tests.**
  - Store: `setGrouping` stores per id; `close` removes it; the session built for saving has no grouping.
  - Grid, controlled:
    - It renders groups for the given `grouping`.
    - Choosing in the toolbar menu calls `onGroupingChange`.
    - New `columns` without one grouped column call `onGroupingChange` with it removed.
  - Panel: grouping chosen on tab A survives unmounting and remounting the panel for tab A. Switching tabs remounts it,
    keyed by tab id.
- [ ] **Step 2: Run them and see them fail.** `cd web && npx vitest run src/tabs/tab-store.test.ts src/results/result-grid.test.tsx src/results/result-panel.test.tsx`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and see them pass,** then run the full web checks.
- [ ] **Step 5: Commit.** `git commit -am "Keep a tab's grouping while the app runs"`

### Task 3: Nested grouping, header menu, chip and group rows

**Files:**
- Modify: `web/src/results/result-grid.tsx`
- Modify: the styles file the grid uses, only if a group-row indent or chip needs a class (reuse existing chip classes,
  like the chart filter chip in `result-panel.tsx`).
- Test: `web/src/results/result-grid.test.tsx`

**Interfaces:**
- Consumes: Task 1's `./menu`, and Task 2's controlled grouping.
- Produces the UI in the Global Constraints:
  - The header menu gets `Group by this column`, after `Column statistics`, in the same menu.
  - The toolbar menu becomes multi-select (see the plan rulings).
  - The `Grouped by A › B` chip with `Clear grouping` goes in the toolbar slot, next to the Group by button.
  - Group rows are indented by depth (`row.depth`) and show `<column>: <value> · <count>` with the chevron.
  - Groups are sorted by leaf count, largest first, at every depth. Implement it by ordering each level's grouped rows by
    `getLeafRows().length`, in the row model the grid renders (after TanStack's model). Keep any user sort on leaf rows.
  - Left/Right on a focused group toggle closes and opens it.
  - Right-clicking a group row opens `Menu` with `FilterItems`, for the group's column and the first leaf's original value,
    when `onFilter` is given.

- [ ] **Step 1: Write the failing tests.**
  - Header menu: `Group by this column` groups by it.
    - On a grouped column it reads `Stop grouping by this column` and removes it.
    - With 3 grouped columns it is disabled with the title `Up to 3 columns`.
  - Toolbar menu: checking two columns nests them in that order, and the button reads `Group by: A › B`. `No grouping`
    clears.
  - Chip:
    - With grouping, `Grouped by A › B` shows.
    - `Clear grouping` clears it, and the chip goes.
    - With no grouping, there is no chip.
  - Order: with rows `x,x,x,y,z,z`, the groups read `x · 3`, `z · 2`, `y · 1`.
    - The same order holds inside a nested level.
  - Group rows:
    - They start closed.
    - Right opens one and Left closes it, on the focused toggle.
    - Up/Down selection skips group rows, so the existing behaviour holds.
  - Right-click a group row with `onFilter` → `Filter by "x"` calls `onFilter(column, x, 'eq')`.
    - An empty group shows `null`, and its item is `Filter by null`.
    - Without `onFilter`, the browser's own menu shows.
  - With groups closed, the toolbar's `All n rows` counts every filtered row. Copy writes those rows ungrouped.
- [ ] **Step 2: Run them and see them fail.** `cd web && npx vitest run src/results/result-grid.test.tsx`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and see them pass,** then run `cd web && npm run format:check && npm run lint && npm run typecheck && npm test`.
- [ ] **Step 5: Commit.** `git commit -am "Nested grouping from the header menu, with a chip and group rows sorted by size"`

### Task 4: Docs

**Files:**
- Modify: `CHANGELOG.md`, `docs/manual-checks.md`

- [ ] **Step 1: Write the docs.**
  - Changelog, Unreleased › Added: **Grouping by several columns**: group the Rows tab by up to three columns, from a
    column header's menu or the Group by menu. A `Grouped by` chip clears it, a group row has Filter by and Exclude, and a
    tab keeps its grouping while Kustodian runs.
  - Changelog, Unreleased › Changed: groups are now sorted by size, largest first, and the Group by menu takes several
    columns.
  - Manual checks: a new `### Grouping (2026-11-10)` section after Column statistics.
    - Group a hunting result by two columns from the header menu.
    - Rerun, then switch tabs and back: the grouping stays.
    - Rerun a query without one grouped column: it drops that column.
    - Keyboard: Tab to a group row, Right, Left.
    - Right-click a group row → Filter by.
    - Light and dark themes.
- [ ] **Step 2: Run the full checks.** `dotnet build -warnaserror && dotnet test`, and `cd web && npm run format:check && npm run lint && npm run typecheck && npm test`.
- [ ] **Step 3: Commit.** `git commit -am "Document grouping"`. Don't push.
