# Heatmap chart: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a hand-picked Heatmap chart type to the Chart tab and to workbook chart widgets.

**Architecture:**

- A new pure module, `heatmap-shape.ts`, picks the default columns (spec §4.1) and turns rows into a grid of cells (spec §5).
- A new component, `heatmap-view.tsx`, draws that grid with Kustodian's own markup (Recharts has no heatmap).
- `ChartView` and the widget editor gain the type, relabel their pickers, and route `'heatmap'` to the new code. The heatmap
  reuses `ChartSpec` and `Picked` fields: `x` = Columns, `split` = Rows, `series[0]` = Value.

**Tech Stack:** React, TypeScript, Recharts (unchanged), Vitest, Testing Library.

**Spec:** `docs/design/specs/2026-11-10-heatmap-design.md` (approved by the owner, 2026-11-10).

**Branch:** `feat/heatmap`, in the worktree `/Users/frode.hus/src/github.com/frodehus/kustodian-heatmap`, cut from
`docs/heatmap-design` (the spec and this plan).

## Global Constraints

- No warnings, none suppressed: `npm run format:check`, `npm run lint`, `npm run typecheck` and `npm run build` in `web/`.
  The known open warnings are `react(incompatible-library)` in `result-grid.tsx` and Vite's Monaco chunk-size warning. Add
  none. A non-component export from a component module trips `react(only-export-components)`, so helpers go in `.ts` modules.
- No new dependency.
- Heatmap is **never** chosen automatically. It has no `RENDER_HINTS` entry, and `chartShape` never returns it.
- Cells show **colour only**. The exact value is shown on hover or focus.
- Limits: **50** text rows, **50** text columns (the rest go into `Other`), **2,000** columns for a date, number or timespan
  column axis (the latest are kept), and **100** at most for filling whole-number gaps.
- Text that appears in the UI (exact):
  - Can't shape: `A heatmap needs two columns to lay out and a number column.`
  - Only a heatmap fits: `Pick Heatmap from the chart type list to chart this result.`
  - Text cap note: `Showing the 50 busiest of {n} {column} values. The rest are in Other.`
  - Column limit note: `Showing the latest 2,000 of {n} {column} columns. Use a larger bin() to see them all.` `{n}` uses
    `toLocaleString('en-US')`, giving `43,200`.
  - The merged row and column label: `Other`. Picker labels: `Columns`, `Rows`, `Value`. Type name: `Heatmap`.
  - Day labels: `Sun Mon Tue Wed Thu Fri Sat`.

## Review Focus

1. **Value column that is also an axis.** `by Hour = hourofday(...)` gives an int that must be usable as an axis, never as the
   value. The last number column is the value, and it is left out of the axis pickers. Tested in Task 1.
2. **Nulls in an axis column.** Rows whose row or column cell is null are grouped under an empty label (`''`), not dropped
   and not crashing. Tested in Task 2.
3. **Negative and non-finite values.** Negative values shade from `min(0, min)`. `NaN`, null and non-numbers count as empty.
   If every value is equal (min = max), every cell gets the full colour. Tested in Task 2.
4. **New result after a pick.** A saved Rows or Columns pick for a column the new result lacks falls back to the defaults
   instead of showing a blank grid. Tested in Task 4.
5. **One cell, one row, one column.** A 1×1 grid draws one full-colour cell with a legend, and doesn't divide by zero. Tested
   in Task 3.

---

### Task 1: Default heatmap columns

**Files:**
- Create: `web/src/results/heatmap-shape.ts`
- Test: `web/src/results/heatmap-shape.test.ts`

**Interfaces:**
- Consumes: `ChartSpec`, `RenderOptions`, `isNumeric` from `./chart-shape`. `ResultColumn` from `../wire`. `Row` from
  `./export`.
- Produces:
  - `heatmapShape(columns: ResultColumn[], rows: Row[], options?: RenderOptions): ChartSpec | null` returns `{ type:
    'heatmap', x, split, series: [value] }` or null.
  - `heatmapAxes(columns: ResultColumn[], value: string | undefined): string[]` lists every column that isn't `dynamic` and
    isn't `value`.
  - `HEATMAP_NO_SHAPE` and `HEATMAP_PICK` hold the two exact strings.
  - `chart-shape.ts` gains `'heatmap'` in `ChartType` and `{ type: 'heatmap', name: 'Heatmap' }` at the end of `CHART_TYPES`.

- [ ] **Step 1: Write the failing tests** `heatmap_shape_defaults`, `heatmap_shape_render_options` and
  `heatmap_shape_needs_two_axes_and_a_number`:

```ts
const col = (name: string, type: string) => ({ name, type });
// dayofweek × hourofday: rows Day, columns Hour (the second axis column, since there is no date), value the last number.
expect(heatmapShape([col('Day', 'timespan'), col('Hour', 'int'), col('count_', 'long')], [])).toEqual({
  type: 'heatmap', x: 'Hour', split: 'Day', series: ['count_'] });
// A datetime goes across, wherever it sits.
expect(heatmapShape([col('Computer', 'string'), col('TimeGenerated', 'datetime'), col('count_', 'long')], [])).toMatchObject({
  x: 'TimeGenerated', split: 'Computer' });
expect(heatmapShape([col('type', 'string'), col('location', 'string'), col('n', 'long')], [])).toMatchObject({
  x: 'location', split: 'type', series: ['n'] });
// dynamic is never an axis.
expect(heatmapAxes([col('a', 'string'), col('d', 'dynamic'), col('n', 'long')], 'n')).toEqual(['a']);
// render with (xcolumn=..., series=...) picks Columns and Rows when the result has them.
expect(heatmapShape([col('a', 'string'), col('b', 'string'), col('n', 'long')], [], { xcolumn: 'a', series: ['b'] }))
  .toMatchObject({ x: 'a', split: 'b' });
expect(heatmapShape([col('a', 'string'), col('n', 'long')], [])).toBeNull();
expect(heatmapShape([col('a', 'string'), col('b', 'string')], [])).toBeNull();
```

- [ ] **Step 2: Run them to see them fail.** Run `cd web && npx vitest run src/results/heatmap-shape.test.ts`. Expected:
  FAIL, because the module doesn't exist.
- [ ] **Step 3: Implement `heatmapShape`, `heatmapAxes`, the two strings and the `ChartType` and `CHART_TYPES` entries.**
  Follow spec §4.1: value = last numeric column, x = first `datetime` axis column, else the second axis column, split = the
  first axis column that isn't x. An `xcolumn` or `series[0]` that names an axis column overrides x or split. If both name
  the same column, x wins and split falls back.
- [ ] **Step 4: Run them to see them pass.** Use the same command. Expected: PASS. `npm run typecheck` may now report
  `Record<ChartType, …>` gaps in `chart-view.tsx` (`RENDER_WORDS`). That's expected and fixed in Task 4. If you must get
  `tsc` passing first, type `RENDER_WORDS` as `Partial<Record<ChartType, string>>`.
- [ ] **Step 5: Commit** with the message `Pick default heatmap columns`.

### Task 2: Shape rows into heatmap cells

**Files:**
- Modify: `web/src/results/heatmap-shape.ts`
- Test: `web/src/results/heatmap-shape.test.ts`

**Interfaces:**
- Consumes: `cellText` from `./export`, and `heatmapShape` from Task 1.
- Produces:

```ts
export type AxisKind = 'datetime' | 'ordered' | 'text'; // ordered = number or timespan
export interface HeatmapAxis {
  column: string;
  kind: AxisKind;
  /** The cell text each row/column was built from (cellText of the value), or null for Other and for filled-in gaps. */
  keys: (string | null)[];
  /** What to show: day names for dayofweek, `Other`, otherwise the key (the view formats datetimes). */
  labels: string[];
}
export interface HeatmapCell { value: number; rows: number }
export interface HeatmapData {
  rows: HeatmapAxis;
  columns: HeatmapAxis;
  /** [row][column]; null is empty. */
  cells: (HeatmapCell | null)[][];
  min: number;
  max: number;
  /** The cap and limit notes, in the exact wording, in the order rows then columns. */
  notes: string[];
}
export function heatmapData(columns: ResultColumn[], rows: Row[], spec: ChartSpec): HeatmapData;
/** 0..1 colour strength for a value: sqrt((v - lo) / (max - lo)) with lo = min(0, min); 1 when max === lo. */
export function heatStrength(value: number, min: number, max: number): number;
export const HEATMAP_ROW_CAP = 50, HEATMAP_TEXT_COLUMN_CAP = 50, HEATMAP_COLUMN_LIMIT = 2000, HEATMAP_INT_GAP_LIMIT = 100;
```

- [ ] **Step 1: Write the failing tests**, one `it` per rule, with these names and assertions:
  - `heatmap_data_sums_duplicates_and_counts_rows`: two rows `['a', 'x', 2]` and `['a', 'x', 3]` give the cell `{ value: 5,
    rows: 2 }`.
  - `heatmap_data_empty_vs_zero`: a missing pair and a null value give `null`. A `0` gives `{ value: 0, rows: 1 }`.
  - `heatmap_data_orders_axes`: datetime and int columns go ascending whatever the row order. A timespan (`'2.00:00:00'`
    after `'00:00:00'`) goes ascending. Text columns keep first-seen order. Text rows go by total, descending.
  - `heatmap_data_day_names`: a timespan axis with values `'00:00:00'`…`'6.00:00:00'` gets labels `['Sun', …, 'Sat']`, and
    its keys stay the raw text.
  - `heatmap_data_fills_time_gaps`: hourly datetimes at 00, 01 and 04 give 5 columns. The keys for 02 and 03 are null and
    their cells are null. Irregular gaps (00, 01, 03:30) aren't filled.
  - `heatmap_data_fills_whole_number_gaps`: hours `[0, 1, 5]` give 6 columns. `[0, 200]` (199 missing) isn't filled.
  - `heatmap_data_caps_text_rows`: 60 text rows give 51 rows. The last has label `Other` and key null, and holds the sum of
    the 10 smallest. `notes[0]` is `Showing the 50 busiest of 60 Computer values. The rest are in Other.` 60 int rows aren't
    capped and give no note.
  - `heatmap_data_caps_text_columns`: 60 text columns give 51, with `Other` last.
  - `heatmap_data_limits_ordered_columns`: 2,500 consecutive hourly datetimes give 2,000 columns, the last 2,000. The note is
    `Showing the latest 2,000 of 2,500 TimeGenerated columns. Use a larger bin() to see them all.` Gap filling counts toward
    the limit: two datetimes 3,000 hours apart give 2,000 columns, ending at the later one.
  - `heatmap_data_null_axis_values` (Review Focus 2): a null row or column value groups under the label `''`.
  - `heat_strength_scale` (Review Focus 3): `heatStrength(100, 0, 100) === 1`, `heatStrength(25, 0, 100) === 0.5`,
    `heatStrength(-10, -10, 10) === 0`, `heatStrength(5, 5, 5) === 1`. Non-finite values in rows count as empty cells.

- [ ] **Step 2: Run them to see them fail.** Run `cd web && npx vitest run src/results/heatmap-shape.test.ts`. Expected: the
  new tests FAIL.
- [ ] **Step 3: Implement `heatmapData` and `heatStrength`.** Group by `cellText` of the row and column cells. Parse
  timespans as `[-][d.]hh:mm:ss[.fffffff]` to milliseconds for ordering, and check whether a sample result from Log Analytics
  comes back in that form; adjust the parser if not. Gap filling runs before the column limit. When the filled count would
  pass 2,000, keep the latest 2,000 instead of building the rest. Apply the caps after ordering. The `Other` cells hold sums
  and row counts too.
- [ ] **Step 4: Run them to see them pass.** Use the same command. Expected: PASS.
- [ ] **Step 5: Commit** with the message `Shape results into heatmap cells`.

### Task 3: Heatmap view

**Files:**
- Create: `web/src/results/chart-style.ts`. Move `TOOLTIP` and `dateTick` here from `chart-view.tsx`, unchanged. Both files
  import them from here, so no component module exports helpers.
- Create: `web/src/results/heatmap-view.tsx`
- Modify: `web/src/results/chart-view.tsx` to import the moved helpers.
- Test: `web/src/results/heatmap-view.test.tsx`

**Interfaces:**
- Consumes: `HeatmapData`, `heatStrength` (Task 2), `CellMatch` from `./chart-shape`, `TOOLTIP` and `dateTick` from
  `./chart-style`.
- Produces: `export default function HeatmapView({ data, value, onPick, fit }: { data: HeatmapData; value: string; onPick?:
  (filter: CellMatch[]) => void; fit?: boolean })`. `fit` drops the 6 px minimum and the sideways scroll so the grid fits its
  width (for printing).

- [ ] **Step 1: Write the failing tests**, using the existing `chart-view.test.tsx` setup as the pattern:
  - `heatmap_view_cells_have_colour_and_hover_text`: every non-empty cell has a background built from `var(--accent)`.
    Hovering a cell shows its row label, column label and `{cell value} {value prop}` (such as `412 count_`), plus `from 2 rows` when `rows > 1`. Empty
    cells have the hatch class and no colour.
  - `heatmap_view_keyboard`: the grid has `tabIndex=0` and an `aria-label` naming the rows, columns and value. ArrowRight
    and ArrowDown move the active cell. The hover box shows the active cell. Enter calls `onPick` with `[{ id:
    columns.column, value: key }, { id: rows.column, value: key }]`.
  - `heatmap_view_click_picks_and_other_does_not`: a click calls `onPick` with the same filter. A click on a cell whose row
    or column key is null (`Other`, filled gap), or on an empty cell, does not.
  - `heatmap_view_legend_and_notes`: the legend shows `min`, `max` and the value name. Every string in `data.notes` is shown
    above the grid.
  - `heatmap_view_single_cell` (Review Focus 5): a 1×1 grid renders one cell at full strength and a legend, with no NaN in
    any style.
  - `heatmap_view_datetime_labels`: a `datetime` axis shows labels through `dateTick`.
- [ ] **Step 2: Run them to see them fail.** Run `cd web && npx vitest run src/results/heatmap-view.test.tsx`. Expected:
  FAIL.
- [ ] **Step 3: Implement `HeatmapView`.**
  - Colour: `color-mix(in srgb, var(--accent) {8 + 92 * strength}%, transparent)`.
  - Empty cells: a faint diagonal hatch from `var(--line)` (a CSS class in `styles.css`).
  - Rows are 22 px. Columns fill the width but are never narrower than 6 px; past that the grid scrolls sideways, with the
    row labels sticky on the left. Unless `fit` is set, the height scrolls in a short widget.
  - Labels are thinned to fit (the builder's choice of how). Long text labels are cut off with an ellipsis and shown in full
    on hover.
  - The hover box uses `TOOLTIP.contentStyle`. A visible focus ring marks the active cell.
- [ ] **Step 4: Run them to see them pass.** Use the same command, plus `npx vitest run src/results/chart-view.test.tsx`
  (after the helper move). Expected: PASS.
- [ ] **Step 5: Commit** with the message `Draw the heatmap`.

### Task 4: Heatmap in the Chart tab

**Files:**
- Modify: `web/src/results/chart-view.tsx`
- Test: `web/src/results/chart-view.test.tsx`

**Interfaces:**
- Consumes: `heatmapShape`, `heatmapAxes`, `heatmapData`, `HEATMAP_NO_SHAPE`, `HEATMAP_PICK` (Tasks 1–2), and `HeatmapView`
  (Task 3).
- Produces: `withType(picked: Picked, type: ChartType | undefined): Picked`, exported from `chart-shape.ts` (it isn't a
  component, so no export lint). It returns `{ ...picked, type }` when neither the old nor the new type is `'heatmap'`.
  Otherwise it returns `{ type, stack: picked.stack }`: `x`, `split` and `series` are cleared (spec §4.3). Task 5 uses it too.

- [ ] **Step 1: Write the failing tests:**
  - `chart_view_offers_heatmap`: the type select has a `Heatmap` option. A result that fits a column chart still opens as a
    column chart, never as a heatmap.
  - `chart_view_heatmap_pickers`: with Heatmap picked, the pickers read `Columns` and `Rows`. Rows has no `None` option and
    lists the `int` and `timespan` columns. There is no Stacking. Ticking a second value replaces the first.
  - `chart_view_pick_heatmap_when_nothing_else_fits`: for `[Day timespan, Hour int, count_ long]`, the card and type select
    are shown, and the plot reads `Pick Heatmap from the chart type list to chart this result.` Picking Heatmap draws the
    grid. A result with no shape for either still shows `NO_SHAPE`. A heatmap pick on a result it can't shape shows `A
    heatmap needs two columns to lay out and a number column.`
  - `chart_view_switching_heatmap_resets_picks`: `withType({ type: 'column', x: 'a', split: 'b', series: ['n'], stack:
    'stacked' }, 'heatmap')` equals `{ type: 'heatmap', stack: 'stacked' }`. `withType({ type: 'column', x: 'a' }, 'bar')`
    keeps `x`.
  - `chart_view_heatmap_stale_picks_fall_back` (Review Focus 4): with `picked = { type: 'heatmap', x: 'gone', split: 'gone'
    }`, the §4.1 defaults are drawn.
  - `chart_view_heatmap_cell_pick`: clicking a cell calls `onPick` with the Columns and Rows values.
  - `chart_view_heatmap_title`: the title reads `Heatmap`, or the `render ... with (title=...)` title when there is one.
  - `chart_view_heatmap_widget`: `controls={false}` draws the grid alone.
- [ ] **Step 2: Run them to see them fail.** Run `cd web && npx vitest run src/results/chart-view.test.tsx`. Expected: the
  new tests FAIL.
- [ ] **Step 3: Implement it in `ChartView`.**
  - In the `view` memo, `type === 'heatmap'` takes its own branch. The defaults come from `heatmapShape`. A picked `x`,
    `split` or `series[0]` counts only when it names a column the result has, in the right role: axis columns come from
    `heatmapAxes` minus the other axis, and the value must be numeric and not an axis. Otherwise the default is used.
  - Return a view that carries the `HeatmapData`, instead of `series` and `data`.
  - Work out the early `NO_SHAPE` return as: `chartShape` is null, and so is `heatmapShape` (or the pick isn't a heatmap and
    the heatmap shape is also null). When only the heatmap shape exists and the pick isn't Heatmap, render the card with
    `HEATMAP_PICK` in the plot. The type select calls `setPicked(withType(picked, …))`.
  - The X axis select reads `Columns` and hides `Column names`. Split by reads `Rows`, loses `None`, and lists
    `heatmapAxes(...)` minus Columns. Values behave as for a pie.
  - Pass `fit={!animate}` to `HeatmapView`: workbook printing already passes `animate={false}`.
- [ ] **Step 4: Run them to see them pass.** Use the same command, then `npm run typecheck && npm run lint`. Expected: PASS,
  no warnings.
- [ ] **Step 5: Commit** with the message `Offer the heatmap in the Chart tab`.

### Task 5: Heatmap in workbook widgets

**Files:**
- Modify: `web/src/workbooks/widget-editor.tsx` (the chart Visualization panel, around lines 424–500)
- Test: `web/src/workbooks/widget-editor.test.tsx` (or the existing editor test file) and
  `web/src/workbooks/history-widgets.test.tsx`

**Interfaces:**
- Consumes: `withType`, `heatmapAxes` (Tasks 1 and 4), and `CHART_TYPES` (now with Heatmap).

- [ ] **Step 1: Write the failing tests:**
  - `widget_editor_heatmap_fields`: after clicking the `Heatmap` button, the fields read `Columns`, `Value` and `Rows`.
    Rows has `Automatic` but no `None`, and lists non-`dynamic` columns other than Columns. Switching from Column (with X
    and Split set) to Heatmap clears `chart.x`, `chart.split` and `chart.series`.
  - `history_widget_heatmap_values` (spec §7): a Heatmap chart widget with Values history draws the grid with `Snapshot`
    columns across.
- [ ] **Step 2: Run them to see them fail.** Run `cd web && npx vitest run src/workbooks`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement it.** The type buttons call `set({ chart: withType(picked, c.type) })`. When
  `picked.type === 'heatmap'`, relabel the three fields, drop the `None` option, and build the Rows list from
  `heatmapAxes(result.columns, picked.series?.[0])` minus `picked.x`. Stacking is already hidden, since `stackable` is false.
- [ ] **Step 4: Run them to see them pass.** Run `npx vitest run src/workbooks && npm run typecheck && npm run lint`.
  Expected: PASS.
- [ ] **Step 5: Commit** with the message `Offer the heatmap in workbook chart widgets`.

### Task 6: Check it in the app, printing and manual checks

**Files:**
- Modify: `docs/manual-checks.md`

- [ ] **Step 1: Run the full web checks.** Run `cd web && npm run format:check && npm run lint && npm run typecheck && npm
  test && npm run build`. Expected: all pass. The only build warning is the known Monaco chunk-size warning.
- [ ] **Step 2: Check it in the running app** (the `run` skill). In both themes:
  - Run `SigninLogs | summarize count() by Day = dayofweek(TimeGenerated), Hour = hourofday(TimeGenerated)` and pick
    Heatmap. Check: Sun–Sat rows, 0–23 columns, hover, arrow keys plus Enter filtering the Rows tab, and the legend.
  - Run a `by Computer, bin(TimeGenerated, 1h)` query over a week with over 50 computers. Check the `Other` row, its note,
    and sideways scrolling.
  - Add the query to a workbook as a Heatmap chart widget, then print or save it as PDF. Check that the grid fits the page
    width and isn't cut off.
- [ ] **Step 3: Add a manual check** to `docs/manual-checks.md` covering the checks in Step 2, in that file's existing
  style, recording what was checked and on which OS.
- [ ] **Step 4: Commit** with the message `Manual checks for the heatmap`.
