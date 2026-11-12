# Gauge chart: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a hand-picked Gauge chart type (a 270° ring per result row, red or green against a typed desired level) to the
Chart tab and to workbook chart widgets.

**Architecture:**

- `Picked` gains four optional gauge fields (`target`, `better`, `min`, `max`), validated when a workbook is parsed.
- A new pure module, `gauge-shape.ts`, picks the default columns (spec §4.1) and turns rows into gauges (spec §5).
- A new component, `gauge-view.tsx`, draws the rings as SVG (no new dependency). A small `gauge-fields.tsx` holds the config
  inputs, used by both the Chart tab and the widget editor.
- `ChartView` routes `'gauge'` to the new code. `ChartWidget` feeds a gauge with history only the latest snapshot.

**Tech Stack:** React 19, TypeScript, Vitest, Testing Library. Recharts unchanged.

**Spec:** `docs/design/specs/2026-11-11-gauge-design.md` (approved by the owner, 2026-11-11).

**Branch:** cut `feat/gauge` from `design/gauge` (the spec and this plan) in a new worktree under `.worktrees/`.

## Global Constraints

- No warnings, none suppressed: `npm run format:check`, `npm run lint`, `npm run typecheck` and `npm run build` in `web/`. Known
  open warnings: `react(incompatible-library)` in `result-grid.tsx` and Vite's Monaco chunk-size warning. Add none. Helpers go
  in `.ts` modules, since a non-component export from a `.tsx` trips `react(only-export-components)`.
- No new dependency.
- Gauge is **never** chosen automatically: no `RENDER_HINTS` entry, and `chartShape` never returns it.
- Cap: **24** gauges. Default range: **0–100**. Default direction: **higher**. At the target counts as **green**.
- Colours: the existing tokens `--ok` (green) and `--bad` (red); the track `--line`; with no target, `--accent`.
- Text that appears in the UI (exact):
  - Type name `Gauge`; chart title `Gauge`; picker labels `Label`, `Value`, `Desired level`, `Min`, `Max`.
  - Direction options: `Higher is better`, `Lower is better`. Label picker's no-column option: `Row number`.
  - Can't shape: `A gauge needs a number column.`
  - Only a gauge fits: `Pick Gauge from the chart type list to chart this result.`
  - Heatmap or gauge fits: `Pick Heatmap or Gauge from the chart type list to chart this result.`
  - Cap note, datetime label: ``Showing 24 of {n} rows. Add `top 1 by {label}` (or a filter) to show fewer.``
  - Cap note, otherwise: ``Showing 24 of {n} rows. Add `take`, `top` or a filter to show fewer.`` `{n}` uses
    `toLocaleString('en-US')`.
  - Under the value: `desired {target}`. Missing value: `–`. No label column: `Row 1`, `Row 2`, …
  - `aria-label`: `{label}: {value}, desired {target}, {higher|lower} is better, {below|above|at} target`. No target:
    `{label}: {value}`. No value: `{label}: no value`.

## Review Focus

1. **Typing in a number field.** Clearing Desired level removes the target (`undefined`, not 0). An intermediate entry such as
   `-` or `7.` never saves `NaN`. Tested in Task 3.
2. **Target outside Min–Max.** The tick is clamped to the ring's end; colour still compares the real value with the real target.
   Tested in Task 2.
3. **Fractional scores.** `currentScore * 100 / maxScore` gives `72.4561`. The middle shows `72.5`, the hover the exact value.
   Tested in Task 2.
4. **New result after a pick.** A saved Label or Value pick the result no longer has falls back to the defaults, not a blank
   chart. Tested in Task 4.
5. **Switching type and back.** Column → Gauge → Column → Gauge keeps the typed desired level, direction and range. Tested in
   Task 1.

---

### Task 1: Gauge fields on the chart model

**Files:**
- Modify: `web/src/results/chart-shape.ts` (`ChartType`, `CHART_TYPES`, `Picked`, `withType`)
- Modify: `web/src/workbooks/model.ts` (`parseWidget`, around line 325)
- Test: `web/src/results/chart-shape.test.ts`, `web/src/workbooks/model.test.ts`

**Interfaces:**
- Produces: `ChartType` includes `'gauge'`; `CHART_TYPES` ends `{ type: 'gauge', name: 'Gauge' }`;
  `export type Better = 'higher' | 'lower'`; `Picked` gains `target?: number; better?: Better; min?: number; max?: number`.

- [ ] **Step 1: Write the failing tests.**
  - `chart-shape.test.ts` › `withType`:
    - `withType({ type: 'column', x: 'a', series: ['n'], target: 80, better: 'lower', min: 10, max: 90 }, 'gauge')` equals
      `{ type: 'gauge', stack: undefined, target: 80, better: 'lower', min: 10, max: 90 }`.
    - `withType({ type: 'gauge', x: 'a', series: ['n'], target: 80 }, 'column')` equals `{ type: 'column', stack: undefined, target: 80 }`.
    - Column → heatmap still clears columns, as before.
    - `CHART_TYPES.at(-1)` equals `{ type: 'gauge', name: 'Gauge' }`.
  - `model.test.ts` › `parseWorkbook`: a chart widget with
    `chart: { type: 'gauge', target: 80, better: 'lower', min: 0, max: 100 }` round-trips unchanged; one with
    `target: '80', better: 'up', min: NaN, max: Infinity` keeps `type` and drops all four fields; a widget with no gauge fields
    has none added.
- [ ] **Step 2: Run them to see them fail.** `cd web && npx vitest run src/results/chart-shape.test.ts src/workbooks/model.test.ts`.
  Expected: the new cases fail.
- [ ] **Step 3: Implement.** In `withType`, a switch that clears columns (to or from `'heatmap'` or `'gauge'`) returns
  `{ type, stack, target, better, min, max }` from the old picks, leaving out undefined keys; other switches are unchanged. In
  `parseWidget`, replace the bare cast with a helper `parseChart(v: Record<string, unknown>): Picked` in `model.ts` that keeps
  the existing fields as they are and keeps `target`/`min`/`max` only when `Number.isFinite`, `better` only when `'higher'` or
  `'lower'`.
- [ ] **Step 4: Run the tests.** Same command. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "Add gauge type and config fields to chart picks"`

### Task 2: Shaping gauges

**Files:**
- Create: `web/src/results/gauge-shape.ts`
- Test: `web/src/results/gauge-shape.test.ts`

**Interfaces:**
- Consumes: `ChartSpec`, `Picked`, `Better`, `RenderOptions`, `isNumeric` from `chart-shape.ts`; `cellText`, `Row` from
  `export.ts`; `dateTick` from `chart-style.ts`.
- Produces:
  ```ts
  export const GAUGE_NO_SHAPE: string; export const GAUGE_PICK: string; export const ANY_PICK: string; // copy above
  export const GAUGE_CAP = 24;
  export function gaugeShape(columns: ResultColumn[], options?: RenderOptions): ChartSpec | null; // { type: 'gauge', x, series: [value], split: null }
  export function gaugeLabels(columns: ResultColumn[], value: string | undefined): string[]; // non-dynamic columns except the value
  export function gaugeRange(picked: Picked): { min: number; max: number; valid: boolean };
  export function gaugeText(value: number): string; // at most one decimal, no trailing .0
  export interface Gauge { key: string; label: string; value: number | null; text: string; fill: number; good: boolean | null; aria: string }
  export interface GaugeData { gauges: Gauge[]; total: number; note?: string; labelColumn: string | null; valueColumn: string;
    target?: number; targetFill?: number; better: Better; min: number; max: number }
  export function gaugeData(columns: ResultColumn[], rows: Row[], spec: ChartSpec, picked: Picked): GaugeData;
  ```
  `fill` and `targetFill` are 0–1 along the ring, clamped. `good` is null with no target or no value. `key` is the raw
  `cellText` of the label cell (for filtering); `label` is the display text.

- [ ] **Step 1: Write the failing tests** (`describe('gaugeShape')`, `describe('gaugeData')`, `describe('gaugeRange')`):
  - Value is the last number column: columns `tenant:string, currentScore:real, maxScore:real, Score:real` → `series: ['Score']`, `x: 'tenant'`.
  - Label falls back to the first datetime column, then to `null`: `createdDateTime:datetime, Score:real` → `x: 'createdDateTime'`;
    `Score:long` alone → `x: null`. No number column → `null`.
  - `render ... with (xcolumn=tenant, ycolumns=currentScore)` options pick Label and Value when they name valid columns.
  - Higher is better, target 80: values 72, 80, 85 give `good` false, true, true. Lower is better, target 30: 38, 30, 22 give false, true, true.
  - No target: `good` null, `targetFill` undefined, aria `Contoso: 72`.
  - aria with target: `Contoso: 72, desired 80, higher is better, below target`; at 80 `… at target`.
  - Null, `''` and `'abc'` values: `value` null, `text` `'–'`, `fill` 0, aria `Contoso: no value`.
  - Out of range: value 130 with 0–100 → `fill` 1, `text` `'130'`. Target 120 → `targetFill` 1. Value −5 → `fill` 0.
  - `gaugeText(72.4561)` is `'72.5'`; `gaugeText(80)` is `'80'`; `gaugeText(0.04)` is `'0'`.
  - `gaugeRange({})` → `{ min: 0, max: 100, valid: true }`; `{ min: 50 }` → `{ 50, 100, true }`; `{ min: 100, max: 100 }` →
    `{ 0, 100, false }`.
  - Range 50–100, value 75 → `fill` 0.5.
  - Cap: 90 rows → 24 gauges, the **first** 24 in result order, `total` 90, note with datetime label
    ``Showing 24 of 90 rows. Add `top 1 by createdDateTime` (or a filter) to show fewer.``; with a string label, the
    `take`/`top` wording; 24 rows → no note. 1,200 rows → `1,200` in the note.
  - No label column: labels `Row 1`, `Row 2`; `labelColumn` null. Datetime label displays through `dateTick`, `key` stays raw.
  - Null label cell: `label` `''`, `key` `''`.
- [ ] **Step 2: Run them to see them fail.** `cd web && npx vitest run src/results/gauge-shape.test.ts`. Expected: module not found.
- [ ] **Step 3: Implement** in `gauge-shape.ts`. Number parsing follows `history.ts`'s rule (null, `''` and non-numbers are NaN,
  not 0). `fill = clamp((value - min) / (max - min), 0, 1)` with the range from `gaugeRange`.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "Shape result rows into gauges"`

### Task 3: Drawing the gauges and the config fields

**Files:**
- Create: `web/src/results/gauge-view.tsx`, `web/src/results/gauge-fields.tsx`
- Modify: `web/src/styles.css` (print rule if needed)
- Test: `web/src/results/gauge-view.test.tsx`, `web/src/results/gauge-fields.test.tsx`

**Interfaces:**
- Consumes: `GaugeData`, `Gauge` (Task 2); `CellMatch` from `chart-shape.ts`; `TOOLTIP` look from `chart-style.ts`.
- Produces:
  - `export default function GaugeView(props: { data: GaugeData; onPick?: (filter: CellMatch[]) => void; animate?: boolean })`
  - `export function GaugeFields(props: { picked: Picked; onChange: (picked: Picked) => void; layout: 'inline' | 'field' })`
    (`inline` = the Chart tab's label-and-input row style; `field` = the widget editor's `className="field"` style).

- [ ] **Step 1: Write the failing tests.**
  - `GaugeView`: renders one focusable element per gauge (`role="button"` when clickable, else `role="group"`)
    with the gauge's `aria`; shows `72` and `desired 80` text; no `desired` text without target; the arc of a good gauge uses
    `var(--ok)`, a bad one `var(--bad)`, no target `var(--accent)`; the tick is absent without target.
  - Click and Enter on a gauge call `onPick` with `[{ id: 'tenant', value: 'Contoso' }]`; with `labelColumn` null, gauges are
    not buttons and nothing is called.
  - ArrowRight/ArrowDown move focus to the next gauge, ArrowLeft/ArrowUp to the previous, Home/End to the ends (roving `tabIndex`).
  - The note, when present, is rendered above the gauges.
  - `GaugeFields`: typing `80` in Desired level calls `onChange` with `target: 80`; clearing it calls `onChange` without
    `target`; typing `-` alone does not call `onChange`; picking `Lower is better` sets `better: 'lower'`; Min ≥
    Max marks both inputs `aria-invalid="true"`.
- [ ] **Step 2: Run them to see them fail.** `cd web && npx vitest run src/results/gauge-view.test.tsx src/results/gauge-fields.test.tsx`.
- [ ] **Step 3: Implement.**
  - Ring: SVG viewBox about `0 0 130 120`, centre (65, 64), radius 52, stroke 12, round caps, sweep 270° from 135° (gap at the
    bottom), as in the approved mockup (`B`). Track `var(--line)`; filled arc to `fill`; tick from `r-12` to `r+8` at
    `targetFill` in `currentColor`. Value text 26 px semibold, `desired …` 9 px muted beneath.
  - Layout: CSS grid `repeat(auto-fill, minmax(130px, 1fr))`, each gauge at most 180 px wide; with one gauge, centred and up
    to 260 px. Overflow scrolls vertically.
  - Hover/focus readout in the `TOOLTIP` look: label, `{valueColumn}: {exact value}`, `desired {target} · {higher|lower} is better`.
  - Animation: the filled arc grows from 0 via `stroke-dashoffset` transition (700 ms ease-out); none when `animate` is false
    or `prefers-reduced-motion` is set.
  - `GaugeFields`: number inputs (`type="number"`, cleared → `undefined`, set only when `Number.isFinite`) for Desired level,
    Min, Max, and a select for direction. Validity from `gaugeRange`.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "Draw gauges and their config fields"`

### Task 4: Gauge in the Chart tab

**Files:**
- Modify: `web/src/results/chart-view.tsx`, `web/src/results/heatmap-shape.ts` (remove `HEATMAP_PICK`)
- Test: `web/src/results/chart-view.test.tsx` (and update any `HEATMAP_PICK` assertions)

**Interfaces:**
- Consumes: Tasks 2 and 3.

- [ ] **Step 1: Write the failing tests** (`describe('gauge')` in `chart-view.test.tsx`):
  - `Gauge` is in the Chart type select. Picking it shows pickers `Label`, `Value`, `Desired level`, direction, `Min`, `Max`;
    no `Split by`, no `Stacking`. The title reads `Gauge`.
  - The Label select lists `Row number` plus the non-dynamic, non-value columns; picking `Row number` sets `x: null`.
  - Ticking a second value replaces the first.
  - A result with no number column, picked Gauge, shows `A gauge needs a number column.`
  - The day × hour result (timespan, int, long; `chartShape` null) with nothing picked shows
    `Pick Heatmap or Gauge from the chart type list to chart this result.` and the type select shows `Choose a type`.
  - A result where `chartShape` and `heatmapShape` are null but a number column exists (e.g. columns `a:dynamic, n:long`, two
    rows) shows `Pick Gauge from the chart type list to chart this result.`
  - Stale picks: `picked = { type: 'gauge', x: 'gone', series: ['gone'] }` on a `tenant, Score` result draws gauges labelled by
    `tenant` with `Score`.
  - Clicking a gauge calls `onPick` with the label column and value.
  - Typing `80` in Desired level calls `setPicked` with `target: 80` and other picks kept.
- [ ] **Step 2: Run them to see them fail.** `cd web && npx vitest run src/results/chart-view.test.tsx`.
- [ ] **Step 3: Implement.** In the `useMemo`, compute `gaugeShape(columns, options)` next to `heat`. Return `null` (NO_SHAPE)
  only when all three are null. Before the existing heatmap branch, handle `picked.type === 'gauge'`: no gauge shape → note
  `GAUGE_NO_SHAPE`; otherwise value = picked `series[0]` if numeric and present, else the shape's; label = picked `x` if it is
  `null` or in `gaugeLabels`, else the shape's; `spec = { type: 'gauge', x, series: [value], split: null }`; return
  `xs: gaugeLabels(...)`, `numbers` = numeric columns, and `gauge: gaugeData(columns, rows, spec, picked)`. When `chartShape` is
  null and the type picked is neither heatmap nor gauge, the note is `heat ? ANY_PICK : GAUGE_PICK`; `choose` is true for
  both. Render `<GaugeView data={gauge} onPick={onPick} animate={animate} />` in the plot. Picker row for gauge: X select
  labelled `Label` with a `Row number` option for `null`; hide Split by; `Value` single-select via the existing `toggle`
  (extend its pie/heatmap condition to gauge); then `<GaugeFields layout="inline" … />`. `HEATMAP_PICK` is now unused: delete
  it and point its tests at `ANY_PICK`.
- [ ] **Step 4: Run the tests.** `cd web && npx vitest run src/results`. Expected: PASS (heatmap tests included).
- [ ] **Step 5: Commit.** `git commit -m "Offer the gauge in the Chart tab"`

### Task 5: Gauge in workbook widgets

**Files:**
- Modify: `web/src/workbooks/widget-editor.tsx` (around lines 431–510), `web/src/workbooks/widgets/chart-widget.tsx`,
  `web/src/workbooks/history.ts`
- Test: `web/src/workbooks/widget-editor.test.tsx`, `web/src/workbooks/history.test.ts`,
  `web/src/workbooks/widgets/history-widgets.test.tsx`

**Interfaces:**
- Consumes: `GaugeFields` (Task 3), `gaugeLabels` (Task 2).
- Produces: `export function latestSnapshot(snapshots: HistoryValues['snapshots']): { columns: ResultColumn[]; rows: unknown[][] } | null`
  in `history.ts` (the snapshot with the greatest `takenAt`, its own columns and rows, no `Snapshot` column).

- [ ] **Step 1: Write the failing tests.**
  - `history.test.ts`: `latestSnapshot` picks the newest of three out-of-order snapshots and returns its columns and rows;
    `[]` → `null`.
  - `history-widgets.test.tsx`: a gauge chart widget with Values history and three snapshots (two tenants each) draws two
    gauges with the newest snapshot's values, labelled by tenant (not dates). A column chart widget with history still plots
    against `Snapshot`.
  - `widget-editor.test.tsx`: pressing `Gauge` shows fields `Label`, `Value`, `Desired level`, direction, `Min`, `Max`, and no
    `Split by`; typing 80 and choosing `Lower is better` saves `chart: { type: 'gauge', target: 80, better: 'lower', … }`.
- [ ] **Step 2: Run them to see them fail.** `cd web && npx vitest run src/workbooks`.
- [ ] **Step 3: Implement.** `ChartWidget`: when `widget.chart?.type === 'gauge'` and history is in values mode with
  snapshots, use `latestSnapshot(values.snapshots)` as the table and keep `chart` as picked (no `x: 'Snapshot'`); otherwise
  unchanged. Widget editor: with `picked.type === 'gauge'`, label the X field `Label` and Y field `Value`, hide Split by, and
  render `<GaugeFields layout="field" picked={picked} onChange={(chart) => set({ chart })} />`.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "Offer the gauge in workbook chart widgets"`

### Task 6: Samples, docs and full checks

**Files:**
- Modify: `web/src/bridge.mock.ts` (next to `dayHourResult`, and the query switch around line 1266), `docs/manual-checks.md`,
  `CHANGELOG.md`

- [ ] **Step 1: Add mock results.** `secureScoreResult`: matched by `secureScores`; columns `tenant:string`,
  `createdDateTime:datetime`, `currentScore:real`, `maxScore:real`, `Score:real`; four tenants (Contoso 72, Fabrikam 85,
  Woodgrove 80, Tailspin 41 as `Score`). If the query contains `take 90` or has no `top`/`take`, return 90 daily rows for
  Contoso instead, to exercise the cap. `exposureScoreResult`: matched by `ExposureScore` (exact pattern the builder's call);
  columns `tenant:string, ExposureScore:long`, values 38, 22, 30, 61.
- [ ] **Step 2: Manual checks** in the browser against the Vite dev server with the mock bridge, light and dark: both samples
  with desired 80/higher and 30/lower; hover; keyboard; a click filtering Rows; the 90-row cap note; a workbook gauge widget
  with Values history; print to PDF. Add a `### Gauge (2026-11-11)` section to `docs/manual-checks.md` in the heatmap
  section's table format with the results.
- [ ] **Step 3: CHANGELOG.** Under `## [Unreleased]` › `### Added`, a **Gauge chart** entry: pick Gauge from the type list or a
  widget's buttons; one ring per row; type a desired level and choose higher or lower is better; red on the wrong side, green
  at or past it; first 24 rows; with Values history, a widget shows the latest snapshot.
- [ ] **Step 4: Full checks.** In `web/`: `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm test`,
  `npm run build`. Expected: all pass; lint and build show only the known warnings.
- [ ] **Step 5: Commit.** `git commit -m "Add gauge samples, manual checks and changelog"`
