# Workbook parameter choices from a query

Status: approved 2026-11-13. Builds on the workbooks design (`2026-11-06-workbooks-design.md` §6.3, "Choices from a query:
any source; first column the value, second the label. v2").

## Why

A workbook parameter's choices are a fixed list typed by the author. Many lists depend on the tenant: the tables in a
workspace, subscriptions, device groups. The first user is a log-cost workbook whose Tables parameter should list the tables
in `Usage` instead of asking people to type table names. A fixed list can't know them, and a free-text list makes users
guess.

## Goals

- A workbook parameter's choices can come from a query in any source (Graph, hunting, Resource Graph, Log Analytics).
- First result column is the value; an optional second column is the label shown for it.
- Several values and **All** work as with a fixed list; All sends every loaded choice.
- The choice query may use other workbook parameters and the workbook timespan, and reloads when they change.

## Non-goals

- Query tabs' parameters form (`params/params-form.tsx`): workbooks only.
- "Set by a click" (a table row sets a parameter): separate v2 item.
- Linking a choice query to a saved library query: the text lives in the parameter.
- Choices from a widget's result column (considered, see Approaches).

## Anti-goals

- A failing choice query must never stop widgets from running or lose the user's current value.
- A workspace arriving in a file must never be queried unconfirmed (workspaces design, rule 1).

## Approaches

1. **Own query per parameter** (picked). Any source, independent of layout, what the spec planned. Costs a run path for
   parameters, plus the import, solution and CI paths widgets already have.
2. **Column of a widget's result.** Reuses widget runs, workspace confirmation and solution stripping as they are. Rejected:
   the list must be a widget on the page, and a widget on a hidden tab never runs, so its parameter would have no choices.

## Design

### File format

`WorkbookParameter` gains `choicesQuery`, null or left out for none:

```json
"choicesQuery": { "source": "logs", "text": "Usage | distinct DataType", "options": { "workspaces": [ … ] } }
```

`source` is `graph`, `hunting`, `arg` or `logs` (not `raw`); `options` is the same `QueryOptions` a widget query has
(workspace, scope), or null. `choices` and `choicesQuery` are exclusive: with a query, `choices` is null. Unknown fields stay
kept as today. No file version change: an older Kustodian ignores the field and shows free entry.

### Parameters dialog

**Choices** gets a third option, **From a query**. It shows a source select, a KQL box (plain textarea, monospace; my call:
no Monaco in the dialog), and a workspace picker for Log Analytics and hunting (the widget editor's picker). A **Preview**
button runs it and shows the first choices or the error. Switching away from From a query drops the query. Several values
and Offer All show for a list with a query, as for a fixed list. A `{name}` referring to the parameter itself is an error
under the box ("A parameter's choices can't use itself.").

### Running

- A choice query runs through the workbook store's queue under the key `${tabId}/param:${name}`, so it shares the per-source
  limit of three and is dropped when a newer run starts. It is not added to Recent and never recorded in history.
- Its `{name}` placeholders resolve from the workbook's current values (as a widget's do when they come from the workbook).
  The huntingTimespan parameter applies to hunting and logs choice queries as it does to widgets.
- It runs when the workbook opens, on Refresh all, after the parameters dialog saves, and when a workbook parameter it uses
  changes (same debounce as widgets). A Log Analytics choice query without a workspace doesn't run; the control says
  "Pick a workspace for these choices." in edit mode.
- Choices are view state in the store (`choices[name]: { state, items: {value,label}[], error }`), never saved.

### Choices and values

- Value = first column as text; label = second column as text when there is one, else the value. Rows with an empty value
  are dropped; duplicates keep the first. At most 1,000 choices; more says "Showing the first 1,000 choices."
- Loading never changes the parameter's value. A value not among the loaded choices is kept and shown, as today.
- All sends every loaded choice (the same `dynamic([...])` a list sends). The bar shows "All" when every loaded choice is
  picked.
- While loading, the control shows its current value and a "Loading choices…" hint; it stays usable.

### When it fails

The control falls back to free entry (text, or one-per-line for a list) with "Couldn't load choices: <error>" under it, and
the widgets keep running with the current value. A required parameter with no value still blocks its widgets, as today.

### Import, sharing and solutions

- `workspacesIn` (import review) counts a choice query's workspace with the widgets', named "choices for <label>".
  `applyImport` keeps or drops it by the same rule as widget workspaces.
- Export writes `choicesQuery` as is.
- Solution install (`SolutionService.PlanAsync`) removes `workspaces` from each parameter's `choicesQuery.options`, as it does
  for widgets, so a Log Analytics choice query waits for the user to pick one.
- Repo solution CI (`RepoSolutionsTests`) parses choice queries like widget queries, and Graph ones are planned against the
  schema.

### Docs

`docs/workbooks.md` Parameters section: From a query, columns, limits, failure. `docs/solutions.md`/`Solutions/README.md`:
choice-query workspaces are stripped. CHANGELOG under Unreleased.

## Left to the builder

- Where the choice state and reload triggers live in `workbook-store.ts` (reuse `queue`, `rerunAfter`, `widgetsUsing`-style
  dependency detection).
- Exact layout of the From a query fields in the dialog.
- Test split between `parameters-dialog.test.tsx`, `workbook-store.test.ts`, `workbook-view.test.tsx`, `import.test.ts` and
  the C# solution tests.
