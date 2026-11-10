# Result workflow, plan 2: column statistics

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A column header's menu opens **Column statistics**: a popover with row, distinct and empty counts, the top 10 values (each with Filter by / Exclude), and min/max/average or earliest/latest, worked out from the rows the grid shows.

**Architecture:** A pure function `columnStats` in `web/src/results/column-stats.ts` makes one pass over the shown values. It
runs in chunks above 200,000 rows. The grid gets a small menu button in each header, next to the existing sort button. The
button opens the shared `Menu` with **Column statistics**, which shows a `ColumnStatsPopover` anchored under the header.
Filter by / Exclude reuse `FilterItems` and the grid's existing `onFilter` (plan 1). There is no host change.

**Tech Stack:** React, TypeScript, TanStack Table, Vitest.

**Spec:** `docs/design/specs/2026-11-10-result-workflow-design.md` §5 (and §3: not in workbook widgets).

**Branch:** `feat/column-stats`, in the worktree `.worktrees/column-stats`, off `origin/main` at `6418aa6`.

## Global Constraints

- No warnings, none suppressed: `npm run lint` (oxlint), `npm run typecheck` (tsc), and `npm run format:check` (Prettier;
  CI runs it before lint). The known open warnings are `react(incompatible-library)` in `result-grid.tsx` and the two
  `react(immutability)` warnings already on main in `explain-view.tsx` and `kql-editor.tsx`. Add none.
- It is worked out on the client from the rows the grid shows now, after the grid's row filter and any chart-click filter,
  and nothing reruns. The popover says `Of 1,240 rows shown` (counts are formatted with `toLocaleString('en-US')`, as the
  grid's `count` does).
- Offered only on the query tab's Rows grid (`ResultPanel`). Workbook table widgets, history tables and the Compare view
  don't get the header menu.
- The Filter by / Exclude items on top values show only when the grid has `onFilter` (plan 1's gating: the tab's source,
  with a run that kept its text). Without it the statistics still show.
- Dynamic values are counted by their compact JSON (`JSON.stringify`).
- Copy: the header menu item is `Column statistics`. The popover title is `<column> statistics`. It has the labels `Rows`,
  `Distinct`, `Empty`, `Top values`, `n more`, `Min`, `Max`, `Average`, `Earliest` and `Latest`. While computing it shows
  `Counting…`.

## Rulings in this plan (spec deviations, for the owner to check)

- **No command palette entry.** Spec §5 says "and the command palette, for the focused column". The grid focuses rows, not
  cells or columns, so there is no focused column. Keyboard users reach the header menu button with Tab instead, the same
  reason as plan 1's Ruling 3.
- **Empty** counts `null`, missing and `''`. An empty dynamic (`[]`, `{}`) counts as a value, since the smart filter treats
  it as one (`tostring(x) == "[]"`).

## Review Focus

1. **A column of all nulls or no rows shown:** the popover shows `Rows 0` or all-empty, with no NaN average and no
   `Infinity` min. Pinned in Task 1.
2. **Numbers that come as strings or mixed types** (`long` values above 2^53 arrive as strings from some hosts): min, max
   and average use only finite numbers, and the rest still count as values. Pinned in Task 1.
3. **A new result while the popover is open:** it closes, like row details does, so it never shows numbers from old rows.
   Pinned in Task 2.
4. **200,000+ rows:** the UI stays responsive and the popover can be closed while it is counting; a late result after close
   is dropped. Pinned in Tasks 1 and 2.
5. **Keyboard:** Tab reaches the header menu button. Enter opens the menu, Enter on Column statistics opens the popover,
   and Esc closes it and returns focus to the header button. Pinned in Task 2.

---

### Task 1: Statistics

**Files:**
- Create: `web/src/results/column-stats.ts`
- Test: `web/src/results/column-stats.test.ts`

**Interfaces:**
- Produces:

```ts
export interface TopValue { value: unknown; count: number; share: number } // share 0..1 of rows
export interface ColumnStats {
  rows: number;
  distinct: number;
  empty: number;
  top: TopValue[];          // at most 10, by count desc, then by key asc
  more: number;             // distinct values not in top (empty excluded)
  min?: number; max?: number; average?: number;          // number columns, finite numbers only
  earliest?: string; latest?: string;                     // datetime columns, the cell's own text
}
export const TOP_VALUES = 10;
export const CHUNKED_ABOVE = 200_000;
export function columnStats(column: ResultColumn, values: unknown[]): ColumnStats;
/** Same result, computed CHUNK (50,000) values per macrotask; resolves to null if `signal` aborts first. */
export function columnStatsChunked(column: ResultColumn, values: unknown[], signal: AbortSignal): Promise<ColumnStats | null>;
```

  Number columns are `int`, `long`, `real` and `decimal`. Use the grid's `NUMERIC` set if it is exported; export it from
  `result-grid.tsx` if not. Datetime columns are `datetime`. Top values keep the first original value seen for each key, so
  Filter by gets a real cell value. Empty values are not in `top`, `distinct` or `more`.

- [ ] **Step 1: Write the failing tests** (`describe('columnStats')`):
  - Strings: `['a','b','a',null,'','a']` → `rows 6, distinct 2, empty 2, top [{a,3,0.5},{b,1,1/6}], more 0`.
  - Ties sort by key: `['b','a']` → top `a` then `b`.
  - More than 10 distinct: 12 distinct values gives `top.length 10` and `more 2`.
  - Numbers: `long` `[3, 1, null, 2]` → `min 1, max 3, average 2`. A `long` `'9007199254740993'` string is counted as a
    value but left out of min/max/average.
  - All null: `[null, null]` → `rows 2, distinct 0, empty 2, top [], more 0`, and `min`, `max` and `average` undefined.
  - No rows: `[]` → `rows 0`, everything else 0 or undefined.
  - Datetimes: `['2025-03-04T10:15:00Z','2024-11-27T14:30:12Z']` → `earliest '2024-11-27T14:30:12Z', latest '2025-03-04T10:15:00Z'`.
    Compare with `Date.parse`, and return the cell's own text.
  - Dynamic: `[{a:1},{a:1},[]]` → distinct 2, top `{a:1}` ×2, and `[]` counted as a value, not empty.
  - `columnStatsChunked` gives `toEqual(columnStats(...))` for 120,000 values. When aborted before it resolves, it resolves
    to `null`. Use fake timers or `await` the promise; follow how the repo's other async tests do it.

- [ ] **Step 2: Run them and see them fail.** `cd web && npx vitest run src/results/column-stats.test.ts`. Expected: module
  not found.

- [ ] **Step 3: Implement.** Make one pass that keeps a `Map<key, {value, count}>` plus running min/max/sum/n and the earliest
  and latest times. Take the top values with a sort of the map entries. That is fine at these sizes; no heap is needed.
  `columnStatsChunked` uses the same accumulator, fed 50,000 values per `setTimeout(0)`.

- [ ] **Step 4: Run them and see them pass.** Same command.

- [ ] **Step 5: Commit.** `git add web/src/results/column-stats*.ts && git commit -m "Work out column statistics from a result's values"`

### Task 2: Header menu and popover

**Files:**
- Create: `web/src/results/column-stats-popover.tsx`
- Modify: `web/src/results/result-grid.tsx`: a `statistics?: boolean` prop, a header menu button per column, and the
  popover state.
- Modify: `web/src/results/result-panel.tsx`: pass `statistics` to the Rows grid.
- Test: `web/src/results/column-stats-popover.test.tsx`, `web/src/results/result-grid.test.tsx`

**Interfaces:**
- Consumes: Task 1, plus `Menu`, `FilterItems` and `OnFilter` from `result-grid.tsx`, and the grid's `filteredLeaves` (rows
  after the row filter and `cellFilters`).
- Produces:
  - `ColumnStatsPopover({ column, values, onFilter, onClose }: { column: ResultColumn; values: unknown[]; onFilter?: OnFilter; onClose: () => void })`.
    It is `role="dialog"` with `aria-label={`${column.name} statistics`}`, positioned absolutely under the header it belongs
    to and clamped inside the grid like `Menu` does with `at`. It computes with `columnStats` synchronously when
    `values.length <= CHUNKED_ABOVE`, and otherwise with `columnStatsChunked`, showing `Counting…` and aborting on unmount.
    It shows:
    - `Of <n> rows shown`.
    - The `Rows` / `Distinct` / `Empty` figures.
    - `Top values`: each row has the value (via `shownValue`), the count, the share as a percentage, and a bar whose width
      is the share. When `onFilter` is given, each row also has a small `Filter…` menu button. It opens a `Menu` with
      `FilterItems` for that value, so it is the same items as the cell menu.
    - `<more> more` when `more > 0`.
    - `Min` / `Max` / `Average`, or `Earliest` / `Latest`, when present.

    Esc, or a mousedown outside the popover, calls `onClose`. Esc inside the inner Filter menu closes only that menu.
  - In `ResultGrid`: `statistics?: boolean`. Without it there is no header menu button.

- [ ] **Step 1: Write the failing tests.**
  - Popover, rendered directly:
    - For strings `['a','a','b',null]` it shows `Of 4 rows shown`, `Distinct 2`, `Empty 1`, and `a` with `2` and `50%`.
    - With `onFilter`, clicking `a`'s Filter… then `Filter by "a"` calls `onFilter(column, 'a', 'eq')`.
    - Without `onFilter` there is no Filter… button.
    - Esc calls `onClose`.
    - Above `CHUNKED_ABOVE` values (use a small override, or mock `CHUNKED_ABOVE` through a prop or the module, whichever the
      code allows) it first shows `Counting…`, then the figures.
  - Grid:
    - With `statistics`, each header has a button named `<column> column menu`. It opens a menu with `Column statistics`,
      and choosing that opens the dialog `<column> statistics`.
    - The statistics count only the rows the grid's row filter lets through (type in Filter rows, then open the statistics,
      and `Of n rows shown` matches).
    - Esc closes the dialog and focus returns to the header menu button.
    - New `rows` close the dialog.
    - Without `statistics` there is no header menu button.
    - The sort button still sorts.

- [ ] **Step 2: Run them and see them fail.** `cd web && npx vitest run src/results/column-stats-popover.test.tsx src/results/result-grid.test.tsx`.

- [ ] **Step 3: Implement.**
  - The header keeps its sort `<button>`. Add a second small button after it, a chevron `⌄`, with
    `aria-label="<column> column menu"` and `aria-haspopup="menu"`, visible on header hover and focus and always reachable
    by Tab.
  - It opens `Menu` with one item, `Column statistics`. Plan 3 adds `Group by this column` to the same menu, so keep the
    items in one place.
  - The popover's values are `filteredLeaves.map((r) => r.original[columnIndex])`.
  - Close the popover when `rows` change, where the grid already resets state on new rows (the `rowsSeen` block).
  - `ResultPanel` passes `statistics` on the Rows grid only.

- [ ] **Step 4: Run them and see them pass.** Then run everything: `cd web && npm run format:check && npm run lint && npm run typecheck && npm test`.

- [ ] **Step 5: Commit.** `git commit -am "Column statistics from a column header's menu"` (add the new files first).

### Task 3: Docs

**Files:**
- Modify: `CHANGELOG.md` (Unreleased › Added), `README.md` (the Results bullet), `docs/manual-checks.md` (a new
  `### Column statistics (2026-11-10)` section after Smart filter).

- [ ] **Step 1: Write the docs.**
  - Changelog entry, in the file's style: **Column statistics**: a column header's menu shows the column's distinct and
    empty counts, its top 10 values with their share, and min, max and average for numbers or earliest and latest for dates,
    from the rows shown. Filter by or Exclude a top value from there.
  - Manual checks:
    - Open statistics on a string column, a number column and a datetime column in a dark theme and a light one.
    - Filter rows, then reopen the statistics: the counts follow.
    - Filter by a top value: the query gets the line.
    - Keyboard path: Tab to the chevron, Enter, Enter, Esc.
    - A result of 200,000+ rows (hunting `range x from 1 to 300000 step 1`) shows `Counting…` and stays responsive.
- [ ] **Step 2: Run the full checks.** `dotnet build -warnaserror && dotnet test`, and `cd web && npm run format:check && npm run lint && npm run typecheck && npm test`.
- [ ] **Step 3: Commit.** `git commit -am "Document column statistics"`. Don't push; the controller checks the UI and asks
  before pushing.
