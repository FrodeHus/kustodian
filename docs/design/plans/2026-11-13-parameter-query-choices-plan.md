# Workbook parameter choices from a query: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A workbook parameter can take its choices from a query (any source), reloaded when the parameters it uses change.

**Architecture:** The parameter stores `choicesQuery` beside `choices`. The store runs it as a pseudo-widget through the
existing `queue` (key `${tabId}/param:${name}`), so resolution, the hunting timespan, throttling, dropping and unload all come
for free; results become view state `choices[name]`. The bar and the dialog read that state. The host only strips solution
workspaces and CI parses the text.

**Tech stack:** React 19 + zustand + vitest (web), .NET 10 + xUnit (host).

**Spec:** `docs/design/specs/2026-11-13-parameter-query-choices-design.md`

## Global constraints

- Warnings are fixed, never suppressed: `dotnet build -warnaserror`, `npx tsc --noEmit`, `npx oxlint` clean (CLAUDE.md).
- At most 1,000 choices; over that: "Showing the first 1,000 choices."
- Copy, verbatim: "Couldn't load choices: <error>", "Loading choices…", "Pick a workspace for these choices.",
  "A parameter's choices can't use itself.", "The query returned no choices."
- Loading choices never changes a parameter's value.
- No workbook file version change; `choices` and `choicesQuery` are exclusive (query wins, `choices` null).

## Review focus

1. A choice query returning zero rows: the control is free entry with "The query returned no choices." (Task 3 test).
2. Non-string first/second columns (numbers, datetimes, null, dynamic): value is `String(v)`; null/empty dropped; duplicates
   keep the first (Task 2 test).
3. Two parameters whose choice queries use each other: one value change reloads the other once, no loop (Task 2 test).
4. A parameter renamed or removed in the dialog while its choices load: the old name's state is dropped, the new one loads
   (Task 2 test).
5. A failed or blocked (required value missing) choice query never blocks widgets that use the parameter (Task 2 test).

---

### Task 1: File model, import and export

**Files:**
- Modify: `web/src/workbooks/model.ts` (`WorkbookParameter`, `parseParameter`)
- Modify: `web/src/workbooks/import.ts` (`known`, `workspacesIn`, `applyImport`)
- Modify: `web/src/workbooks/import-review.tsx` (label a parameter's workspace use)
- Test: `web/src/workbooks/model.test.ts`, `web/src/workbooks/import.test.ts`

**Interfaces:**
- Produces: `export interface ChoicesQuery { source: Exclude<Source, 'raw'>; text: string; options: QueryOptions | null }`
  in `model.ts`; `WorkbookParameter.choicesQuery?: ChoicesQuery | null`.
- Produces: `workspacesIn(doc)` returns `{ workspace, widgets, parameters: string[] }[]` (`parameters` = labels or names of
  parameters whose choice query uses it).

- [ ] **Step 1: Failing tests**
  - `model.test.ts` "reads choicesQuery and drops choices beside it": parse a parameter with both → `choicesQuery` kept,
    `choices` null; a `choicesQuery` with source `raw` or non-string text → `choicesQuery` null.
  - `import.test.ts` "a shared file keeps choicesQuery with known fields only": unknown keys inside `choicesQuery` and its
    `options` are dropped; `workspaces` pass through `knownWorkspace`.
  - `import.test.ts` "workspacesIn counts a parameter's workspace": one widget and one parameter on workspace W →
    `[{ workspace: W, widgets: 1, parameters: ['Tables'] }]`.
  - `import.test.ts` "applyImport renames a parameter's workspace from the account list" (same rule as widgets).
- [ ] **Step 2:** `cd web && npx vitest run src/workbooks/model.test.ts src/workbooks/import.test.ts` → FAIL.
- [ ] **Step 3:** Implement. `parseParameter` validates source in `['graph','hunting','arg','logs']` and `text` string;
  `known` copies `choicesQuery` via `only(q, ['source','text'])` + the same options copy widgets get (extract that options
  copy into one helper used by both). Import review lists "choices for <label>" beside the widget count.
- [ ] **Step 4:** Same command → PASS.
- [ ] **Step 5:** Commit `Workbook parameters: choicesQuery in the file, import and review`.

### Task 2: Loading choices in the store

**Files:**
- Create: `web/src/workbooks/choices.ts`
- Modify: `web/src/workbooks/workbook-store.ts`
- Test: `web/src/workbooks/choices.test.ts`, `web/src/workbooks/workbook-store.test.ts`

**Interfaces:**
- Consumes: `ChoicesQuery` (Task 1).
- Produces in `choices.ts`:
  - `export interface Choice { value: string; label: string }`
  - `export type ParamChoices = { state: 'loading' } | { state: 'done'; items: Choice[]; capped: boolean } | { state: 'failed'; error: string } | { state: 'needsWorkspace' }`
  - `export const MAX_CHOICES = 1000`
  - `choiceWidget(p: WorkbookParameter): Widget | null`: a pseudo-widget `{ id: 'param:' + p.name, type: 'table', query: { ...p.choicesQuery, parameters: [], saved: null }, parameters: {} , … }`, null without a query.
  - `choicesFrom(result: RunResult): { items: Choice[]; capped: boolean }`
  - `choicesUsing(doc: WorkbookDoc, name: string): string[]`: names of parameters (other than `name`) whose choice query
    resolves `{name}` from the workbook or takes it as the hunting timespan; reuse `widgetParams`/`widgetsUsing` logic on
    `choiceWidget`s.
- Produces on the store: `WorkbookState.choices: Record<string, ParamChoices>`;
  `loadChoices(tabId: string, names?: string[]): Promise<void>` (all parameters with a query when `names` is omitted).
  `runAll` calls `loadChoices(tabId)` alongside the widgets; `setWorkbookValue` reloads `choicesUsing(doc, name)` on the
  same debounce key logic as widgets. Self-reference: the parameter's own `{name}` resolves as an empty text (no reload).

- [ ] **Step 1: Failing tests**
  - `choices.test.ts` "choicesFrom: first column value, second label, nulls dropped, duplicates keep the first":
    rows `[[1,'One'],[null,'x'],['',''],[1,'Dup'],[new Date(0).toISOString()]]` → `[{value:'1',label:'One'},{value:'1970-01-01T00:00:00.000Z',label:'1970-01-01T00:00:00.000Z'}]`.
  - "choicesFrom caps at 1000": 1001 rows → 1000 items, `capped: true`.
  - `workbook-store.test.ts` "loads choices with the widgets, under its own key, three per source": a hunting choice query +
    three hunting widgets → four `query.run`s, the fourth waits; answering sets `choices.Tables` to `done`.
  - "a logs choice query without a workspace is needsWorkspace and sends nothing".
  - "a value change reloads the choices that use it, not the others; A and B using each other reload once each".
  - "the hunting timespan reloads a hunting choice query and is sent as its timespan".
  - "a failed choice query leaves the value and the widgets run" (also a blocked one: required value missing → `failed`
    with the blocked reason, widgets unaffected).
  - "loading never changes the value": value `X` not among the loaded choices stays `X`.
  - "a renamed parameter drops the old name's choices after the dialog's runAll".
  - "unload drops a loading choice query" (its job key starts with `${tabId}/`).
- [ ] **Step 2:** `cd web && npx vitest run src/workbooks/choices.test.ts src/workbooks/workbook-store.test.ts` → FAIL.
- [ ] **Step 3:** Implement `choices.ts` and the store action: `queue(tabId, `${tabId}/param:${name}`, choiceWidget(p), refresh, …)`;
  map `done` with `outcome === 'ok'` → `choicesFrom`, any other result/failed → `failed` with `errorText`/`message`; a
  `logs` query without workspaces → `needsWorkspace` without queueing. Replace `choices` with only current parameter names
  on each `loadChoices()` without names. In `setWorkbookValue`, a parameter counts as picked (not typed) when it has fixed
  choices or `choices[name].state === 'done'`.
- [ ] **Step 4:** Same command → PASS; also `npx vitest run src/workbooks` → PASS.
- [ ] **Step 5:** Commit `Workbook parameters: load choices from a query`.

### Task 3: The parameter bar

**Files:**
- Modify: `web/src/workbooks/workbook-view.tsx` (`ParamControl`, `shownValue`, collapsed summary)
- Test: `web/src/workbooks/workbook-view.test.tsx`

**Interfaces:**
- Consumes: `ParamChoices`, `Choice` (Task 2); `useWorkbooks(s => s.byTab[tabId]?.choices[name])`.
- Produces: `effectiveChoices(param: WorkbookParameter, loaded: ParamChoices | undefined): Choice[] | null` in `choices.ts`
  (fixed list → `{value: c, label: c}`; query → loaded items when `done` and non-empty; else null).

- [ ] **Step 1: Failing tests** (`workbook-view.test.tsx`)
  - "query choices show as a select with their labels; picking one reruns at once".
  - "a multi list with All over query choices sends every loaded choice and shows All".
  - "while loading the current value shows with Loading choices…".
  - "a failed choice query is free entry with Couldn't load choices: <error>".
  - "no rows is free entry with The query returned no choices.".
  - "capped shows Showing the first 1,000 choices.".
  - "a logs query with no workspace says Pick a workspace for these choices. in edit mode".
- [ ] **Step 2:** `cd web && npx vitest run src/workbooks/workbook-view.test.tsx` → FAIL.
- [ ] **Step 3:** Implement: `ParamControl` works on `Choice[]` (option `value` = value, text = label) instead of strings;
  segment buttons check label length. Hints render under the control like `problem` does (`role="status"` for loading/capped,
  `role="alert"` for failure).
- [ ] **Step 4:** Same command → PASS.
- [ ] **Step 5:** Commit `Workbook parameters: the bar shows query choices`.

### Task 4: The parameters dialog

**Files:**
- Modify: `web/src/workbooks/parameters-dialog.tsx`
- Test: `web/src/workbooks/parameters-dialog.test.tsx`

**Interfaces:**
- Consumes: `ChoicesQuery` (Task 1), `useWorkbooks.getState().runDraft(tabId, choiceWidget(p))` and `choicesFrom` (Task 2)
  for Preview; `WorkspacePicker` from `../toolbar/workspace-picker` as the widget editor uses it.

- [ ] **Step 1: Failing tests**
  - "Choices: From a query shows source, KQL and, for logs and hunting, a workspace picker; saving writes choicesQuery and
    null choices".
  - "switching to None or Fixed list drops the query".
  - "Several values and Offer All show for a list with a query".
  - "a query using its own parameter says A parameter's choices can't use itself. and Save is off".
  - "Preview shows the first choices, or the error".
- [ ] **Step 2:** `cd web && npx vitest run src/workbooks/parameters-dialog.test.tsx` → FAIL.
- [ ] **Step 3:** Implement: Choices select gains `query` ("From a query"); `clean()` sets `choices` null when
  `choicesQuery` is set and treats a list with a query as `several`. New query defaults to
  `{ source: 'hunting', text: '', options: null }`. Preview lists at most 10 labels plus "and N more".
- [ ] **Step 4:** Same command → PASS.
- [ ] **Step 5:** Commit `Workbook parameters: From a query in the dialog`.

### Task 5: Solutions (host and CI)

**Files:**
- Modify: `src/Kustodian/Solutions/SolutionService.cs` (`PlanAsync`, the workspace strip loop)
- Modify: `tests/Kustodian.Tests/Solutions/RepoSolutionsTests.cs` (`WidgetQueries`)
- Test: `tests/Kustodian.Tests/Solutions/SolutionServiceInstallTests.cs`

- [ ] **Step 1: Failing test** `Install_StripsChoiceQueryWorkspaces`: a solution workbook whose parameter has
  `choicesQuery.options.workspaces` installs with no `workspaces` under that `options`, other fields unchanged.
- [ ] **Step 2:** `dotnet test tests/Kustodian.Tests --filter Install_StripsChoiceQueryWorkspaces` → FAIL.
- [ ] **Step 3:** Strip `parameters[].choicesQuery.options.workspaces` beside the widget loop. `WidgetQueries()` also yields
  each parameter's `choicesQuery` as `(folder, "workbooks/<id>.json (parameter <name>)", source, text, sharedDefs)` so
  `WidgetQueriesParse` and the Graph schema check cover it.
- [ ] **Step 4:** `dotnet test tests/Kustodian.Tests --filter "FullyQualifiedName~Solutions"` → PASS.
- [ ] **Step 5:** Commit `Solutions: strip and check parameter choice queries`.

### Task 6: Docs and full verification

**Files:** `docs/workbooks.md` (Parameters), `Solutions/README.md` (what CI checks; workspaces stripped), `CHANGELOG.md`
(Unreleased).

- [ ] **Step 1:** Write the docs: From a query, first column value / second label, 1,000 cap, reloads, failure falls back
  to free entry, workspace confirmation on import, solution install strips the workspace.
- [ ] **Step 2:** Run, all must pass with no warnings:
  `dotnet build -warnaserror`, `dotnet test`, `cd web && npx tsc --noEmit && npx oxlint && npx vitest run && npx prettier --check .`
- [ ] **Step 3:** In the app (run skill): a workbook with a hunting `Tables` parameter from
  `DeviceInfo | distinct OSPlatform`, multi + All; check the bar, a widget using it, and Preview in the dialog. Screenshot.
- [ ] **Step 4:** Commit `Docs: parameter choices from a query`.
