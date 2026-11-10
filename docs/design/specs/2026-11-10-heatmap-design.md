# Heatmap chart: design

Date: 2026-11-10. Status: draft for the owner's review.

**Owner** means the owner decided it. **My call** means I chose it and the owner can overrule it while reading.

## 1. Why

A heatmap shows a number across two lists at once, such as day × hour or resource type × region. The owner hasn't needed one
themselves. It's there to add value for the two groups who use Kustodian (**Owner**):

- **SOC analysts** spotting what's out of pattern: sign-ins by day × hour, alerts by device × severity. The question is "which
  cell is hot that shouldn't be?"
- **Azure/Entra admins** seeing spread: resource type × region, policy × subscription, sign-in result × app. The question is
  "where is it concentrated, and where are the gaps?" An empty cell matters as much as a hot one.

Today `summarize count() by A, B` becomes a column chart with a series for each value of B. That stops being readable at
about 10 series. A heatmap stays readable with dozens.

## 2. Goals

- A **Heatmap** chart type in the Chart tab and in workbook chart widgets, next to the existing types.
- **Picked by hand only**: Kustodian never chooses it on its own (**Owner**). It has no `RENDER_HINTS` entry, because KQL has
  no `render heatmap`.
- **Colour-only cells**, with the exact value on hover (**Owner**, mockup option A).
- **Busiest 50 rows**, with the rest merged into one "Other" row and a note saying so. A time axis stays complete and scrolls
  sideways (**Owner**).

## 3. Non-goals

- Numbers printed in cells, and total bars along the edges (mockup options B and C, not picked).
- Choosing the heatmap automatically from a result's shape (**Owner**).
- Diverging colour scales (for example red below zero, blue above), custom colours, or a choice of scale.
- Controls for sorting rows or columns.
- Treemap, sunburst, sankey and gauge charts. They were explored on the same day and are separate work.

Anti-goals (owner agreed to these):

- One spike turns every other cell the same pale colour.
- A result with hundreds of rows becomes a wall of tiny cells.
- A heatmap appears where a column chart would have been clearer. Picking by hand prevents this.

## 4. How it fits the existing chart

The heatmap uses the existing `ChartSpec` and `Picked` fields with new meanings (**My call**). There are no new fields, so a
saved widget keeps its shape:

| Field | Heatmap meaning | Chart tab label | Widget editor label |
|---|---|---|---|
| `type` | `'heatmap'` | Chart type: Heatmap | Heatmap button |
| `x` | The column laid out **across** (the columns) | Columns | Columns |
| `split` | The column laid out **down** (the rows) | Rows | Rows |
| `series[0]` | The number that sets each cell's colour | Value | Value |

- Add `'heatmap'` to `ChartType` and `{ type: 'heatmap', name: 'Heatmap' }` to `CHART_TYPES`, at the end. Both the Chart tab
  select and the widget editor buttons read `CHART_TYPES`, so it appears in both.
- **One value**, as a pie has. Ticking another value replaces it (the existing pie behaviour in `toggle`).
- The Rows picker has **no "None"**: a heatmap always has rows. Stacking is hidden, as it is for lines and pies.
- Unlike the other charts, the Columns and Rows pickers list **every column except `dynamic` ones**, numbers and dates
  included, because `hourofday()` returns an int and `dayofweek()` returns a timespan (**My call**). The value can't also be
  an axis: picking a column for one removes it from the others.
- A `| render ... with (xcolumn=…, series=…)` still applies when the heatmap is picked: `xcolumn` picks Columns, and the first
  `series` column picks Rows (**My call**). Cheap, and consistent with the other types.

### 4.1 Default columns when the heatmap is picked (**My call**)

`summarize` puts its `by` columns first and its aggregates after, so:

1. **Value**: the **last** number column.
2. **Columns** (across): the first `datetime` column among the rest, otherwise the **second** remaining column. Time always
   goes across, as it does in the time chart.
3. **Rows** (down): the first remaining column that isn't Columns.

Examples:

- `by Day = dayofweek(TimeGenerated), Hour = hourofday(TimeGenerated)` → rows Day, columns Hour, value `count_`.
- `by Computer, bin(TimeGenerated, 1h)` → rows Computer, columns TimeGenerated.
- `by type, location` → rows type, columns location.

When the result has fewer than two axis columns or no number column, the chart area says: *A heatmap needs two columns to
lay out and a number column.* Note that `dynamic` columns can't be axes until they are `mv-expand`ed.

### 4.2 Reaching the heatmap when nothing else fits (**My call**)

The headline example, `by Day = dayofweek(...), Hour = hourofday(...)`, gives a timespan, an int and a long. `chartShape`
returns null for that, and today `ChartView` then shows `NO_SHAPE` with no type picker. The fix: work out the heatmap's own
shape (§4.1) separately from `chartShape`. When `chartShape` is null but a heatmap shape exists, the Chart tab still shows its
card and type picker, with the plot area saying *Pick Heatmap from the chart type list to chart this result.* A widget saved as
`'heatmap'` always uses the heatmap shape, never `chartShape`. Nothing switches to the heatmap on its own (**Owner**).

### 4.3 Switching type (**My call**)

Switching **to or from** Heatmap clears `x`, `split` and `series` from the picks, so §4.1's defaults apply and a column chart
gets its own defaults back. The two sets of fields mean different things, so carrying them over would give odd charts.
Switching between the other types keeps today's behaviour.

## 5. Shaping the cells

This part needs a pure, tested function next to `chartData` in `chart-shape.ts` (for example `heatmapData(columns, rows,
spec)`). It returns the row labels, column labels, a value for each cell (or empty), the min and max, and what was merged.

- **One cell per (row, column) pair.** When several result rows share a pair, their values are **summed**, and the hover
  says how many rows went in (**My call**). That's right for counts and sums, the common case. Averages would be wrong, but
  that only happens when the result has an extra column the heatmap isn't using.
- **Empty vs. zero:** a pair with no rows, or a null value, is **empty** (hatched). A 0 is a value and gets the lowest colour.
- **Column order:** dates and numbers go ascending. Timespans go ascending, so `dayofweek` runs Sunday to Saturday. Text
  keeps the order it first appears in.
- **Row order:** dates, numbers and timespans go ascending. Text is ordered **by row total, busiest first** (**My call**:
  that's what an analyst scans for, and it's what the cap keeps).
- **Time gaps:** when Columns is a `datetime` column with a regular step (every gap a whole multiple of the smallest gap),
  missing steps are filled in as empty columns (**My call**). A quiet hour then shows as a gap instead of disappearing.
  `make-series` results already have no gaps, and `summarize ... by bin()` results do.
- **Whole-number gaps (My call):** when Columns is an int or long column and the missing values fill no more than 100
  steps of 1, they're filled in as empty columns too. Then `hourofday` always shows 0–23, even with a quiet hour.
- **Day names (My call):** a timespan axis whose values are all whole days from 0 to 6 (what `dayofweek()` returns) is
  labelled Sun to Sat instead of `3.00:00:00`.
- **Row cap (Owner, for text rows):** with more than 50 **text** rows, keep the 50 with the biggest totals, in the order above, and merge the rest
  into an **"Other"** row at the bottom. A note above the chart says *Showing the 50 busiest of 500 Computer values. The rest
  are in Other.* Rows that are dates, numbers or timespans aren't capped and scroll down instead (**My call**): merging them
  into "Other" would leave holes in an ordered axis.
- **Column limit for ordered axes (Owner):** a `datetime`, number or timespan column axis isn't merged into "Other". It scrolls
  sideways, up to **2,000 columns** after gaps are filled. Beyond that, only the **latest 2,000** are kept (the highest values
  for numbers and timespans). A note above the chart says *Showing the latest 2,000 of 43,200 TimeGenerated columns. Use a
  larger bin() to see them all.* Gap filling stops at the same limit, so the shaping never builds more than 2,000 columns. A **text** column axis over 50 values is capped the same way as rows, with an "Other" column at the end, because
  there's no natural order to scroll through.

## 6. Drawing

Recharts has no heatmap, so the heatmap is drawn by Kustodian itself in the Chart tab's lazily loaded chunk, with **no new
dependency** (**My call**). Whether that's SVG or an HTML grid is the builder's choice.

- **Colour:** one hue from pale to dark, built from the theme's existing chart or accent colour tokens so it works in light
  and dark themes. Use a **square-root scale** from `min(0, min)` to max (**My call**), so one spike doesn't wash out the rest
  (the mockup's behaviour).
- **Empty cells:** a faint diagonal hatch, so they look different from the lowest colour.
- **Legend:** under the grid there's a ramp with the min and max values and the value column's name, in the existing
  legend's text style.
- **Labels:** row labels on the left, column labels along the top. Labels are thinned out to fit (for example every 3rd
  hour), and dates use the chart's existing `dateTick` format. Long text labels are cut off with an ellipsis, and the hover
  shows them in full.
- **Size:** cells fill the width. When a non-capped column axis would make cells narrower than about 6 px, the grid keeps
  6 px per column and scrolls sideways, with row labels staying visible on the left. Rows are about 22 px each (as
  `BAR_ROW_PX`), and a short widget scrolls them vertically, as bar widgets already do.
- **Hover:** the existing `TOOLTIP` look, showing the row value, the column value, the number with its column name, and
  "from N rows" when values were summed.
- **Keyboard (My call):** this matches the other charts, which get keyboard access from Recharts 3. The grid can take focus,
  arrow keys move between cells with a visible focus ring, the hover box follows the focused cell, and Enter does what a
  click does. The grid has an `aria-label` naming its rows, columns and value.
- **Click:** clicking a cell calls `onPick` with that cell's Columns and Rows values, so the Rows tab filters to the rows
  behind it. That's the same as clicking a bar in a split column chart, and `markFilter` already builds that filter from `x`
  and `split`. Cells in "Other" aren't clickable (**My call**: there's no single value to filter by).
- **Title:** "Heatmap" in the Chart tab title, unless `render ... with (title=…)` gives one.

## 7. Workbooks

- Chart widgets get the Heatmap button for free, through `CHART_TYPES`. When the type is Heatmap, the editor's X, Y and
  Split by fields read Columns, Value and Rows, and Split by loses its None option.
- **Values history (My call):** a widget with Values history already forces `x` to `Snapshot`. With Heatmap, that means
  snapshots run across and Rows is picked as usual, which is a useful "value per item over time" view. Supported, no
  special case beyond a test.
- A widget's `chart.type` is saved as `'heatmap'`. Nothing else validates chart types (checked: only `chart-shape.ts` and
  `chart-view.tsx` name them), so older saved widgets are unaffected.
- **Print / PDF:** a heatmap that scrolls sideways on screen must print without being cut off (see the print-to-PDF work in
  PR 134). The builder checks how the other charts print and does the same, scaling to the page width if needed.

## 8. Checks

- Unit tests for the shaping function (§5): default columns, summed duplicates, empty vs. zero, order of each column kind,
  filling time and whole-number gaps, day names, the 50-row and 50-column text caps with "Other" totals, the 2,000-column
  limit keeping the latest, and the shape found when `chartShape` is null.
- Chart view tests: Heatmap is in the type picker, the pickers relabel, there's no None for Rows, there's one value, the
  message for a result that can't be shaped, and clicking a cell calls `onPick` with both values.
- One line in `docs/manual-checks.md`: open the sign-ins by day × hour query, pick Heatmap, and check both themes, hover,
  keyboard, a cell click and a 500-row result.
- `oxlint`, `tsc` and the build pass with no new warnings.

## 9. Left to the builder

- SVG or HTML grid, and how the component is split up.
- The exact colour tokens and hatch pattern, within §6.
- How label thinning picks which labels to show.
