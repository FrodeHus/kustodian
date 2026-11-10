# Result workflow: narrow down, highlight, keep: design

Date: 2026-11-10. Status: approved by the owner (2026-11-10).

**Owner** means the owner decided it. **My call** means I chose it and the owner can overrule it while reading.

## 1. Why

Comparing Kustodian with Kusto Explorer turned up features that help in two moments (**Owner**):

- **Narrowing a query down** to get exactly the results you want, from what you see in a result.
- **Spotting the rows that need your attention** without reading every cell.

Once the query looks right, you want to **keep it on a workbook** (**Owner**).

## 2. Goals

Five features. Each one ships as its own PR in this order (**My call**: narrowing first, then attention, then keep):

1. **Smart filter**: Filter by / Exclude on a value **edits the query** so it can be reused, then reruns it (**Owner**).
2. **Column statistics** from a column header, with Filter by / Exclude on each value.
3. **Group by column** in the Rows grid, a view only.
4. **Highlight rules**: colour rows or cells by rule. The rules **belong to the query** (**Owner**). You create them **both**
   from a cell and in a rule list (**Owner**, mockup option C).
5. **Add to workbook…**: put the query on an existing or new workbook (**Owner**).

## 3. Non-goals

- Changing **Format the query**: it exists (Shift+Alt+F, whole tab) and stays as it is (**Owner**).
- Query best-practice hints, and new chart kinds (timepivot, heatmap, anomaly and so on). The owner dropped both for now.
- Smart filter, statistics and grouping in **workbook widgets** (**My call**: a widget's query isn't in an editor you see.
  Highlight rules *do* apply to Table widgets, §7.5).
- Saving grouping with the query (**My call**: grouping is a way of looking, not part of the answer).
- Colour scales, gradients, custom colours, and rules written as expressions.

Anti-goals: a filter that quietly changes what the query means beyond the condition you clicked; a highlight that can't be
read in a light theme.

## 4. Smart filter

### 4.1 Where it is offered

- The **Rows** grid: a cell's right-click menu (and Shift+F10 or the context-menu key on the focused cell) gets **Filter by
  `<value>`** and **Exclude `<value>`**, under the existing items.
- **Row details**: the same two items on each top-level property.
- **Column statistics** (§5) on each top value, and **group headers** (§6).

Not offered for raw Graph request tabs, workbook tabs or the Compare view (**My call**).

### 4.2 What it writes

A new line `| where <condition>` goes into **the text that produced the shown result**: the range the run recorded
(`TabRun.origin` and `TabRun.kql` in `web/src/tabs/tab-store.ts`), whichever run mode sent it (**My call**):

- **Block run**: that block.
- **Selection run**: the selected range, with the line added after its last line. If the selection ends mid-line, the line
  goes at the end of the block that holds the selection's end.
- **Run all**: the last block of the text, the one whose result is shown.

It is added with a Monaco edit, so Ctrl/Cmd+Z removes it. Then **exactly that edited range** reruns, with the same source and
options, wherever the cursor is now (**My call**). It is not "press Run again", which would send the block at the cursor. The
query changes so you can reuse it (**Owner**). The tab becomes dirty like any edit.

**Where the line goes** (**My call**): at the end of the block, but before a trailing run of `take`, `limit` and `render`
operators. Those don't change the columns, so the condition still makes sense there, and placing it before `take` gives
"the first N rows that match", which is what narrowing down means. It goes after anything else, including `top`, `summarize`
and `project`, because the clicked column may only exist after them. If the editor text changed since the run so that the
block can't be found, the line goes at the end of the block at the cursor. If there isn't one, nothing is written and a
notice says why.

**Indentation** follows the block's last pipe line (**My call**).

### 4.3 The condition

The column is written as an identifier, bracket-quoted when needed (`['user name']`). Values by result column type
(**My call**):

| Type | Filter by | Exclude |
|---|---|---|
| string | `Col == "v"` (escaped KQL string literal) | `Col != "v"` |
| int, long, real, decimal | `Col == 42` (invariant culture) | `Col != 42` |
| bool | `Col == true` | `Col != true` |
| datetime | `Col == datetime(2026-11-10T08:00:00.0000000Z)` | `Col != datetime(…)` |
| timespan, guid | `Col == timespan(…)` / `Col == guid(…)` | `!=` |
| dynamic | `tostring(Col) == "<compact JSON>"` | `!=` |
| empty / null | `isempty(Col)` for strings, `isnull(Col)` otherwise | `isnotempty` / `isnotnull` |

A datetime cell also offers **On or after** and **Before** (`>=` and `<`), because exact equality on a timestamp is rarely
what you want (**My call**). A string longer than 1,000 characters isn't offered (**My call**).

### 4.4 Graph

The planner only sends the **leading** `where`s, the ones right after the table, to Graph (`PushdownReasons.NotLeading` in
`GraphQueryPlanner.cs`), and a local step before `take` turns off its `$top` read limit. So for a Graph tab the placement in
§4.2 would turn `Users | project id, displayName | take 50` into a read of every user. For Graph tabs (**My call**):

- If the clicked column is one of the table's own columns and passes unchanged to the result (no `project`, `extend` or
  `summarize` renames or recomputes it before that point), the line goes **right after the table's leading `where`s**, where
  the planner can push it down.
- Otherwise it goes where §4.2 says, and runs locally as typed `where`s do today.

Planner-backed tests cover both cases, checking that the first is pushed down. Explain shows the result as it does today.
Hunting and Resource Graph tabs use §4.2 alone, because their services filter wherever the line is.

### 4.5 Parameters

A cell value is never turned into a `{name}` parameter. The condition holds the literal (**My call**).

## 5. Column statistics

**Column statistics** in a column header's menu (and the command palette, for the focused column) opens a popover anchored
to the header (**My call**). It is worked out on the client from the rows the grid shows now, after any chart-click filter.
The popover says so ("Of 1,240 rows shown"), and nothing is rerun.

It shows:

- rows, distinct values and empty values;
- the top 10 values with count and share, as a small bar each, then "n more";
- for number columns, min, max and average; for datetimes, earliest and latest.

Each top value has Filter by and Exclude (§4) (**My call**: this is what turns statistics into narrowing). Dynamic values
are counted by their compact JSON.

Performance: one pass over the rows. Above 200,000 rows it shows a spinner and computes off the main thread, or in chunks
(left to the builder).

## 6. Group by column

This **extends the grouping that exists**: the grid toolbar's **Group by** menu in `result-grid.tsx` groups by one column,
with groups starting closed, and keeps its state in the component (**My call**: extend, don't replace). Added:

- **Group by this column** in a column header's menu. Headers today have only a sort button. The toolbar menu stays, and
  both add to the same grouping.
- Up to three columns, nested in the order chosen. A chip in the result bar shows `Grouped by A › B` with × to clear it.

- A group row shows the value, the row count and an open/close chevron. Groups start **closed** and are sorted by count,
  largest first (**My call**: that's where the bulk is).
- A group row's right-click menu has Filter by / Exclude for its value (§4).
- Sorting, the grid's own filter, row selection, Run tool, row details and copy keep working on the rows inside groups.
  Export writes the rows ungrouped.
- Keyboard: group rows take focus, and Left/Right close and open them.
- Grouping moves from component state to the tab and is kept while the app runs, across tab switches and reruns while the
  column still exists. It isn't saved (§3).
- Sorting groups by count is a change to today's order, so it gets a **Changed** entry in the changelog.

TanStack Table's grouped row model is the expected way. The virtualizer has to handle mixed row heights if group rows
differ (left to the builder).

## 7. Highlight rules

### 7.1 Model

```ts
interface HighlightRule {
  id: string;
  column: string;
  op: '==' | '!=' | '>' | '>=' | '<' | '<=' | 'contains' | '!contains' | 'isempty' | 'isnotempty';
  value: string;            // '' for isempty / isnotempty
  colour: 'danger' | 'warning' | 'success' | 'info';
  target: 'row' | 'cell';   // cell colours the rule's own column
}
```

- At most 20 rules per query (**My call**).
- Comparison by the column's type: numbers numerically, datetimes as instants (the value parsed as ISO 8601), timespans as
  durations, bool as `true`/`false`, strings case-insensitive (**My call**: the way you'd read a result). A value that can't
  be parsed for the type makes the rule never match, and the rule list marks it.
- Order matters: per row, the first matching **row** rule colours the row. Per cell, the first matching **cell** rule on that
  column colours the cell. A cell colour sits on top of a row colour.
- A rule on a column the result doesn't have is kept and shown as inactive in the list (**My call**).
- Colours are theme tokens (danger, warning, success, info) as a translucent background, added to every theme, light ones
  included, and they must keep text contrast at WCAG AA (**My call**). A highlighted row or cell also gets a coloured inside
  edge, so colour isn't the only signal.

### 7.2 Where rules are kept (Owner: with the query)

- `Tab.highlights?: HighlightRule[]`, kept in the session (`SessionTab`, `SessionService`) across restarts.
- `SavedQuery.highlights` in `wire.ts`, `SavedQuery` and `SavedQueryInput` in `LibraryService.cs`, with the same defaulting
  as `Options` (missing means none) and validation (ops, colours and targets from the lists above, at most 20, column
  names non-empty). Saving a tab saves its rules, and opening a saved query brings them back.
- `WidgetQuery.highlights` in a workbook, copied in by Add to workbook (§8) or set in the widget editor. A linked saved query
  copies its rules in like its text. Workbook export and import carry them.
- Changing rules makes the tab dirty.
- Solutions: solution items can include highlights. `SolutionHash.Query` and `LinkedCopyFields`
  (`src/Kustodian/Solutions/SolutionHash.cs`) hash only source, text, parameters and options today, so highlights are added
  to both. The field is **left out of the hash when there are no rules**, so queries already installed from a solution don't
  show as changed.

### 7.3 Creating from a cell (Owner)

The cell menu gets **Highlight rows where `Col == value`…**. It opens a small popover with the rule prefilled: the operator
to suit the type, colour **danger**, target **row**, which you can change before **Add**. Typical case: right-click `FAIL`,
then Add.

### 7.4 The rule list (Owner)

A **Highlight** chip in the result bar (`Highlight · 2` when there are rules, plain `Highlight` when none) opens the list:
one row per rule with colour, column (from the result's columns, or free text), operator, value and row/cell, plus
reorder (drag, and Alt+Up/Down), delete and **+ Add rule**. Changes apply live to the shown result. The mockup is under the
brainstorm session (option C).

### 7.5 Table widgets

A Table widget applies its query's rules the same way. The widget editor has a **Highlight** section with the same rule
list (**My call**). For a widget **linked** to a saved query, the list is read-only like the linked text, with "Edit the
saved query to change these". The rules refresh with the linked copy (**My call**).

## 8. Add to workbook…

**Add to workbook…** is in the query tab's ⋯ menu, the result bar and the command palette. It's only offered for Graph,
hunting and Resource Graph query tabs that have run at least once (**My call**: the widget kind is chosen from the result).

A dialog asks:

- **Workbook**: an existing one (searchable, with folders) or **New workbook** with a name and folder (`SaveWorkbookDialog`'s
  fields).
- **Widget**: Table, Chart or Stat. Preselected: Chart if the tab's Chart tab is showing, Stat for a one-row, one-number
  result, Table otherwise (**My call**).
- **Title**: defaults to the tab title.

Then:

- **Query**: if the tab is a saved query and isn't dirty, the widget **links** to it (`saved: {id, name}`). Otherwise the text
  is copied in, and the dialog says so: "Save the query first to link it" (**My call**). Source, options and highlight rules
  come along.
- **Chart settings**: the Chart tab's picked type, x axis, values, split and stacking become the widget's `chart`.
- **Parameters**: each of the tab's `{name}` parameters becomes a workbook parameter if the workbook has none of that name,
  and the widget takes it `from: 'workbook'`. If one of that name exists, the widget uses it as it is (**My call**).
- **Place**: at the top level, below the lowest widget, full width for Table and Chart, the minimum size for Stat
  (**My call**).
- The workbook is **saved** at once through the workbook store, so an open workbook tab updates too. That tab, or a newly
  opened one, comes to the front and scrolls to the new widget (**My call**). If the open workbook tab has unsaved edits,
  the widget is added to that draft and nothing is saved, and a notice says so (**My call**: never overwrite someone's
  draft).

## 9. Testing and docs

- Vitest: condition writing (every type in §4.3, quoting, escaping), insertion point (trailing `take`/`render`, multi-block
  text, changed text), statistics, grouping view state, rule matching and order, Add to workbook mapping (link versus copy,
  parameters, chart, place).
- .NET: `SavedQuery` highlights round-trip, defaults for old files, validation refusals. Session round-trip.
- `docs/manual-checks.md`: a check per feature in the real app, in a light and a dark theme.
- `CHANGELOG.md` under Unreleased with each PR. Update the README feature list and `docs/workbooks.md` (highlights in
  Table widgets, Add to workbook).
- No new warnings (`dotnet build -warnaserror`, `oxlint`, `tsc`).

## 10. Left to the builder

Component structure, popover and menu components (reuse existing menus and dialogs), how the grid's context menu is
added, keyboard shortcuts other than those named, and the exact copy beyond what's quoted here.
