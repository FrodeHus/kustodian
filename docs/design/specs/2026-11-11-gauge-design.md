# Gauge chart: design

Date: 2026-11-11. Status: draft for the owner's review.

**Owner** means the owner decided it. **My call** means I chose it and the owner can overrule it while reading.

## 1. Why

A gauge shows one score against a target at a glance. The owner's examples (**Owner**):

- **Secure score** (0–100), with a desired level. Being **below** it is bad.
- **Exposure score** (Defender Vulnerability Management, 0–100), with a desired level. Being **above** it is bad.

Today the closest thing is the workbook stat widget. It shows a number but doesn't say whether that number is good or bad, and
it isn't in the Chart tab.

## 2. Goals

- A **Gauge** chart type in the Chart tab and in workbook chart widgets, next to the existing types.
- **Picked by hand only**, like the heatmap (**Owner**). It has no `RENDER_HINTS` entry, because KQL has no `render gauge`.
- **A three-quarter ring** (mockup option B, **Owner**). The value is in large type in the middle, and a tick on the ring marks
  the desired level.
- **A desired level typed in the config** of the Chart tab or the widget (**Owner**), not taken from the query.
- **A direction:** higher is better, or lower is better (**Owner**). The ring is **red** on the wrong side of the desired level
  and **green** at it or on the right side (**Owner**; "at it counts as green" is **my call**).
- **One gauge per result row** (**Owner**).

## 3. Non-goals

- The half circle and the straight bar (mockup options A and C, not picked).
- A desired level read from a query column.
- More than two colours: amber bands, several thresholds, or custom colours.
- Units or number formats on the gauge (the stat widget has a unit; the gauge doesn't, for now).
- Choosing the gauge automatically from a result's shape.
- Treemap: parked by the owner on 2026-11-11. Sunburst and sankey: separate work.

Anti-goals:

- Red and green are the only signal. The value and the desired level are also printed as text, so nobody depends on colour alone.
- A query that returns 90 days of `secureScores` rows becomes a wall of 90 gauges. The cap in §5 prevents this.

## 4. How it fits the existing chart

As the heatmap did, the gauge gives existing `ChartSpec` and `Picked` fields new meanings. It needs **new optional fields** on
`Picked` for its config (**My call** on the names):

| Field | Gauge meaning | Label (Chart tab and widget editor) |
|---|---|---|
| `type` | `'gauge'` | Gauge |
| `series[0]` | The number each gauge shows | Value |
| `x` | The column that labels each gauge | Label |
| `target?: number` (new) | The desired level. Not set means none. | Desired level |
| `better?: 'higher' \| 'lower'` (new) | Direction. Not set means `'higher'`. | Higher is better / Lower is better |
| `min?: number`, `max?: number` (new) | The ring's range. Not set means 0 and 100. | Min, Max |

- Add `'gauge'` to `ChartType` and `{ type: 'gauge', name: 'Gauge' }` to `CHART_TYPES`, after Heatmap. The Chart tab select and
  the widget editor buttons both read `CHART_TYPES`.
- **One value**, as a pie and a heatmap have. Split by and stacking are hidden.
- The config fields (Desired level, direction, Min, Max) show only when the type is Gauge. In the Chart tab they sit with the
  other pickers. In the widget editor they sit with the chart fields. Desired level is a number input that can be cleared.
- `withType` also clears `x`, `split` and `series` when switching **to or from** Gauge, as it does for the heatmap. It keeps
  `target`, `better`, `min` and `max`, which only the gauge reads (**My call**: switching away and back doesn't lose them).
- The Chart tab keeps the picks per tab in `resultViews`, as it does today. A workbook widget saves them in `chart`.
- `render ... with (xcolumn=…, ycolumns=…)` applies when Gauge is picked: `xcolumn` picks Label, `ycolumns[0]` picks Value
  (**My call**, consistent with the other types).

### 4.1 Default columns (**My call**)

1. **Value:** the **last** number column, so `extend Score = currentScore * 100 / maxScore` at the end of a query is picked.
2. **Label:** the first `string` column. If there is none, the first `datetime` column (shown with `dateTick`). If there is
   neither, the label is `Row 1`, `Row 2`, and so on.

With no number column, the chart area says: *A gauge needs a number column.*

As with the heatmap (spec 2026-11-10, §4.2), a result `chartShape` can't chart but that has a number column still shows the
type picker, with the plot area saying *Pick Gauge from the chart type list to chart this result.* only when no other chart
type fits. A single-number result, such as `print Score = 72`, is the typical case. When both a heatmap and a gauge could chart
it, the message names both: *Pick Heatmap or Gauge from the chart type list to chart this result.* (**My call**).

### 4.2 Saved widgets are a trust boundary

`parseWidget` casts `chart` to `Picked` without checking it today. Workbooks can be imported from files, so the new fields are
checked there (**My call**): `target`, `min` and `max` are kept only when they are finite numbers, `better` only when it is
`'higher'` or `'lower'`. Anything else is dropped. Older widgets don't have the fields and are unaffected.

## 5. Shaping

A pure, tested function next to `heatmapData` (for example `gaugeData(columns, rows, spec)`) returns, per gauge: label, value
(or none), and whether it is on the good side. It also returns the note text if rows were cut.

- **One gauge per row**, in result order (**Owner**). No summing and no grouping.
- **Cap:** at most **24** gauges (**Owner** approved the playback with this number). Beyond that, the first 24 are kept and a
  note above the chart says *Showing 24 of 90 rows. Add `top 1 by createdDateTime` (or a filter) to show fewer.* The note names
  the label column if it's a datetime, otherwise it says *Add `take`, `top` or a filter to show fewer.* (**My call** on wording.)
- **Null or non-number value:** the gauge shows `–` and an empty grey ring, no colour.
- **Out of range:** the ring is drawn clamped to Min–Max, but the number in the middle is the real value (**My call**).
- **Min and Max** default independently (0 and 100), so setting only one is fine. **Min ≥ Max:** treated as 0–100, and the
  config shows the field as invalid (**My call**).
- **A picked Value or Label column the result no longer has** falls back to the defaults in §4.1, as the other chart types do
  with stale picks (**My call**).
- **Colour:** with `better` = higher, green when `value >= target`, otherwise red. With lower, green when `value <= target`.
  With no target: no tick, and the ring uses the accent colour.
- **Decimals:** the middle number is rounded to at most one decimal (**My call**). The hover shows the exact value.

## 6. Drawing

Recharts' `RadialBarChart` could do the arc, but a ring, a tick and two text lines are a few SVG paths. Drawn by Kustodian
itself with **no new dependency** (**My call**), in the Chart tab's lazy chunk, as the heatmap is. The builder may use Recharts
instead if it turns out simpler.

- **Shape:** a 270° ring with a gap at the bottom, the track in a muted token, the filled part red or green from the theme's
  existing danger and success colours (or new tokens added for light and dark if none exist). Round caps, as in the mockup.
- **Inside the ring:** the value in large type, and under it `desired 80` in small muted text, left out when no target is set.
- **Under the ring:** the label, cut with an ellipsis when long.
- **Layout:** gauges flow in a wrapping grid. Each is about 130–180 px wide, and a single gauge is centred and scales up to fill
  a small widget. A widget too short for its gauges scrolls vertically.
- **Hover and focus:** the existing `TOOLTIP` look, with label, exact value and column name, desired level, and
  "higher is better" or "lower is better".
- **Keyboard and screen readers (My call, matching the heatmap):** each gauge is focusable, arrow keys move between them,
  Enter does what a click does. Each has an `aria-label` such as *Contoso: 72, desired 80, higher is better, below target*.
- **Click:** calls `onPick` with the Label column's value, so the Rows tab filters to that row, as `markFilter` already does
  from `x`. With no label column (`Row 1`…), gauges aren't clickable (**My call**).
- **Animation:** the ring fills in like the other charts animate. It is off when `animate={false}` (printing).
- **Title:** "Gauge" in the Chart tab, unless `render ... with (title=…)` gives one.

## 7. Workbooks

- Chart widgets get the Gauge button through `CHART_TYPES`. With Gauge picked, the editor's X and Y fields read Label and
  Value, Split by is hidden, and Desired level, direction, Min and Max appear.
- **Values history (Owner):** a gauge widget with history shows **only the latest snapshot's rows**, and keeps the user's own
  Label column (for example the tenant) instead of forcing `x` to `Snapshot`. Trends over time are a line chart's job. This is a
  special case in `ChartWidget` (`web/src/workbooks/chart-widget.tsx`), with a test. Without it, `withGaps` returns snapshots
  oldest first, so the cap would show the oldest 24 days and never today's score, and per-tenant rows would all carry the same
  date label. With only the latest snapshot, the rows are the query's own, so the cap and its note apply as usual.
- **Print / PDF:** the gauges are SVG and wrap within the page width, so nothing is cut off. The builder checks this the way the
  heatmap was checked.

## 8. Checks

- Unit tests for `gaugeData`: default columns, labels when there's no text or date column, the 24 cap and note, null values,
  clamping, Min ≥ Max, both directions with values below, at and above the target, and no target.
- Unit tests for `parseWidget`: valid fields kept, bad ones dropped.
- Chart view tests: Gauge is in the type picker, the config fields appear only for Gauge, there is one value, the message for a
  result with no number column, and clicking a gauge calls `onPick`.
- Widget editor test: the gauge fields save into `chart`.
- `bridge.mock.ts`: a secure score per tenant sample and an exposure score sample.
- A section in `docs/manual-checks.md`: both samples, both themes, hover, keyboard, a click, 90 rows (cap note), print to PDF.
- A CHANGELOG `## [Unreleased]` entry.
- `oxlint`, `tsc` and the build pass with no new warnings.

## 9. Left to the builder

- SVG by hand or Recharts, and how the component is split up.
- The exact tokens for red, green and the track, within §6.
- Where exactly the config fields sit in the Chart tab's picker row.
