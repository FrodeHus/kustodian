# Result workflow, plan 1: smart filter

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Filter by / Exclude on a result value adds a `| where` line to the query in the editor and reruns exactly that text.

**Architecture:** The web side builds the condition from the column type and value. It then asks the host for the
insertion point in the text that ran, through a new bridge method `query.filterAt`. The host parses with Kusto.Language,
finds where the line goes (before a trailing `take`/`limit`/`render`, or, for Graph, right after the table's leading `where`s
when the column passes through unchanged), and returns a character offset. The web side inserts the line with a Monaco edit
(undoable), and the tab store sends the edited range.

**Tech Stack:** .NET 10, Microsoft.Azure.Kusto.Language 12.4.1, xUnit; React, TypeScript, Zustand, Monaco, Vitest.

**Spec:** `docs/design/specs/2026-11-10-result-workflow-design.md` §4 (and §3 for what's out).

**Branch:** `feat/smart-filter`, in its own worktree off `origin/main` (the owner's rule: several agents share the repo, so
edit only in a worktree).

## Global Constraints

- No warnings, none suppressed: `dotnet build -warnaserror`, `npm run lint` (oxlint), `npm run typecheck` (tsc). The two known
  open warnings in `CLAUDE.md` stay as they are.
- Offered only on the Rows tab of Graph, hunting and Resource Graph query tabs, and in their row details. Not in workbook
  widgets, the Compare view, raw request tabs or workbook tabs.
- The added line is `| where <condition>`, indented like the block's last line that starts with `|` (none: no indent).
- A string value longer than 1,000 characters isn't offered.
- A cell value is never turned into a `{name}` parameter.
- Copy: menu items `Filter by <value>`, `Exclude <value>`, and for datetimes also `On or after <value>`, `Before <value>`.
  The value is shown shortened to 40 characters with `…`.

## Review Focus

1. **A column name that needs quoting** (`['user name']`, a keyword like `['type']`): the condition must parse. Pinned in
   Task 1.
2. **A string with quotes, backslashes or newlines**: the literal must be exact, so the filter matches the row clicked.
   Pinned in Task 1.
3. **Editor text edited after the run** so that the ran text isn't at `origin` any more: the line must not land in the wrong
   place. Fall back to the block at the cursor, or a notice. Pinned in Task 3.
4. **A Graph query with `{name}` placeholders**: placement must still work, with offsets mapped back to the unsubstituted
   text. Pinned in Task 2.
5. **Undo**: one Ctrl/Cmd+Z removes the whole added line, and the tab's text in the store follows. Pinned in Task 4.

---

### Task 1: Conditions

**Files:**
- Create: `web/src/results/smart-filter.ts`
- Test: `web/src/results/smart-filter.test.ts`

**Interfaces:**
- Produces:
  - `export type FilterOp = 'eq' | 'ne' | 'ge' | 'lt';`
  - `export function columnName(name: string): string`: the name as written in KQL. Bracket-quoted (`['…']`, with `'` and `\`
    escaped) unless it matches `^[A-Za-z_][A-Za-z0-9_]*$` and isn't a KQL keyword. Use a small keyword set: `and`, `or`,
    `not`, `in`, `has`, `type`, `by`, `on`, `with`, `where`, `project`, `let`, `true`, `false`, `null`, `datetime`, `timespan`,
    `dynamic`.
  - `export function filterCondition(column: ResultColumn, value: unknown, op: FilterOp): string | null`: null when not
    offered (a string over 1,000 characters; `ge`/`lt` on a non-datetime).
  - `export function filterOps(column: ResultColumn, value: unknown): FilterOp[]`: the menu's ops in order. `['eq', 'ne']`,
    plus `'ge', 'lt'` for a non-empty datetime; `[]` when not offered.
  - `export function shownValue(value: unknown): string`: the menu's value text, 40 characters at most.

- [ ] **Step 1: Write the failing tests** (`describe('filterCondition')`), one `it` per row of spec §4.3, with exact strings:

```ts
const c = (name: string, type: string) => ({ name, type });
expect(filterCondition(c('state', 'string'), 'Enabled', 'eq')).toBe('state == "Enabled"');
expect(filterCondition(c('state', 'string'), 'a"b\\c\nd', 'ne')).toBe('state != "a\\"b\\\\c\\nd"');
expect(filterCondition(c('n', 'long'), 42, 'eq')).toBe('n == 42');
expect(filterCondition(c('r', 'real'), 1.5, 'eq')).toBe('r == 1.5');
expect(filterCondition(c('b', 'bool'), true, 'ne')).toBe('b != true');
expect(filterCondition(c('t', 'datetime'), '2026-11-10T08:00:00Z', 'eq')).toBe('t == datetime(2026-11-10T08:00:00.0000000Z)');
expect(filterCondition(c('t', 'datetime'), '2026-11-10T08:00:00Z', 'ge')).toBe('t >= datetime(2026-11-10T08:00:00.0000000Z)');
expect(filterCondition(c('d', 'timespan'), '01:30:00', 'eq')).toBe('d == timespan(01:30:00)');
expect(filterCondition(c('g', 'guid'), 'a1b2…', 'eq')).toBe('g == guid(a1b2…)'); // use a real GUID in the test
expect(filterCondition(c('x', 'dynamic'), { a: [1] }, 'eq')).toBe('tostring(x) == "{\\"a\\":[1]}"');
expect(filterCondition(c('s', 'string'), '', 'eq')).toBe('isempty(s)');
expect(filterCondition(c('s', 'string'), null, 'ne')).toBe('isnotempty(s)');
expect(filterCondition(c('n', 'long'), null, 'eq')).toBe('isnull(n)');
expect(filterCondition(c('n', 'long'), null, 'ne')).toBe('isnotnull(n)');
expect(filterCondition(c('user name', 'string'), 'x', 'eq')).toBe(`['user name'] == "x"`);
expect(filterCondition(c('type', 'string'), 'x', 'eq')).toBe(`['type'] == "x"`);
expect(filterCondition(c('s', 'string'), 'x'.repeat(1001), 'eq')).toBeNull();
expect(filterCondition(c('n', 'long'), 1, 'ge')).toBeNull();
```

  Also `filterOps` (datetime gets four, null datetime gets two, a long string gets none) and `shownValue` (41 characters
  becomes 40 ending in `…`). Use the type names the host sends (`string`, `long`, `int`, `real`, `decimal`, `bool`,
  `datetime`, `timespan`, `guid`, `dynamic`). Check `ResultColumn.type` values in `web/src/bridge.mock.ts` before
  finalising, and treat `int` like `long` and `decimal` like `real`.

- [ ] **Step 2: Run them and see them fail.** `cd web && npx vitest run src/results/smart-filter.test.ts`. Expected: FAIL,
  module not found.

- [ ] **Step 3: Implement** `smart-filter.ts`. String literals use double quotes with `\\`, `\"`, `\n`, `\r` and `\t`
  escaped. Datetimes are normalised with `new Date(v).toISOString()`, widened to 7 fraction digits. A value that isn't a
  valid date returns null. Numbers use `String(n)`, which is invariant.

- [ ] **Step 4: Run them and see them pass.** Same command. Expected: PASS.

- [ ] **Step 5: Commit.** `git add web/src/results/smart-filter*.ts && git commit -m "Build smart filter conditions from a value and its column type"`

### Task 2: Where the line goes (host)

**Files:**
- Create: `src/Kustodian.Graph/Query/FilterPlacement.cs`
- Modify: `src/Kustodian/Bridge/Handlers/QueryHandler.cs`: register `query.filterAt`. Extend the class summary.
- Modify: `web/src/wire.ts`: `FilterAtParams` and `FilterAtAnswer`. `web/src/bridge.mock.ts`: answer `query.filterAt`
  with the end of the text.
- Test: `tests/Kustodian.Graph.Tests/Query/FilterPlacementTests.cs`, `tests/Kustodian.Tests/Bridge/QueryHandlerFilterAtTests.cs`
  (or the existing QueryHandler test file if there is one; follow its setup).

**Interfaces:**
- Produces (C#): `public static class FilterPlacement { public static int? Offset(string kql, string column, GraphSchema? graph) }`.
  It returns the 0-based offset in `kql` after which the line goes: the end of a syntax node, with no trailing trivia. It
  returns null when the text has no query expression or doesn't parse into one. `graph` is non-null only for the Graph
  source.
- Produces (bridge): `query.filterAt` with params `{ source: 'graph'|'hunting'|'arg', kql: string, column: string,
  parameters?: ParameterValue[] }`, answering `{ offset: number | null }`. An unknown source is `bad_request`. Parameters
  are read with `ReadWithParameters`. When `kql` has placeholders, the host substitutes them (`ParameterSubstitution.Apply`),
  places the line in the substituted text, and maps the offset back with `MapBack`. If substitution fails, it places the
  line in the raw text.
- Produces (TS): in `wire.ts`, `export interface FilterAtParams { source: Exclude<Source, 'raw'>; kql: string; column: string; parameters?: ParameterValue[] }`
  and `export interface FilterAtAnswer { offset: number | null }`.

- [ ] **Step 1: Write the failing tests** (`FilterPlacementTests`). Each asserts the text up to the offset with
  `kql[..offset]`:

| Name | Source | kql | column | Expected `kql[..offset]` |
|---|---|---|---|---|
| `EndOfQuery` | hunting | `DeviceEvents \| where X == 1` | `X` | whole text |
| `BeforeTrailingTake` | hunting | `T \| project a \| take 10` | `a` | `T \| project a` |
| `BeforeTrailingLimitAndRender` | hunting | `T \| summarize n=count() by a \| limit 5 \| render columnchart` | `a` | `T \| summarize n=count() by a` |
| `AfterTop` | hunting | `T \| top 5 by a` | `a` | whole text |
| `LastStatement` | arg | `let x = 1;\nResources \| take 3` | `name` | `let x = 1;\nResources` |
| `Multiline` | hunting | `T\n\| where a > 1\n\| take 10\n` | `a` | `T\n\| where a > 1` |
| `GraphLeading` | graph | `users \| where accountEnabled == true \| project id, displayName \| take 50` | `displayName` | `users \| where accountEnabled == true` |
| `GraphNoLeadingWhere` | graph | `users \| project id, displayName \| take 50` | `displayName` | `users` |
| `GraphComputedColumn` | graph | `users \| extend n = strlen(displayName) \| take 5` | `n` | `users \| extend n = strlen(displayName)` |
| `GraphRenamedColumn` | graph | `users \| project-rename name = displayName` | `name` | whole text |
| `GraphSelfJoin` | graph | `users \| join (users) on id` | `id` | whole text |
| `NotAQuery` | hunting | `.show tables` | `x` | null |

  Use `GraphSchemaCatalog.Beta` for Graph. Also add a planner-backed test, `GraphLeadingIsPushedDown`: insert
  ` | where displayName == "x"` at the `GraphLeading` offset, plan it with `GraphQueryPlanner.Plan`, and assert that the
  fetch's `$filter` contains `displayName eq 'x'` and its `$top` is 50. Add `GraphPlaceholders` to the handler tests: kql
  `users | where displayName == {name} | take 5` with parameter `name` = `x`, and an offset equal to the end of
  `{name}`.

- [ ] **Step 2: Run them and see them fail.** `dotnet test tests/Kustodian.Graph.Tests --filter FilterPlacement`. Expected:
  build error, `FilterPlacement` not found.

- [ ] **Step 3: Implement `FilterPlacement.Offset`.**
  1. Parse: `KustoCode.ParseAndAnalyze(kql, GraphGlobals.Plain(graph))` for Graph, `KustoCode.Parse(kql)` otherwise.
  2. Take the last statement's expression.
  3. **Generic:** walk the outermost `PipeExpression` chain. While its `Operator` is a `TakeOperator` (which covers `limit`)
     or a `RenderOperator`, step to `pipe.Expression`. Return that node's end (`TextStart + Width`, trivia excluded).
  4. **Graph first:** run this before the generic rule.
     - The table must be used exactly once (`GraphQueryPlanner.LeadingPredicates` is non-null; make it and `TableUses`
       visible to the class if needed, as `internal`).
     - `code.ResultType` must have a column named `column` that is, by reference, one of that table's `ColumnSymbol`s.
     - If so, return the end of the last leading `where` pipe, or the end of the table reference when there is none.
  5. Use the planner's existing helpers. Don't write a second walker for table uses.

- [ ] **Step 4: Run them and see them pass.** Same command, plus `dotnet test tests/Kustodian.Tests --filter FilterAt`.
  Expected: PASS.

- [ ] **Step 5: Register the handler and type it.** Register `query.filterAt` in `QueryHandler.Register`, off the dispatching
  thread like `query.explain` (`Task.Run`). Add the `wire.ts` types and the mock case.
  `dotnet build -warnaserror` and `cd web && npm run typecheck` pass.

- [ ] **Step 6: Commit.** `git commit -am "Find where a smart filter's where goes, Graph pushdown kept"` (add the new files first).

### Task 3: Placing and running the line (web)

**Files:**
- Modify: `web/src/results/smart-filter.ts`
- Modify: `web/src/tabs/tab-store.ts`: new `runText`.
- Test: `web/src/results/smart-filter.test.ts`, `web/src/tabs/tab-store.test.ts`

**Interfaces:**
- Consumes: `FilterAtAnswer`, and `TabRun.origin` and `kql` (`tab-store.ts`), and `blockAt` (`editor/block-at.ts`).
- Produces:
  - `export interface FilterTarget { kql: string; origin: { line: number; column: number } }`
  - `export function filterTarget(text: string, run: { kql: string; origin: { line: number; column: number } }, cursorLine: number): FilterTarget | null`.
    Steps:
    1. If `run.kql` isn't found in `text` at `origin`, use the block at the cursor (`blockAt(text, cursorLine)`). If that is
       empty, return null.
    2. If the ran text has several blocks (blank-line separated), use the **last** one.
    3. If a selection run ended mid-line (the editor line goes on after the ran text's end), use the block holding that end.
  - `export function withLine(target: FilterTarget, offset: number, condition: string): { text: string; endLine: number; endColumn: number }`:
    the target's text with `\n<indent>| where <condition>` inserted at `offset`, and the edit's position in the editor.
    `indent` is the leading whitespace of the target's last line that starts with optional whitespace then `|`.
  - In `TabsState`: `runText(id: string, kql: string, origin: TabRun['origin']): Promise<void>`. It sends that text, like
    `rerun` but with new text. Same guards as `run`.

- [ ] **Step 1: Write the failing tests.**
  - `filterTarget`: run at origin found; text changed so it falls back to the cursor's block; empty, so null; run all with
    two blocks, so the last one; a selection ending mid-line, so the enclosing block.
  - `withLine`: an indented pipe (`    | take 5` gives `    | where …`); no pipes (`users` gives `\n| where …`); insertion in
    the middle of the block keeps the text after it.
  - `runText` in `tab-store.test.ts`: sends `query.run` with the given kql and records that origin. Follow the
    existing `rerun` tests.

- [ ] **Step 2: Run them and see them fail.** `cd web && npx vitest run src/results/smart-filter.test.ts src/tabs/tab-store.test.ts`.

- [ ] **Step 3: Implement** the three functions.

- [ ] **Step 4: Run them and see them pass.** Same command.

- [ ] **Step 5: Commit.** `git commit -am "Place a smart filter's line in the text that ran and run it"`

### Task 4: Menus and wiring

**Files:**
- Modify: `web/src/editor/kql-editor.tsx`: `KqlEditorHandle.replaceLines`.
- Modify: `web/src/results/result-grid.tsx`: cell context menu.
- Modify: `web/src/results/row-details.tsx`: a menu per top-level property.
- Modify: `web/src/results/result-panel.tsx` (pass `onFilter` through) and `web/src/app.tsx` (implement it).
- Test: `web/src/results/result-grid.test.tsx`, `web/src/results/row-details.test.tsx`, `web/src/editor/kql-editor.test.tsx`,
  `web/src/app.test.tsx` (or wherever app-level run flows are tested; follow the existing pattern).

**Interfaces:**
- Consumes: Tasks 1 to 3.
- Produces:
  - In `KqlEditorHandle`: `replaceLines(startLine: number, endLine: number, text: string): boolean`. It replaces those
    whole lines of the active model with `executeEdits('smart-filter', …)`, between `pushUndoStop()` calls so one undo
    removes it, and returns false when the editor isn't ready. The model's change reaches the store through the existing
    change listener. Don't call `setText` directly.
  - `ResultGrid` and `RowDetails` get an optional prop `onFilter?: (column: ResultColumn, value: unknown, op: FilterOp) => void`.
    No prop means no menu, so the Compare view, table widgets and history tables keep today's behaviour.
  - `ResultPanel` gets `onFilter?` and passes it to both.

- [ ] **Step 1: Write the failing tests.**
  - Grid: right-clicking a cell with `onFilter` opens a `role="menu"` with `Filter by "Enabled"` and `Exclude "Enabled"`.
    Choosing one calls `onFilter(column, value, 'eq')`. Escape closes it and returns focus to the grid. Without `onFilter`,
    right-click shows nothing. A datetime cell shows four items.
  - Row details: each top-level property row has a "Filter…" menu button with the same items.
  - Editor: `replaceLines` followed by `editor.trigger('', 'undo')` restores the text.
  - App flow, with the mock bridge: the tab ran `users | take 5`, Filter by on `displayName`. Expected: `query.filterAt`
    called, the editor text becomes `users\n| where displayName == "x"\n| take 5`, and `query.run` sent with that text.
    When `query.filterAt` answers null, the line goes at the target's end. When `filterTarget` is null, a notice reads
    "Couldn't find the query to add the filter to." and nothing runs.

- [ ] **Step 2: Run them and see them fail.**

- [ ] **Step 3: Implement.**
  - The grid menu reuses the menu markup and keyboard handling of `MenuButton` in `result-grid.tsx`. Extract a `Menu`
    piece from `MenuButton` if needed, rather than writing a second one. It opens at the pointer.
  - Keyboard users get the same items through row details: Enter opens the row, then the property's Filter… button. The grid
    focuses rows, not cells, so there's no cell to anchor a keyboard menu to. Note this in `docs/manual-checks.md`.
  - `app.tsx`'s `onFilter` does this:
    1. Builds the condition (Task 1).
    2. Calls `filterTarget` with the active tab's text, run and cursor (Task 3).
    3. Calls `query.filterAt` with the tab's source, the target's kql, the column and `runParameters(tab)`.
    4. Calls `withLine`.
    5. Calls `editorRef.current.replaceLines(target lines…)`.
    6. Calls `useTabs.getState().runText(id, newKql, target.origin)`.

    It's offered only when the tab's source is graph, hunting or arg and the tab has run.

- [ ] **Step 4: Run them and see them pass.** Then run everything: `cd web && npm run lint && npm run typecheck && npm test`.

- [ ] **Step 5: Commit.** `git commit -am "Filter by and Exclude from a result cell or row details"`

### Task 5: Docs and real-app check

**Files:**
- Modify: `CHANGELOG.md` (Unreleased › Added), `README.md` (the Results bullet), `docs/manual-checks.md`.

- [ ] **Step 1: Add docs.**
  - The changelog entry, in the file's style: **Smart filter**: right-click a value on the Rows tab, or use Filter… in
    row details, to add `| where` for it, or to exclude it. The line goes into the query so you can keep it, and the query
    reruns. On Graph tables it is placed so Graph still filters.
  - A manual check: Graph `users | project id, displayName | take 50`, Filter by a name. Then Explain shows `$filter` and
    `$top=50`, and Ctrl/Cmd+Z removes the line. Do it once in a light theme and once in a dark one.

- [ ] **Step 2: Run the full checks.** `dotnet build -warnaserror && dotnet test`, and `cd web && npm run lint && npm run typecheck && npm test`. All pass, no new warnings.

- [ ] **Step 3: Check it in the real app** (the `run` skill). Run the manual check above and take a screenshot.

- [ ] **Step 4: Commit and open the PR.** `git commit -am "Document the smart filter"`, push `feat/smart-filter`, and open a
  PR to `main`.
