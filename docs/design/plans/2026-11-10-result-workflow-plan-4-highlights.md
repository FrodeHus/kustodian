# Result workflow, plan 4: highlight rules

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rows or cells that need attention are coloured by rules that belong to the query. You make the rules from a cell or in a rule list. They are saved with the query, kept in the session, carried into workbooks, and applied in Table widgets.

**Architecture:**
- A pure module `web/src/results/highlights.ts` decides which rules match a row. The grid takes a `highlights` prop and
  colours rows and cells with theme tokens.
- The rules live on the tab, like `options`: in the session, on a saved query (in the host's `SavedQuery` and
  `SavedQueryInput`, and in the solution hash), and on a workbook widget's query, copied from a linked saved query.
- One reusable rule list component edits them, in the result bar's Highlight popover and in the widget editor.

**Tech Stack:** .NET 10 and xUnit for the host, plus React, TypeScript, Zustand and Vitest.

**Spec:** `docs/design/specs/2026-11-10-result-workflow-design.md` §7 (and §8 says Add to workbook copies rules; that's
plan 5).

**Branch:** `feat/highlights`, in the worktree `.worktrees/highlights`, off `origin/main` at `f5907c8`.

## Global Constraints

- No warnings, none suppressed: `dotnet build -warnaserror`, and in `web/` `npm run format:check` (CI runs it first),
  `npm run lint` and `npm run typecheck`.
  - The known open oxlint warnings are `react(incompatible-library)` in `result-grid.tsx`, and `react(immutability)` in
    `explain-view.tsx` and `kql-editor.tsx`.
  - Non-component helpers go in non-component modules (`react(only-export-components)`).
- **The model**, verbatim from the spec: `{ id: string; column: string; op: '==' | '!=' | '>' | '>=' | '<' | '<=' | 'contains' | '!contains' | 'isempty' | 'isnotempty'; value: string; colour: 'danger' | 'warning' | 'success' | 'info'; target: 'row' | 'cell' }`.
  `value` is `''` for `isempty` and `isnotempty`.
- **At most 20** rules per query.
- **Comparison by column type:**
  - Numbers (`int`, `long`, `real`, `decimal`, using `NUMERIC` from `column-stats.ts`) compare numerically.
  - `datetime` compares as instants, with the value parsed as ISO 8601.
  - `timespan` compares as durations: `[-][d.]hh:mm:ss[.fffffff]`, and a bare number counts as seconds.
  - `bool` compares as `true`/`false`, case-insensitive.
  - Everything else compares as case-insensitive strings. Dynamic values compare by their compact JSON.
  - `contains` and `!contains` are case-insensitive substring tests on the cell text, for every type.
  - A value that can't be parsed for the column's type makes the rule never match.
  - `isempty` matches `null`, missing and `''`. `isnotempty` is its negation.
- **Order:** for each row, the first matching **row** rule colours the row. For each cell, the first matching **cell** rule
  on that column colours the cell. A cell colour sits on top of a row colour.
- **Inactive rules:** a rule on a column the result doesn't have is kept and listed as inactive. A rule whose value can't
  be parsed is listed with a problem note.
- **Colours** are theme tokens, used as a translucent background plus a 3px coloured inside edge (`box-shadow: inset 3px 0 0 <colour>`),
  so colour isn't the only signal:
  - `danger` is `--bad` with `--bad-soft`.
  - `warning` is `--warn` with `--warn-soft`.
  - `success` is `--ok` with a new `--ok-soft`.
  - `info` is `--accent` with `--accent-soft`.

  Add `--ok-soft` everywhere `--bad-soft` is defined: `styles.css` for each theme, and `shell/palettes.ts` (`soft(p.ok, 14)`).
  Text stays the theme's `--text`.
- **Kept with the query:**
  - It goes on the tab, the session, the saved query and the widget query.
  - Changing rules makes the tab dirty, as a text edit does.
  - Opening a saved query brings its rules. Saving a tab saves them.
  - A linked widget copies its saved query's rules, as it copies the text.
  - Workbook export and import carry them.
  - Missing means none, everywhere: old files, sessions and solutions load unchanged.
- **Solution hash:** `highlights` is added to `SolutionHash.Query` and to `LinkedCopyFields` only when there is at least
  one rule. A query or workbook without rules hashes exactly as before.
- **Copy:**
  - The cell menu item: `Highlight rows where <column> == <value>…` (the value shown as in the filter items, via `shownValue`).
  - The result bar chip: `Highlight` with no rules, `Highlight · <n>` with rules.
  - The rule list title: `Highlight rules`. Its buttons: `+ Add rule`, then `Remove` and `Move up` / `Move down` (accessible
    names) per rule.
  - The inactive note: `Not in this result`. The problem note: `Can’t read this value as <type>`.
  - The prefilled popover's button is `Add`.
  - The widget editor tab is `Highlight`. On a linked widget it shows `Edit the saved query to change these.`
- **Accessibility:** the rule list and the popover are `role="dialog"` with labels, and Esc closes them. Reordering works
  with Alt+Up / Alt+Down on a focused rule as well as the buttons. Drag is optional and not required.

## Rulings in this plan (for the owner to check)

- **No drag to reorder.** The spec says "drag, and Alt+Up/Down". This plan has Move up / Move down buttons and Alt+Up/Down.
  It leaves drag out, since the keyboard and buttons cover it and drag-and-drop in WKWebView is fiddly. It can be added later.
- **`info` uses the accent colour.** No theme has an info colour.
- **`contains` matches text for every type,** including numbers and dates, as it reads on screen.

## Review Focus

1. **Old data:**
   - A saved query, session or solution file without `highlights` loads, saves back without gaining an empty
     `highlights: []`, and hashes the same.
   - Pinned in Task 2 (host) and Task 3 (web).
2. **Validation at the trust boundary:**
   - The host refuses an unknown op, colour or target, more than 20 rules, an empty column, or a value over 1,000
     characters (my cap, to keep files small). It gives a clear message, the same way options problems are refused.
   - Pinned in Task 2.
3. **Large results:**
   - Matching runs per rendered row, through the virtualizer, not over all rows, and parses each rule's value once per rule
     change, not per cell.
   - Pinned in Task 1 (a `compileRules` step) and Task 4.
4. **Contrast in light themes:**
   - A highlighted row's text stays readable in GitHub Light, One Light, Catppuccin Latte and Solarized Light.
   - Pinned by the controller's browser check and a manual-check row.
5. **Linked widget:**
   - Its rules can't be edited in the widget editor and refresh from the saved query.
   - Pinned in Task 6.

---

### Task 1: Matching

**Files:**
- Create: `web/src/results/highlights.ts`
- Modify: `web/src/wire.ts`. Add `HighlightRule`, `HighlightColour` and `HighlightOp` next to `QueryOptions`.
- Test: `web/src/results/highlights.test.ts`

**Interfaces:**
- Produces:

```ts
export const MAX_HIGHLIGHTS = 20;
export const HIGHLIGHT_OPS: HighlightOp[];      // in the order the list's picker shows them
export const HIGHLIGHT_COLOURS: HighlightColour[]; // danger, warning, success, info
export interface CompiledRules { /* opaque */ }
/** Parses each rule's value once against the columns; rules on missing columns or with unreadable values never match. */
export function compileRules(rules: HighlightRule[], columns: ResultColumn[]): CompiledRules;
/** The row's colour and each highlighted cell's colour (by column index), first match wins. */
export function highlightOf(compiled: CompiledRules, row: unknown[]): { row: HighlightColour | null; cells: Map<number, HighlightColour> };
/** 'missing' (column not in the result), 'unreadable' (value can't be read as the column's type), or null. */
export function ruleProblem(rule: HighlightRule, columns: ResultColumn[]): 'missing' | 'unreadable' | null;
/** The rule a cell's "Highlight rows where…" prefills: == (isempty for an empty value), danger, row. */
export function ruleFromCell(column: ResultColumn, value: unknown): HighlightRule;
```

- [ ] **Step 1: Write the failing tests.** One `describe` per type, covering every op:
  - String: `FAIL` == `fail` matches. `contains`/`!contains` are case-insensitive.
  - Number: `long` 97 `>` `'90'` matches, and `'abc'` makes the rule `unreadable` and never match.
  - Datetime: `>=` `'2025-01-01T00:00:00Z'`.
  - Timespan: `'01:30:00'` `>` `'3600'`.
  - Bool: `TRUE` == `true`.
  - Dynamic: `{a:1}` == `'{"a":1}'`.
  - `isempty`/`isnotempty` on `null`, `''` and `0`. `0` is not empty.
  - Order:
    - Two row rules, the first wins.
    - A cell rule and a row rule both apply (`row` and `cells` set).
    - A cell rule targets its own column index.
  - A missing column gives `ruleProblem` → `'missing'` and no match.
  - `ruleFromCell`: a string gives `==`, `danger`, `row`, the value as text. `null` gives `isempty` with value `''`.
    Each rule gets a fresh `id` (use the repo's `newId`).
- [ ] **Step 2: Run them and see them fail.** `cd web && npx vitest run src/results/highlights.test.ts`
- [ ] **Step 3: Implement.** `compileRules` resolves each rule's column index and parses its value once.
- [ ] **Step 4: Run them and see them pass,** then run `npm run format:check && npm run lint && npm run typecheck`.
- [ ] **Step 5: Commit.** `git commit -m "Match highlight rules against a row"` (add new files)

### Task 2: Host: saved queries, session and solution hash

**Files:**
- Modify: `src/Kustodian/Library/LibraryService.cs`
  - `HighlightRule` record (`Id`, `Column`, `Op`, `Value`, `Colour`, `Target`).
  - `SavedQuery` and `SavedQueryInput` get `IReadOnlyList<HighlightRule>? Highlights = null`.
  - `ToInput` carries it, and `Save` writes it.
  - `Problem` validates it.
- Modify: `src/Kustodian/Session/SessionService.cs`: `SessionTab` gets `Highlights = null`, with the same validation when
  the session is read (an invalid list is dropped with a log line, not the whole session).
- Modify: `src/Kustodian/Solutions/SolutionHash.cs`: `Query` adds `["highlights"]` only when non-empty, and
  `LinkedCopyFields` includes `"highlights"`.
- Test:
  - `tests/Kustodian.Tests/Library/` (follow the existing LibraryService tests)
  - `tests/Kustodian.Tests/Session/`
  - `tests/Kustodian.Tests/Solutions/` (follow the existing SolutionHash tests)

**Interfaces:**
- Produces:
  - JSON field `highlights` (camelCase, as `JsonFileStore.Options` writes) on saved queries, saved query inputs and session
    tabs.
  - Each item is `{id, column, op, value, colour, target}`.
  - Null or missing means none. When there are no rules, the field is written as null or left out, matching how `options`
    is written today. It is never `[]` for an old file read and saved back.

- [ ] **Step 1: Write the failing tests.**
  - Library:
    - Save with two rules, then list: they round-trip.
    - An old file with no `highlights` reads with `Highlights == null`, and saving it back writes no `highlights` array.
    - `Problem` refuses each of these, with messages starting `The highlight rules`:
      - an unknown op, colour or target;
      - 21 rules;
      - an empty column;
      - a value over 1,000 characters.
  - Session: a tab with rules round-trips. A session with one tab's invalid rules keeps the tab and drops its rules.
  - Solution hash:
    - The hash of a query without rules equals the pre-change hash. Pin the literal the current code produces for a
      fixture query, and compute it before changing the code.
    - With rules, the hash changes.
    - A linked widget copy's `highlights` is ignored in `Workbook(...)`.
- [ ] **Step 2: Run them and see them fail.** `dotnet test tests/Kustodian.Tests --filter "Library|Session|SolutionHash"`
- [ ] **Step 3: Implement.** Follow how `Options` is defaulted (`QueryOptionsDefaults`) and validated.
- [ ] **Step 4: Run them and see them pass,** then run `dotnet build -warnaserror && dotnet test`.
- [ ] **Step 5: Commit.** `git commit -m "Keep highlight rules with saved queries and the session"`

### Task 3: Web: rules on the tab, saved and restored

**Files:**
- Modify: `web/src/wire.ts`. `SavedQuery`, `SessionTab` and the save input type get `highlights?: HighlightRule[] | null`.
- Modify: `web/src/tabs/tab-store.ts`:
  - `Tab.highlights?: HighlightRule[]`.
  - `TabSeed.highlights?`.
  - `setHighlights(id, rules)` marks the tab dirty, as `setText` does.
  - `restore` and `openWith` take it.
- Modify: `web/src/session/session-sync.ts` (the snapshot includes `highlights` only when non-empty, like `options`),
  `web/src/library/saving.ts` (sends `highlights`) and `web/src/library/open-library.ts` (opening a saved query passes them).
- Test: `web/src/tabs/tab-store.test.ts`, `web/src/session/session-sync.test.ts`, `web/src/library/saving.test.ts`, and
  the open-library tests.

**Interfaces:**
- Consumes: Task 1's types, and Task 2's JSON field.
- Produces: `useTabs.getState().setHighlights(id: string, rules: HighlightRule[]): void` and `Tab.highlights`.

- [ ] **Step 1: Write the failing tests.**
  - `setHighlights` stores the rules and makes the tab dirty.
  - The session snapshot has `highlights` only when non-empty, and `restore` brings them back.
  - Saving sends them.
  - Opening a saved query with rules seeds the tab with them.
  - `markSaved` clears dirty after a save that included them.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and see them pass,** plus the full web checks.
- [ ] **Step 5: Commit.** `git commit -am "Keep a tab's highlight rules in the session and the library"`

### Task 4: Colouring the grid

**Files:**
- Modify:
  - `web/src/results/result-grid.tsx`: a `highlights?: HighlightRule[]` prop. Compile with `useMemo` on `[highlights, columns]`. Each rendered leaf row gets
    `data-highlight="<colour>"` on the `<tr>`, and each highlighted cell gets `data-highlight` on its `<td>`.
  - `web/src/styles.css`: `--ok-soft` in every theme block, and the `[data-highlight=…]` rules.
  - `web/src/shell/palettes.ts`: `'--ok-soft': soft(p.ok, 14)`.
  - `web/src/results/result-panel.tsx`: pass the tab's highlights to the Rows grid. `ResultPanel` gets a `highlights` prop
    from `app.tsx`'s `Results`.
- Test: `web/src/results/result-grid.test.tsx`, `web/src/shell/palettes.test.ts` (if it exists; otherwise one assertion that
  `--ok-soft` is set).

**Interfaces:**
- Consumes: Task 1's `compileRules` and `highlightOf`, and Task 3's `Tab.highlights`.
- Produces: `ResultGrid` prop `highlights?`, and the `data-highlight` attribute and CSS that later tasks and the widget reuse.

- [ ] **Step 1: Write the failing tests.**
  - With a row rule `state == FAIL`, the FAIL rows' `<tr>` have `data-highlight="danger"` and the others have none.
  - A cell rule on `days > 90` marks only that `<td>` with `warning`.
  - A cell and a row rule both show.
  - No `highlights` prop means no attributes.
  - The attributes follow grouping, sorting and the row filter: only rendered leaf rows have them, never group rows.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.**
  - CSS: `tr[data-highlight="danger"] td { background: var(--bad-soft) }`, with the first cell getting
    `box-shadow: inset 3px 0 0 var(--bad)`.
  - `td[data-highlight="danger"] { background: var(--bad-soft); box-shadow: inset 3px 0 0 var(--bad) }`.
  - The same for the other three colours.
  - Selected and inspected rows keep their own look on top. Check how `.sel` and `.inspected` are styled and order the
    rules so selection still shows.
- [ ] **Step 4: Run them and see them pass,** plus the full web checks.
- [ ] **Step 5: Commit.** `git commit -am "Colour highlighted rows and cells"`

### Task 5: The rule list and making a rule from a cell

**Files:**
- Create: `web/src/results/highlight-list.tsx`, which exports `HighlightList`.
- Create: `web/src/results/highlight-popover.tsx`, which exports `HighlightFromCell`.
- Modify:
  - `web/src/results/result-panel.tsx`: the `Highlight` / `Highlight · n` chip in the result bar's toolbar. Put it in the
    grid's toolbar slot, before `Copy as`, on the Rows tab only. It opens `HighlightList` in a popover anchored to the
    chip.
  - `web/src/results/result-grid.tsx`: the cell menu gets the `Highlight rows where …` item when an `onHighlight` prop is
    given.
  - `web/src/app.tsx`: wire `setHighlights`.
- Test: `web/src/results/highlight-list.test.tsx`, `web/src/results/highlight-popover.test.tsx`, `web/src/results/result-grid.test.tsx`

**Interfaces:**
- Consumes: Tasks 1, 3 and 4. Also `Menu` and `keepInside` from `./menu` and `./keep-inside`.
- Produces:
  - `HighlightList({ rules, columns, onChange, readOnly }: { rules: HighlightRule[]; columns: ResultColumn[]; onChange: (rules: HighlightRule[]) => void; readOnly?: boolean })`:
    - One row per rule with:
      - a colour select (named by colour);
      - a column input with a datalist of the result's columns, so free text is allowed;
      - an op select;
      - a value input, hidden for `isempty` and `isnotempty`;
      - a row/cell select;
      - Move up / Move down and Remove buttons.
    - Alt+Up / Alt+Down on a focused rule move it.
    - The `Not in this result` and `Can’t read this value as <type>` notes, from `ruleProblem`.
    - `+ Add rule` adds `{column: first column, op: '==', value: '', colour: 'danger', target: 'row'}`. It is disabled at 20,
      with the title `Up to 20 rules`.
    - Every change calls `onChange` at once, so the result updates live.
    - With `readOnly`, everything is disabled.
  - `HighlightFromCell({ column, value, at, onAdd, onClose })`:
    - The rule from `ruleFromCell`, with colour and row/cell selects, `Add` and Esc.
    - The cell menu item opens it at the menu's point.
  - `ResultGrid` prop `onHighlight?: (rule: HighlightRule) => void`. The cell menu shows the item only with it.
  - The chip's count is the number of rules, including inactive ones.

- [ ] **Step 1: Write the failing tests.**
  - List:
    - Add, edit and remove call `onChange` with the right list.
    - Alt+Down moves the focused rule down.
    - Move up is disabled on the first rule.
    - It shows `Not in this result` for a missing column, and `Can’t read this value as long` for `days > 'abc'`.
    - `+ Add rule` is disabled at 20.
    - `readOnly` disables every control.
  - Popover: it prefills `state == "FAIL"`, danger, row. Changing to cell then `Add` calls `onAdd` with `target: 'cell'`.
    Esc closes it.
  - Grid: the cell menu shows `Highlight rows where state == "FAIL"…` only with `onHighlight`. Choosing it opens the
    popover.
  - Panel: the chip reads `Highlight` and then `Highlight · 1` after adding a rule. Opening it shows the dialog
    `Highlight rules`.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.** Reuse existing form control classes (see the widget editor's selects and inputs) and theme
  tokens.
- [ ] **Step 4: Run them and see them pass,** plus the full web checks.
- [ ] **Step 5: Commit.** `git commit -am "Make highlight rules from a cell or in a rule list"` (add the new files)

### Task 6: Workbooks

**Files:**
- Modify:
  - `web/src/workbooks/model.ts`: `WidgetQuery.highlights?: HighlightRule[]`. The doc reader keeps it, and drops an
    invalid list the way it treats other invalid fields.
  - `web/src/workbooks/widget-editor.tsx`: `fromSaved` copies `highlights`, and a `Highlight` section tab is added for
    Table widgets. It holds `HighlightList` with the widget's result columns, and is `readOnly` with the note when the
    query is linked.
  - `web/src/workbooks/workbook-store.ts`: `withLinkedCopies` copies `highlights`, and so does `readLibrary`'s use, if
    linked widgets render from the library cache. Check `resolve.ts`.
  - `web/src/workbooks/widgets/table-widget.tsx`: pass `highlights` to `ResultGrid`.
- Test: `web/src/workbooks/model.test.ts`, `widget-editor.test.tsx`, `workbook-store.test.ts`, `sharing.test.ts`, and the
  table widget test file if there is one.

**Interfaces:**
- Consumes: Tasks 1, 4 and 5.
- Produces: `WidgetQuery.highlights` is carried in the workbook JSON, which the host never interprets.

- [ ] **Step 1: Write the failing tests.**
  - A Table widget with rules marks its rows (`data-highlight`).
  - The widget editor's Highlight tab edits an inline widget's rules. On a linked widget it is read-only and shows
    `Edit the saved query to change these.`
  - `withLinkedCopies` and `fromSaved` copy the saved query's rules.
  - Export → import round-trips a widget's rules.
  - A doc without `highlights` reads unchanged.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and see them pass,** plus the full web checks.
- [ ] **Step 5: Commit.** `git commit -am "Highlight rules in Table widgets"`

### Task 7: Docs

**Files:**
- Modify: `CHANGELOG.md` (Unreleased › Added), `README.md` (the Results bullet), `docs/workbooks.md` (Table widgets:
  highlight rules, and linked widgets follow the saved query), `docs/manual-checks.md` (a new
  `### Highlight rules (2026-11-10)` section after Grouping).

- [ ] **Step 1: Write the docs.**
  - Changelog: **Highlight rules**:
    - Colour rows or cells that need attention.
    - Right-click a value to highlight rows like it, or open **Highlight** on the Rows tab for rules such as
      `days > 90` on one cell.
    - Rules are saved with the query, kept across restarts, and apply in Table widgets.
  - Manual checks:
    - Make a rule from a cell, then a threshold cell rule.
    - Save, restart and reopen.
    - Each light theme and a dark one, for readability.
    - A Table widget with a linked saved query follows its rules.
    - A rule on a column a rerun drops shows `Not in this result`.
- [ ] **Step 2: Run the full checks.** `dotnet build -warnaserror && dotnet test`, and `cd web && npm run format:check && npm run lint && npm run typecheck && npm test`.
- [ ] **Step 3: Commit.** `git commit -am "Document highlight rules"`. Don't push.
