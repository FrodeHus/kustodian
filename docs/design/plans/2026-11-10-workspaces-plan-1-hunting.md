# Workspaces, part 1: hunting with a workspace — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hunting tabs, saved queries, history and workbook widgets can target a Log Analytics workspace through Graph's
`runHuntingQuery` `workspaceId`, picked from a workspace list read through Azure Resource Graph.

**Architecture:** `QueryOptions` gains a `Workspaces` list (one allowed). `ArmDirectory` lists workspaces with an ARG query
and the bridge serves it as `arm.workspaces`. `HuntingQuerySource` refuses a workspace the account can't see (a new
`WorkspaceUnavailable` outcome) and `HuntingClient` adds `workspaceId` to the body only when one is set. The web app gets a
workspace picker beside the timespan picker, a blocked-run card, workspace-aware workbook options, and a "Workspaces" section
in the two import reviews.

**Tech Stack:** .NET (xUnit), React + TypeScript + Zustand (Vitest), oxlint.

**Spec:** `docs/design/specs/2026-11-10-workspaces-design.md` (part 1 and "Shared"). Mockups:
`docs/design/mockups/HuntingWorkspace.dc.html`, `WorkspaceBlocked.dc.html`, `WorkbookConfirm.dc.html`.

## Global Constraints

- Stable APIs only: Graph v1.0 `https://graph.microsoft.com/v1.0/security/runHuntingQuery`; ARG through the existing `ArgClient`.
- With no workspace, the hunting request body stays byte-for-byte what it is today: `{"Query":…,"Timespan":…}`.
- One workspace per query in v1; stored as a list.
- Timespan cap: 30 days with no workspace (as today); 730 days with a workspace.
- The no-workspace choice is labelled **"Primary workspace"**, subtitle "Default. Defender's tables, plus your primary Sentinel workspace if one is connected."
- Blocked copy: "{name} isn't available to this account. Pick a workspace."
- Fallback note copy: "If Defender can't reach {name}, it answers from your primary workspace."
- Warnings are fixed, never suppressed: `dotnet build -warnaserror`, `npm run lint`, `npm run typecheck` pass (CLAUDE.md).
- Work in a worktree on a branch of its own (`feat/hunting-workspace`), cut from `main` after the design branch merges.

## Review Focus

1. **The workspace list can't be read** (no ARM consent, ARM down): the run is blocked with the list's own message, never sent without a check. Test in Task 3.
2. **Account switch:** a tab saved with tenant A's workspace, run as tenant B's account, is blocked (lists are per account). Test in Task 3.
3. **Old files:** saved queries, history and workbooks without `workspaces` load unchanged and send exactly today's body. Tests in Tasks 1 and 3.
4. **Author-controlled names:** a workspace `name` in an imported file is display text only; only a GUID `customerId` is ever sent. Test in Task 1 (`Problem`) and Task 6 (import keeps only the three fields).
5. **Mixed workbook timespans:** a 90-day workbook timespan is fine for a widget with a workspace and a problem for a widget without one. Test in Task 6.

---

### Task 1: Workspaces in the run options

**Files:**
- Modify: `src/Kustodian.Graph/Run/QueryOptions.cs`
- Modify: `web/src/wire.ts:250-262`
- Test: `tests/Kustodian.Graph.Tests/Run/QueryOptionsTests.cs` (create)

**Interfaces:**
- Produces (C#): `public sealed record QueryWorkspace(string CustomerId, string Name, string ResourceId);`
  `public sealed partial record QueryOptions(string? Timespan, ArgScope? Scope, IReadOnlyList<QueryWorkspace>? Workspaces = null)`;
  `public static readonly TimeSpan MaxTimespanWithWorkspace = TimeSpan.FromDays(730);` `MaxTimespan` (30 days) stays.
- Produces (TS): `export interface QueryWorkspace { customerId: string; name: string; resourceId: string }` and
  `QueryOptions.workspaces?: QueryWorkspace[] | null`.

- [ ] **Step 1: Write the failing tests** (`QueryOptionsTests`, xUnit `[Fact]`s)

```csharp
static QueryWorkspace Ws(string id = "00000000-0000-0000-0000-000000000001") => new(id, "contoso-sentinel", "/subscriptions/…/workspaces/contoso-sentinel");

[Fact] public void No_workspaces_is_fine() => Assert.Null(QueryOptions.Problem(new("P30D", null)));
[Fact] public void One_workspace_is_fine() => Assert.Null(QueryOptions.Problem(new("P90D", null, [Ws()])));
[Fact] public void Two_workspaces_are_refused() => Assert.Equal("Pick one workspace.", QueryOptions.Problem(new(null, null, [Ws(), Ws()])));
[Fact] public void A_customer_id_must_be_a_guid() => Assert.Equal("not-a-guid is not a workspace id.", QueryOptions.Problem(new(null, null, [Ws("not-a-guid")])));
[Fact] public void A_null_entry_is_refused() => Assert.Equal("The workspace is missing.", QueryOptions.Problem(new(null, null, [null!])));
[Fact] public void Over_30_days_without_a_workspace_is_refused() => Assert.Equal("The timespan can cover at most 30 days.", QueryOptions.Problem(new("P31D", null)));
[Fact] public void Up_to_730_days_with_a_workspace() { Assert.Null(QueryOptions.Problem(new("P730D", null, [Ws()]))); Assert.Equal("The timespan can cover at most 730 days.", QueryOptions.Problem(new("P731D", null, [Ws()]))); }
[Fact] public void Empty_list_counts_as_none() => Assert.Equal("The timespan can cover at most 30 days.", QueryOptions.Problem(new("P31D", null, [])));
```

- [ ] **Step 2: Run them to see them fail**

Run: `dotnet test tests/Kustodian.Graph.Tests --filter FullyQualifiedName~QueryOptionsTests`
Expected: build error, `QueryWorkspace` not defined.

- [ ] **Step 3: Implement** `QueryWorkspace`, the third `QueryOptions` part (defaulted, so every existing `new(timespan, scope)` still compiles) and `Problem`: the cap is `MaxTimespanWithWorkspace` when `Workspaces` has an entry, else `MaxTimespan`; workspace checks run after the timespan and before the scope, with the messages above (`Guid.TryParseExact(id, "D", …)`). Update the XML docs to name the third part. In `wire.ts`, add `QueryWorkspace` and the optional `workspaces` field with a one-line doc.

- [ ] **Step 4: Run the tests** — same command. Expected: PASS. Then `dotnet build -warnaserror` and `cd web && npm run typecheck`: no errors.

- [ ] **Step 5: Commit** — `feat: workspaces in a run's options`

### Task 2: List workspaces (`arm.workspaces`)

**Files:**
- Modify: `src/Kustodian.Sources/Arg/ArmDirectory.cs`
- Modify: `src/Kustodian/Bridge/Handlers/ArmHandler.cs`
- Modify: `web/src/wire.ts` (answer type), `web/src/bridge.mock.ts` (sample answer)
- Test: `tests/Kustodian.Sources.Tests/Arg/ArmDirectoryTests.cs`

**Interfaces:**
- Consumes: `ArgClient.RunAsync(accountKey, kql, ArgScope.Default, maxRows, diagnostics, ct)` as `ResourceTypesAsync` uses it.
- Produces (C#): `public sealed record ArmWorkspace(string CustomerId, string Name, string ResourceId, string ResourceGroup, string SubscriptionId, string Location);`
  `public Task<IReadOnlyList<ArmWorkspace>> ArmDirectory.WorkspacesAsync(string accountKey, CancellationToken ct)`;
  `public const string WorkspacesQuery` (the spec's ARG query, verbatim); `public static readonly TimeSpan WorkspacesCacheFor = TimeSpan.FromMinutes(10);`
- Produces (wire): `arm.workspaces` → `{ workspaces: ArmWorkspace[] }`; TS `ArmWorkspace { customerId, name, resourceId, resourceGroup, subscriptionId, location }`, `ArmWorkspacesAnswer`.

- [ ] **Step 1: Write the failing tests** in `ArmDirectoryTests`, with the fake ARM handler the file already uses:
  - `Workspaces_come_from_resource_graph`: the ARG body sent contains `microsoft.operationalinsights/workspaces`; two rows map to two `ArmWorkspace`s with every field.
  - `A_row_without_a_customer_id_is_left_out`.
  - `Workspaces_are_kept_ten_minutes_per_account`: second call within 10 minutes sends nothing; at 10 minutes it reads again; another account reads its own.
  - `RemoveAccount_forgets_workspaces`.
  - `A_failed_read_throws_and_is_not_kept`: ARG answers 500 → `ArmDirectoryException`; the next call reads again.
- [ ] **Step 2: Run** `dotnet test tests/Kustodian.Sources.Tests --filter FullyQualifiedName~ArmDirectoryTests`. Expected: build error.
- [ ] **Step 3: Implement** `WorkspacesAsync` like `ResourceTypesAsync` (own cache dictionary, cleared in `RemoveAccount`, max rows 10,000), and register `arm.workspaces` in `ArmHandler` the way `arm.subscriptions` is. Add the TS types and a mock answer with the five workspaces in `HuntingWorkspace.dc.html`.
- [ ] **Step 4: Run** the tests, `dotnet build -warnaserror`. Expected: PASS, no warnings.
- [ ] **Step 5: Commit** — `feat: list Log Analytics workspaces through Resource Graph`

### Task 3: Hunting runs on a workspace

**Files:**
- Modify: `src/Kustodian.Graph/Run/RunResult.cs` (outcome), `src/Kustodian.Sources/Hunting/HuntingClient.cs`, `src/Kustodian.Sources/Hunting/HuntingQuerySource.cs`, `src/Kustodian/App/AppServices.cs:174`
- Modify: `web/src/wire.ts:110` (outcome union)
- Test: `tests/Kustodian.Sources.Tests/Hunting/HuntingQuerySourceTests.cs`, a new `HuntingClientTests.cs` beside it if the request body isn't already tested there

**Interfaces:**
- Consumes: `QueryOptions.Workspaces` (Task 1), `ArmDirectory.WorkspacesAsync` (Task 2).
- Produces: `RunOutcome.WorkspaceUnavailable` (wire `workspaceUnavailable`);
  `HuntingClient.RunAsync(string accountKey, string kql, string timespan, string? workspaceId, RunDiagnostics d, CancellationToken ct)`;
  `HuntingQuerySource(HuntingClient client, ArmDirectory directory, TimeProvider time, ILogger<HuntingQuerySource>? logger = null)`.

- [ ] **Step 1: Write the failing tests**
  - `No_workspace_sends_todays_body`: the body is exactly `{"Query":"T","Timespan":"P30D"}`, and `ArmDirectory` is never called.
  - `A_workspace_is_sent_as_workspaceId`: body `{"Query":"T","Timespan":"P90D","workspaceId":"<guid>"}`.
  - `A_workspace_the_account_cant_see_is_not_run`: list lacks the id → outcome `WorkspaceUnavailable`, message `"contoso-sentinel isn't available to this account. Pick a workspace."`, Graph never called.
  - `Another_accounts_workspace_is_not_run`: the id is in account A's list; run as account B (whose list lacks it) → `WorkspaceUnavailable`.
  - `An_unreadable_list_blocks_the_run`: `WorkspacesAsync` throws `ArmDirectoryException("Azure couldn't be reached…")` → `WorkspaceUnavailable` with that message; Graph never called. A `ConsentRequiredException` still propagates (as today).
  - `A_workspace_run_notes_the_fallback`: diagnostics contain `"If Defender can't reach contoso-sentinel, it answers from your primary workspace."`
  - `A_TenantId_that_differs_warns`: result has a `TenantId` column whose values aren't all the chosen customer ID → a warning diagnostic `"Some rows came from another workspace than contoso-sentinel: Defender may have answered from your primary workspace."` No `TenantId` column → no warning.
  - `NoPermission_with_a_workspace_mentions_Sentinel_Reader`: 403 → message ends with `" With a workspace you also need Microsoft Sentinel Reader on it."`
- [ ] **Step 2: Run** `dotnet test tests/Kustodian.Sources.Tests --filter FullyQualifiedName~Hunting`. Expected: build errors.
- [ ] **Step 3: Implement.** `HuntingRequest` gets a nullable `workspaceId` written only when set (`[JsonIgnore(Condition = WhenWritingNull)]`, JSON name `workspaceId`). `HuntingQuerySource.RunAsync` checks the workspace before the request: not found → `End(RunOutcome.WorkspaceUnavailable, …)`; `ArmDirectoryException` / `SignInRequiredException` from the list → `WorkspaceUnavailable` with its message (sign-in keeps `SignInNeeded`). Add the outcome to `RunOutcome`, the TS union, and every C# and TS switch over outcomes (`grep -rn "RunOutcome\.\|outcome ===" src web/src`). Wire `AppServices` with `_armDirectory`.
- [ ] **Step 4: Run** the tests, `dotnet build -warnaserror`, `cd web && npm run typecheck`. Expected: PASS, clean.
- [ ] **Step 5: Commit** — `feat: run hunting queries on a chosen workspace`

### Task 4: The workspace picker on hunting tabs

**Files:**
- Create: `web/src/toolbar/workspace-picker.tsx`, `web/src/toolbar/workspace-picker.test.tsx`
- Modify: `web/src/tabs/tab-store.ts:67-79` (`runOptions`), `web/src/app.tsx:879-897` (toolbar), `web/src/toolbar/timespan-picker.tsx` (cap and presets), `web/src/tabs/tab-store.test.ts`

**Interfaces:**
- Consumes: `arm.workspaces` (Task 2), `QueryWorkspace` (Task 1).
- Produces: `export function WorkspacePicker(props: { workspaces: QueryWorkspace[] | null | undefined; onChange(workspaces: QueryWorkspace[] | null): void; accountKey: string | null; onSignIn(): void; open: boolean; onOpenChange(open: boolean): void; primaryLabel?: string })`;
  `TimespanPicker` gains `maxDays: number` (30 or 730) and shows a "90 days" preset when `maxDays > 30`; `picker` state accepts `'workspace'`.

- [ ] **Step 1: Write the failing tests** (`workspace-picker.test.tsx`, mocking `call` as `scope-picker.test.tsx` does)
  - `shows_primary_workspace_first_and_checked_when_none`: label "Primary workspace", subtitle copy from Global Constraints.
  - `lists_workspaces_with_group_subscription_and_location`: subscription names come from `arm.subscriptions`, falling back to the id.
  - `picking_a_workspace_reports_one_entry`: `onChange([{ customerId, name, resourceId }])`.
  - `picking_primary_reports_null`.
  - `a_saved_workspace_missing_from_the_list_shows_not_available`: button text "Workspace: contoso-sentinel · not available".
  - `consent_and_sign_in_states_match_the_scope_picker` (`consentNeeded` → consent button; `signInNeeded` → sign-in).
  - In `tab-store.test.ts`: `hunting_run_sends_workspaces` (`options: { timespan: 'P30D', scope: null, workspaces: [ws] }`), and `hunting_run_without_workspace_sends_null` (`workspaces: null`).
  - In the timespan picker's tests: `ninety_days_only_with_a_workspace`.
- [ ] **Step 2: Run** `cd web && npx vitest run src/toolbar src/tabs`. Expected: FAIL.
- [ ] **Step 3: Implement** the picker after `scope-picker.tsx`'s structure (radio list, search, the same problem states), `runOptions` passing `workspaces: tab.options?.workspaces ?? null` for hunting, and the toolbar showing `WorkspacePicker` before `TimespanPicker` on hunting tabs with `maxDays={workspaces?.length ? 730 : 30}`. Changing the workspace goes through `setOptions` (marks the tab dirty, as the scope does). A new hunting tab starts with no workspace.
- [ ] **Step 4: Run** the tests, `npm run lint`, `npm run typecheck`. Expected: PASS, clean.
- [ ] **Step 5: Commit** — `feat: workspace picker on hunting tabs`

### Task 5: The blocked run and the wording

**Files:**
- Modify: `web/src/results/run-status.tsx`, `web/src/results/source-wording.ts`, `web/src/app.tsx` (open the picker from the card)
- Test: `web/src/results/run-status.test.tsx` (create or extend), `web/src/results/source-wording.test.ts` if present

**Interfaces:**
- Consumes: `workspaceUnavailable` (Task 3), picker `'workspace'` state (Task 4).
- Produces: `RunStatus` prop `onPickWorkspace?(): void`.

- [ ] **Step 1: Write the failing tests**
  - `workspace_unavailable_shows_the_message_and_a_pick_button`: renders "Not run", the host's message, and a "Pick a workspace" button that calls `onPickWorkspace`.
  - `the_run_line_names_the_workspace`: a hunting run with a workspace reads "Running the query in Microsoft Defender with contoso-sentinel"; without one, today's text.
  - `a_workspace_run_shows_the_fallback_chip`: the chip text from Global Constraints.
- [ ] **Step 2: Run** `cd web && npx vitest run src/results`. Expected: FAIL.
- [ ] **Step 3: Implement**, matching `WorkspaceBlocked.dc.html` and `HuntingWorkspace.dc.html`: the toolbar's Run stays enabled (the host decides), and the picker button turns `--bad` when the tab's workspace isn't in the list. The hunting schema panel shows the mockup's note under the tables when a workspace is set ("Its Sentinel tables aren't listed here yet. Queries on them still run."), unless a live check shows `getHuntingSchema` already lists them; record what you found in the PR.
- [ ] **Step 4: Run** tests, lint, typecheck. Expected: PASS, clean.
- [ ] **Step 5: Commit** — `feat: say why a hunting run on a missing workspace didn't run`

### Task 6: Workbooks and imports

**Files:**
- Modify: `web/src/workbooks/resolve.ts:60-120`, `web/src/workbooks/model.ts:409-430` (`isoTimespan`), `web/src/workbooks/widget-editor.tsx`, `web/src/workbooks/import.ts:39-46`, `web/src/workbooks/import-review.tsx`, `web/src/solutions/solution-dialog.tsx`
- Test: `web/src/workbooks/resolve.test.ts`, `web/src/workbooks/model.test.ts`, `web/src/workbooks/import.test.ts`, `web/src/workbooks/import-review.test.tsx`, the solution dialog's test

**Interfaces:**
- Consumes: `WorkspacePicker` (Task 4), `QueryWorkspace` (Task 1).
- Produces: `isoTimespan(kql: string, maxDays = 30): string | null`; `huntingTimespanProblem(name: string, value: string, maxDays = 30): string | null`; `export function workspacesIn(doc: WorkbookDoc): { workspace: QueryWorkspace; widgets: number }[]` in `import.ts`.

**Decision (planner's call, see the note in the hand-off):** the "confirm before running" the owner chose is the existing import review. `ImportReview` and the solution dialog already stand between a file and anything being saved or run, so they gain a **Workspaces** section listing each workspace with its widget count (as in `WorkbookConfirm.dc.html`), and Save / Install is the confirmation. A workspace the account can't see is still blocked at run time (Task 3).

- [ ] **Step 1: Write the failing tests**
  - `resolve.test.ts`: `the_timespan_parameter_keeps_a_widgets_workspace` (`{ timespan: 'P7D', scope: null, workspaces: [ws] }`); `ninety_days_suits_a_widget_with_a_workspace_only` (problem for the widget without one, none for the one with one).
  - `model.test.ts`: `isoTimespan('90d', 730) === 'P90D'`, `isoTimespan('90d') === null`.
  - `import.test.ts`: `workspaces_survive_import_with_only_three_fields` (an extra `token` field in the file is dropped); `workspacesIn_counts_widgets_per_workspace`.
  - `import-review.test.tsx`: `lists_the_workbooks_workspaces` ("This workbook queries 2 workspaces", each name with "2 widgets" / "1 widget"); no section when there are none.
  - The solution dialog: the same section for a solution whose workbooks carry workspaces.
- [ ] **Step 2: Run** `cd web && npx vitest run src/workbooks src/solutions`. Expected: FAIL.
- [ ] **Step 3: Implement.** `widgetRunOptions` replaces only `timespan` and keeps the widget's `workspaces`; the cap per widget is 730 days with a workspace, else 30. The widget editor shows `WorkspacePicker` for hunting widgets. `import.ts` copies `workspaces` keeping only `customerId`, `name`, `resourceId` (strings). The review sections render from `workspacesIn`.
- [ ] **Step 4: Run** tests, lint, typecheck. Expected: PASS, clean.
- [ ] **Step 5: Commit** — `feat: workspaces in workbooks and their import reviews`

### Task 7: Docs and changelog

**Files:**
- Modify: `README.md` (Features: hunting can target a workspace), `docs/EntraPermissions.md` and `docs/LicensesAndPermissions.md` (Microsoft Sentinel Reader on the workspace; Resource Graph's permission lists workspaces), `docs/workbooks.md` (a widget's workspace; the import review lists workspaces), `CHANGELOG.md` (Unreleased), `docs/design/mockups/WorkbookConfirm.dc.html` (redrawn as the import review's Workspaces section, per Task 6's decision)

- [ ] **Step 1:** Write the doc changes; each names the "Primary workspace" default and the fallback note.
- [ ] **Step 2:** `dotnet build -warnaserror && dotnet test` and `cd web && npm run lint && npm run typecheck && npm test`. Expected: all pass, no warnings.
- [ ] **Step 3: Commit** — `docs: hunting workspaces`
