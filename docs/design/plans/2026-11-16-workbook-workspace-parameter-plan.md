# Workbook workspace parameter: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A workbook parameter of type `workspace` sets the workspace of every Log Analytics and hunting widget (and choice
query) that doesn't set it itself.

**Architecture:** Resolution lives in `resolve.ts` next to the hunting timespan: `widgetRunOptions` puts the resolved
workspace into the options it returns, and `queue` checks the resolved options, so widgets, previews and choice queries all
follow. UI: the bar and the dialog get a picker for the new type; the widget editor defers to the parameter. Host: solution
install clears the value; CI refuses a shipped one.

**Tech stack:** React 19 + zustand + vitest (web), .NET 10 + xUnit (host).

**Spec:** `docs/design/specs/2026-11-16-workbook-workspace-parameter-design.md`

## Global constraints

- Warnings are fixed, never suppressed: `dotnet build -warnaserror`, `npx tsc --noEmit`, `npx oxlint` clean (CLAUDE.md).
- Value is the customer id (GUID "D") or `''`. Sent to the host as parameter type `text` when used in query text.
- Copy, verbatim: "A workbook can have only one workspace parameter.", "The workspace comes from the <label> parameter.",
  "Pick a workspace." (existing), "not available to this account".
- Never send a query to a workspace the user didn't pick. No file version change.
- `choicesQuery`-style rule: write no new keys into existing files (repo `src/solutions/repo-workbooks.test.ts` round-trip).

## Review focus

1. Workbook with a workspace parameter and a widget whose own `options.workspaces` names another workspace: the parameter wins
   unless the widget's entry for it is shown/fixed (Task 1 test).
2. Workspace parameter empty: Log Analytics widget gets "Pick a workspace." and sends nothing; hunting widget sends no
   workspace and keeps the 30-day cap (Task 1/2 tests).
3. Timespan of 90d with a workspace parameter set: allowed for hunting (730 cap); same with it empty: refused at 30 (Task 1).
4. Changing the workspace value reruns only Log Analytics/hunting widgets and choice queries that use it, not Graph/ARG
   widgets (Task 2 test).
5. The parameters dialog type change from `workspace` to `list` drops nothing it shouldn't and a second workspace parameter
   blocks Save (Task 3 test).

---

### Task 1: Resolution

**Files:** Modify `web/src/workbooks/model.ts`, `web/src/workbooks/resolve.ts`; Test `web/src/workbooks/resolve.test.ts`.

**Interfaces — produces:**
- `model.ts`: `export const WORKBOOK_PARAMETER_TYPES = [...PARAMETER_TYPES, 'workspace'] as const;`
- `resolve.ts`: `export function workspaceParameter(doc: WorkbookDoc): WorkbookParameter | undefined` (first of type
  `workspace`); `export function widgetWorkspace(doc, widget, values): { set: boolean; customerId: string }` — `set` false
  when the workbook has no workspace parameter (the widget's own options apply), else the resolved id (`''` = none).
- `widgetRunOptions` returns options whose `workspaces` is `[{ customerId, name: '', resourceId: '' }]` or omitted per the
  spec, for `logs`/`hunting` widgets, combined with the hunting timespan branch (cap from the resolved workspace).
- `widgetsUsing(doc, name)` includes `logs`/`hunting` widgets for the workspace parameter's name unless their entry is
  shown/fixed. `toParameterValues` sends type `workspace` as `text`.

- [ ] **Step 1: Failing tests** (`resolve.test.ts`): "the workspace parameter overrides a widget's own workspace";
  "a widget's fixed entry for it wins"; "empty value: logs gets no workspace, hunting none"; "the timespan cap follows the
  resolved workspace (90d ok with one, refused without)"; "widgetsUsing lists logs and hunting widgets, not graph/arg";
  "toParameterValues sends workspace as text"; "a workbook without a workspace parameter keeps widget options unchanged".
- [ ] **Step 2:** `cd web && npx vitest run src/workbooks/resolve.test.ts` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Same command → PASS; `npx vitest run src/workbooks` → PASS.
- [ ] **Step 5:** Commit `Workbook parameters: resolve the workspace parameter`.

### Task 2: Store

**Files:** Modify `web/src/workbooks/workbook-store.ts`; Test `web/src/workbooks/workbook-store.test.ts`.

**Interfaces — consumes:** Task 1's `widgetRunOptions`/`widgetsUsing`. In `queue`, the logs-without-workspace check uses the
resolved options (`options.workspaces`), not `widget.query.options`. `choicesUsing` (choices.ts) treats the workspace
parameter like the hunting timespan for logs/hunting choice queries; `setWorkbookValue` for it is not debounced (picked).

- [ ] **Step 1: Failing tests:** "a logs widget runs on the workspace parameter's value"; "empty workspace parameter: logs
  says Pick a workspace and sends nothing"; "changing it reruns logs/hunting widgets and logs choice queries, not graph";
  "history series differ per workspace value" (the sent options carry the workspace).
- [ ] **Step 2:** `cd web && npx vitest run src/workbooks/workbook-store.test.ts src/workbooks/choices.test.ts` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Same → PASS; full `npx vitest run` → PASS.
- [ ] **Step 5:** Commit `Workbook parameters: widgets run on the workspace parameter`.

### Task 3: Bar, dialog and widget editor

**Files:** Modify `web/src/workbooks/workbook-view.tsx` (`ParamControl`, `shownValue`), `parameters-dialog.tsx`,
`widget-editor.tsx`; Tests `workbook-view.test.tsx`, `parameters-dialog.test.tsx`, `widget-editor.test.tsx`.

**Interfaces — consumes:** `WORKBOOK_PARAMETER_TYPES`, `workspaceParameter` (Task 1); `WorkspacePicker`
(`../toolbar/workspace-picker`), `useAccountWorkspaces` (`./account-workspaces`).

- [ ] **Step 1: Failing tests:** bar — "a workspace parameter is a picker; picking sets the customer id and reruns at once";
  "None clears it"; "a value not in the account list shows its short id and not available to this account"; collapsed
  summary shows the workspace name. Dialog — "type offers workspace"; "a second workspace parameter shows A workbook can have
  only one workspace parameter. and Save is off"; "a workspace parameter hides Choices, Several values and Offer All; its
  Default is a picker". Widget editor — "a logs or hunting widget in a workbook with a workspace parameter shows The workspace
  comes from the <label> parameter. instead of its picker".
- [ ] **Step 2:** `cd web && npx vitest run src/workbooks/workbook-view.test.tsx src/workbooks/parameters-dialog.test.tsx src/workbooks/widget-editor.test.tsx` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Same → PASS; full `npx vitest run`, `npx tsc --noEmit`, `npx oxlint` → clean.
- [ ] **Step 5:** Commit `Workbook parameters: workspace picker in the bar and dialog`.

### Task 4: Import, solutions and CI

**Files:** Modify `web/src/workbooks/import.ts`, `web/src/workbooks/workspace-rows.tsx`, `src/Kustodian/Solutions/SolutionService.cs`,
`tests/Kustodian.Tests/Solutions/RepoSolutionsTests.cs`; Tests `import.test.ts`, `workspace-rows.test.tsx`,
`tests/Kustodian.Tests/Solutions/SolutionServiceInstallTests.cs`.

- [ ] **Step 1: Failing tests:** web — "workspacesIn lists a workspace parameter's default as parameter <label>";
  "applyImport keeps it". C# — `Install_ClearsWorkspaceParameterValue` (value becomes `""`, workbook not reported modified);
  a RepoSolutionsTests check `WorkspaceParametersShipEmpty` (fails on a non-empty value; passes on the current catalog).
- [ ] **Step 2:** `cd web && npx vitest run src/workbooks/import.test.ts src/workbooks/workspace-rows.test.tsx` and
  `dotnet test tests/Kustodian.Tests --filter "FullyQualifiedName~Solutions"` → FAIL.
- [ ] **Step 3:** Implement (C# clears before `SolutionHash.Workbook`).
- [ ] **Step 4:** Same → PASS; `dotnet build -warnaserror` clean.
- [ ] **Step 5:** Commit `Solutions: workspace parameters install empty`.

### Task 5: Docs and verification

**Files:** `docs/workbooks.md`, `Solutions/README.md`, `docs/design/specs/2026-11-10-workspaces-design.md` (mark the open
question closed with a pointer), `CHANGELOG.md`.

- [ ] **Step 1:** Write the docs from the spec.
- [ ] **Step 2:** `dotnet build -warnaserror`, `dotnet test`, `cd web && npx tsc --noEmit && npx oxlint && npx vitest run && npx prettier --check .` → all clean.
- [ ] **Step 3:** Commit `Docs: workbook workspace parameter`.
