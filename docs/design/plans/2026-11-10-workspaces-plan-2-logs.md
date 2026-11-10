# Workspaces, part 2: the Log Analytics source — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A fourth query source, `logs` ("Log Analytics"), runs KQL on a Log Analytics workspace that the user picks through the
Azure Monitor Logs query API v1. It works in tabs, saved queries, history, Recent and workbook widgets, with completion from
the workspace's own tables.

**Architecture:** A new token audience (`Audience.LogAnalytics`) and an HTTP client that sends that token only to
`api.loganalytics.azure.com`. `LogsClient` posts the query and `LogsQuerySource` (`Name => "logs"`) checks the workspace
against the account's list first. Part 1's check moves into a shared helper so that hunting and logs block the same way.
`LogsSchemaSource` reads `/metadata` per account and workspace. On the web side, `'logs'` joins `Source`, reuses part 1's
`WorkspacePicker` (with no "Primary workspace" entry) and `TimespanPicker`, and the schema store keys the logs schema by
workspace.

**Tech Stack:** .NET (xUnit), React + TypeScript + Zustand (Vitest), oxlint, Prettier.

**Spec:** `docs/design/specs/2026-11-10-workspaces-design.md`, part 2 plus "Shared" and the owner decisions. Mockup:
`docs/design/mockups/LogAnalytics.dc.html`. Part 1 is merged (FrodeHus/kustodian#125, #126): `QueryWorkspace`,
`QueryOptions.Workspaces`, `ArmDirectory.WorkspacesAsync`, `arm.workspaces`, `WorkspacePicker`, `RunOutcome.WorkspaceUnavailable`
and the import review's Workspaces section already exist.

## Global Constraints

- Stable API only: `POST https://api.loganalytics.azure.com/v1/workspaces/{customerId}/query`, body `{"query","timespan"}`,
  and `GET …/v1/workspaces/{customerId}/metadata`. No `beta`, no batch, no `/search`.
- Token scope `https://api.loganalytics.io/.default`. The token goes **only** to `https` + host `api.loganalytics.azure.com`.
  Every other host gets no `Authorization` header, and the client follows no redirects.
- Never send a query to a workspace the user didn't pick: a `logs` run with no workspace is a `QueryError` with
  `"Pick a workspace before running."`, and no request is made.
- A workspace not in the account's `arm.workspaces` list blocks the run (`WorkspaceUnavailable`, copy
  `"{name} isn't available to this account. Pick a workspace."`). An unreadable list blocks it with the list's own message.
- Timespan: presets 1, 7, 30 and 90 days, custom up to 730 days. A new `logs` tab starts at `P1D`.
- `Prefer: wait=600` on every query request (10 minutes). The client timeout is 11 minutes.
- Response cap 64 MB (`LogsClient.MaxResponseBytes`), the Logs API's own limit. Over it: `RunOutcome.TooLarge`, with
  `"The result is over Log Analytics' 64 MB limit. Add summarize, project or take."`
- Permission: Log Analytics API (app ID `ca7f3f0b-7d91-482c-8e09-c5d840d0eac5`), delegated `Data.Read`, no admin consent.
  The planner subgroup is "Log Analytics", and the tables it covers are "Log Analytics tabs". Data access is Azure RBAC on the
  workspace (Reader or Log Analytics Reader).
- Consent copy for `logs`: `"Kustodian needs your permission to read Log Analytics for this account."` The button says
  "Grant Log Analytics access".
- Solutions never carry a workspace (decision 4). `SolutionRules` accepts `logs`, and the host's existing strip covers it.
- Warnings are fixed, never suppressed (CLAUDE.md): `dotnet build -warnaserror`, `npm run lint` (only the 3 known
  warnings), `npm run typecheck` and `npx prettier --check` must pass.
- Work in the worktree `.worktrees/logs-source` on `feat/logs-source`, cut from `main`.

## Review Focus

1. **A token that leaks:** a `nextLink`, a redirect or an absolute URI on another host must never carry the Logs token, and an
   `http://` URI to the right host must not either. Test in Task 1.
2. **A partial failure:** a 200 with both `tables` and `error` is a successful run plus a warning diagnostic that quotes the
   error, never a silent success and never a failure. Test in Task 2.
3. **A workspace from another tenant after an account switch:** a `logs` tab saved under account A and run as account B is
   blocked, and the request never reaches the Logs API. Test in Task 3.
4. **A schema for the wrong workspace:** switching the workspace while its `/metadata` read is in flight must not leave the
   old workspace's tables in completion. Test in Task 6.
5. **An Azure CLI or Graph CLI account:** a Logs token that needs consent ends as `consentNeeded` with audience `logs`, and
   granting it asks for the Logs scope, not ARM's. Tests in Tasks 1 and 5.

---

### Task 1: Log Analytics tokens and the HTTP client

**Files:**
- Modify: `src/Kustodian/Auth/ClientConfig.cs` (`Audience.LogAnalytics`, `ScopeFor`), `src/Kustodian/Auth/AccountService.cs`
  (`GetTokenAsync`'s ARM-only catches and `ConfigFor` cover `LogAnalytics` too), `src/Kustodian.Graph/Run/ConsentRequiredException.cs`
  (message per audience), `src/Kustodian/Bridge/Handlers/AccountHandler.cs` (`"logs" => Audience.LogAnalytics` in
  `account.consent` and `account.refresh`), `src/Kustodian/Auth/EntraApp/SourcePermissions.cs`,
  `src/Kustodian/Auth/EntraApp/PermissionPlanner.cs` (a "Log Analytics" subgroup in the `azure` group, after Resource Graph)
- Create: `src/Kustodian/Auth/LogsAuthHandler.cs` (modelled on `ArmAuthHandler`), `src/Kustodian/App/LogsHttp.cs` (modelled on
  `ArmHttp`), `src/Kustodian.Sources/Logs/LogAnalytics.cs` (`public static class LogAnalytics { public const string Host = "api.loganalytics.azure.com"; }`, as `Arm.Host` is)
- Test: `tests/Kustodian.Tests/Auth/` (beside the `ArmAuthHandler` and `AccountService` tests), the planner tests

**Interfaces:**
- Produces: `Audience.LogAnalytics`; `ConsentRequiredException.LogsMessage` and `new ConsentRequiredException("logs", inner)`;
  `LogsHttp.CreateClient(ITokenSource tokens, ILogger<LogsAuthHandler>? logger = null, ErrorTrail? trail = null)` with
  `BaseAddress = https://api.loganalytics.azure.com/`; `SourcePermissions.LogAnalytics`, with
  `SourcePermissions.LogAnalyticsAppId = "ca7f3f0b-7d91-482c-8e09-c5d840d0eac5"`.

- [ ] **Step 1: Write the failing tests**
  - `Logs_scope`: `Audience.LogAnalytics.ScopeFor() == "https://api.loganalytics.io/.default"`.
  - `Logs_token_only_to_the_logs_host`: a request to `https://api.loganalytics.azure.com/v1/…` gets a bearer token for the request's
    account. `https://management.azure.com/…`, `https://api.loganalytics.io/…`, `http://api.loganalytics.azure.com/…` and
    `https://evil.example/…` get no `Authorization` header (and a header set beforehand is removed).
  - `Logs_request_without_account_throws_SignInRequired`.
  - `GraphCli_account_gets_logs_tokens_from_the_Azure_CLI_client` (same rule as ARM in `ConfigFor`).
  - `Logs_ui_required_is_consent_for_logs`: a `MsalUiRequiredException` classified as consent → `ConsentRequiredException` with
    `Audience == "logs"` and the logs message. Any other ui-required → `SignInRequiredException`, and the Graph sign-in isn't
    marked expired (as for ARM).
  - `Consent_and_refresh_accept_logs`: `account.consent {audience:"logs"}` calls `ConsentAsync(key, Audience.LogAnalytics, …)`.
    An unknown audience's message now names `arm, graph or logs`.
  - `Planner_lists_Log_Analytics`: the `azure` group has subgroups `["Resource Graph", "Log Analytics"]`, and the second has
    one permission: app ID `ca7f…eac5`, scope `Data.Read`, `AdminConsent == false`.
- [ ] **Step 2: Run** `dotnet test tests/Kustodian.Tests --filter "FullyQualifiedName~Auth|FullyQualifiedName~Planner"`. Expected: build errors.
- [ ] **Step 3: Implement.** In `AccountService`, replace each `audience == Audience.Arm` test that guards the
  consent and sign-in catches and `ConfigFor` with "not Graph" (`audience != Audience.Graph`), and pass
  `audience == Audience.Arm ? "arm" : "logs"` to `ConsentRequiredException`. `ConsentRequiredException(string audience, …)` picks
  `ArmMessage` or `LogsMessage` from the audience. `LogsAuthHandler` writes `token.acquire(logs)` to the trail.
- [ ] **Step 4: Run** the tests and `dotnet build -warnaserror`. Expected: PASS, 0 warnings.
- [ ] **Step 5: Commit** — `feat: Log Analytics tokens, sent only to api.loganalytics.azure.com`

### Task 2: `LogsClient`

**Files:**
- Create: `src/Kustodian.Sources/Logs/LogsClient.cs`, plus fixtures `tests/Kustodian.Sources.Tests/Fixtures/logs-*.json` (hand-written
  from the API reference, and labelled so in a comment in the test)
- Test: `tests/Kustodian.Sources.Tests/Logs/LogsClientTests.cs`

**Interfaces:**
- Consumes: `LogAnalytics.Host` (Task 1), `BodyReader`, `ServerRows.NormalizeType`, `GraphRequestAccount` (`ForAccount`, `ForRun`,
  `RecordBytes`), `RetryAfter`, `HuntingClient.Position`. That last one moves to `Kustodian.Sources.KustoPosition.Of(string message)`
  and both clients call it.
- Produces: `public sealed record LogsAnswer(RunOutcome Outcome, string? Message, IReadOnlyList<EngineColumn> Columns, IReadOnlyList<JsonElement[]> Rows, int? Line = null, int? Column = null, string? PartialError = null)`;
  `LogsClient(HttpClient logs, TimeProvider? time = null)`;
  `Task<LogsAnswer> RunAsync(string accountKey, string customerId, string kql, string timespan, RunDiagnostics d, CancellationToken ct)`;
  the constants `MaxResponseBytes = 64L * 1024 * 1024`, `Timeout = 11 min`, `TooLarge` and `Permission = "Data.Read"`.

- [ ] **Step 1: Write the failing tests** (a stub `HttpMessageHandler` records the request)
  - `Posts_query_and_timespan_to_the_workspace`: URI `https://api.loganalytics.azure.com/v1/workspaces/<guid>/query`, body
    exactly `{"query":"T","timespan":"P1D"}`, header `Prefer: wait=600`. The customer ID is escaped into the path, and a value
    with `/` or `..` never reaches the request (the `QueryOptions.Problem` GUID check runs first; assert the client also refuses
    a non-GUID with `RunOutcome.Failed`).
  - `Reads_the_first_table`: `{"tables":[{"name":"PrimaryResult","columns":[{"name":"TimeGenerated","type":"datetime"},{"name":"Count","type":"long"}],"rows":[["2026-11-10T00:00:00Z",3]]}]}`
    gives columns `TimeGenerated:datetime` and `Count:long`, and one row.
  - `A_200_with_an_error_is_ok_with_PartialError`: `tables` plus `"error":{"code":"PartialError","message":"Query result exceeded…"}`
    → `Ok`, the rows, and `PartialError` = the error's message.
  - `A_204_is_empty`: → `Ok`, with no columns and no rows.
  - `A_400_names_the_position`: `{"error":{"code":"BadArgumentError","message":"The request had some invalid properties","innererror":{"code":"SyntaxError","message":"A recognition error occurred in the query.","innererror":{"code":"SYN0002","message":"Query could not be parsed at 'x' on line [2,5]","line":2,"pos":4}}}}`
    → `QueryError`, with the deepest inner message, `Line 2` and `Column 5`. Read numeric `line` and `pos` from the innermost
    `innererror` that has them (`pos` is 0-based); else fall back to `KustoPosition.Of(message)`.
  - `A_403_InsufficientAccessError_is_NoPermission`: the message is `"Log Analytics refused the query. You need Reader or Log Analytics Reader on the workspace, and the Data.Read permission."`
  - `A_403_InvalidAuthenticationToken_throws_SignInRequired` (and a 401 likewise).
  - `A_429_is_Throttled_with_Retry_After` (as hunting does, with a `Throttled` diagnostic).
  - `A_504_says_the_query_took_too_long`: → `Failed`, `"Log Analytics stopped the query after 10 minutes. Narrow the query or the timespan and try again."`
  - `Over_64_MB_is_TooLarge`.
  - `A_timeout_and_a_lost_connection_are_Failed`, and `Cancelling_throws` (the same three paths as `HuntingClient`).
- [ ] **Step 2: Run** `dotnet test tests/Kustodian.Sources.Tests --filter FullyQualifiedName~Logs`. Expected: build errors.
- [ ] **Step 3: Implement** in the shape of `HuntingClient`: the same timeout, `BodyReader` and catch blocks. Rows come from
  the table named `PrimaryResult`, else the first table. Each row is the array's elements, cloned, padded with JSON `null`
  to the column count.
- [ ] **Step 4: Run** the tests, the existing `Hunting` tests (for the `KustoPosition` move) and `dotnet build -warnaserror`.
  Expected: PASS.
- [ ] **Step 5: Commit** — `feat: LogsClient for the Azure Monitor Logs query API`

### Task 3: The `logs` source, wired into the host

**Files:**
- Create: `src/Kustodian.Sources/WorkspaceCheck.cs`, `src/Kustodian.Sources/Logs/LogsQuerySource.cs`
- Modify: `src/Kustodian.Sources/Hunting/HuntingQuerySource.cs` (uses `WorkspaceCheck`; behaviour unchanged),
  `src/Kustodian/App/AppServices.cs` (a `LogsHttp` client and the source), `src/Kustodian/Bridge/Handlers/HistoryHandler.cs:13`,
  `src/Kustodian/Solutions/SolutionRules.cs:11,58` (`"Source '{source}' must be graph, hunting, arg or logs."`),
  `src/Kustodian/Snippets/builtin-snippets.json` (one or two `logs` snippets, if the file has a snippet per source), and
  `src/Kustodian/Bridge/Handlers/QueryHandler.cs:155` (a `consentNeeded` result carries the exception's audience)
- Modify: `src/Kustodian.Graph/Run/RunResult.cs` (`public string? ConsentAudience { get; init; }`, written only when set)
- Test: `tests/Kustodian.Sources.Tests/Logs/LogsQuerySourceTests.cs`, the existing `HuntingQuerySourceTests` (unchanged, still
  green), the history and solution-rule tests

**Interfaces:**
- Consumes: `LogsClient` (Task 2), `ArmDirectory.WorkspacesAsync`.
- Produces: `public static class WorkspaceCheck { Task<(ArmWorkspace? Match, string? Blocked)> RunAsync(ArmDirectory directory, string accountKey, QueryWorkspace workspace, CancellationToken ct); string ShortId(string id); }`,
  where `Blocked` is the copy in Global Constraints (with the short ID when the name is empty), or the `ArmDirectoryException`'s
  message. `LogsQuerySource(LogsClient client, ArmDirectory directory, TimeProvider time, ILogger<LogsQuerySource>? logger = null)`
  with `DefaultTimespan = "P1D"`. Wire: `RunResult.consentAudience: 'arm' | 'logs'`.

- [ ] **Step 1: Write the failing tests**
  - `No_workspace_is_a_query_error`: → `QueryError` `"Pick a workspace before running."`. Neither the client nor `ArmDirectory`
    is called.
  - `A_workspace_the_account_cant_see_is_not_run`, `Another_accounts_workspace_is_not_run`, `An_unreadable_list_blocks_the_run`:
    as part 1's hunting tests, with the client never called.
  - `Runs_on_the_workspace_with_the_timespan`: the client gets the customer ID and the options' timespan, or `P1D` without one.
    Progress says `"Running the query in Log Analytics on {account's name}"`, then `"Log Analytics answered"`.
  - `A_partial_error_is_a_warning`: `PartialError` → `Ok`, plus a `DiagnosticKinds.Warning` entry
    `"Log Analytics returned part of the result: {error}"`.
  - `A_query_error_position_maps_back` through `ParameterSubstitution.MapBack` (as hunting).
  - `NoPermission_lists_Data_Read`: `Permissions == ["Data.Read"]`.
  - `Consent_for_logs_propagates`: a `ConsentRequiredException("logs")` from the client is thrown. In `QueryHandler`, a run
    ending that way answers `consentNeeded` with `consentAudience: "logs"`, and an ARM one answers `"arm"`.
  - `History_and_solutions_accept_logs`.
- [ ] **Step 2: Run** `dotnet test tests/Kustodian.Sources.Tests tests/Kustodian.Tests`. Expected: build errors.
- [ ] **Step 3: Implement.** `LogsQuerySource` is `HuntingQuerySource` without the fallback note and the `TenantId` warning.
  Add `RunResult.ConsentAudience` to the TS `RunResult` in `web/src/wire.ts`.
- [ ] **Step 4: Run** both test projects and `dotnet build -warnaserror`. Expected: PASS.
- [ ] **Step 5: Commit** — `feat: the logs source runs on a picked workspace`

### Task 4: The Log Analytics schema

**Files:**
- Create: `src/Kustodian.Sources/Logs/LogsSchemaSource.cs`
- Modify: `src/Kustodian/Bridge/Handlers/SchemaHandler.cs` (`"logs"`; `SchemaParams` gains `string? Workspace`, a customer ID),
  `src/Kustodian/App/AppServices.cs`, and the account sign-out path that calls `HuntingSchemaSource.RemoveAccount`
- Test: `tests/Kustodian.Sources.Tests/Logs/LogsSchemaSourceTests.cs`, the `SchemaHandler` tests

**Interfaces:**
- Produces: `LogsSchemaSource(HttpClient logs, TimeProvider time)`;
  `Task<HuntingSchemaView> GetAsync(string accountKey, string customerId, bool refresh, CancellationToken ct)` (it reuses the hunting
  view records: tables, columns, functions); `RemoveAccount(string accountKey)`. The `schema.get {source:"logs", workspace}` answer
  is a `SchemaView` with `Source = "logs"`.

- [ ] **Step 1: Write the failing tests**
  - `Reads_tables_columns_and_functions`: `/metadata` `{"tables":[{"name":"SigninLogs","description":"…","columns":[{"name":"TimeGenerated","type":"datetime"}]}],"functions":[{"name":"MyFn","body":"…","parameters":"x:string"}]}`
    gives one table and one function with parameter `x:string`. A function whose `parameters` is empty has none.
  - `Cached_24_hours_per_account_and_workspace`: a second `GetAsync` for the same pair makes no request, and another workspace
    makes one.
  - `A_failure_keeps_the_last_good_schema` with a `FallbackReason`. With none read before, it's a view with **no tables**,
    origin `tenant`, and `FallbackReason` = the failure's message (there's no bundled fallback). Either way, no new read for
    10 minutes.
  - `Consent_propagates` (as `HuntingSchemaSource`).
  - `schema.get_logs_without_workspace` → `bad_request` `"Pick a workspace to see its tables."`
- [ ] **Step 2: Run** the filter `FullyQualifiedName~LogsSchema|FullyQualifiedName~SchemaHandler`. Expected: build errors.
- [ ] **Step 3: Implement** in the shape of `HuntingSchemaSource`: the same timeout, cache and retry rules, keyed by
  `"{accountKey}|{customerId lowercased}"`. Cap the body at 20 MB.
- [ ] **Step 4: Run** the tests and `dotnet build -warnaserror`. Expected: PASS.
- [ ] **Step 5: Commit** — `feat: Log Analytics schema per workspace`

### Task 5: `logs` tabs in the web app

**Files:**
- Modify: `web/src/wire.ts` (`Source` gains `'logs'`), `web/src/tabs/sources.ts` (`logs: { badge: 'LA', className: 'logs', name: 'Log Analytics' }`),
  `web/src/styles.css` (`.logs` in the theme's green-teal, matching `.src.logs` in the mockups' `studio.css`), `web/src/tabs/tab-store.ts`
  (a new `logs` tab gets `options: { timespan: 'P1D', workspaces: <remembered> }`), `web/src/tabs/tab-strip.tsx` and the command
  palette in `web/src/app.tsx` ("New Log Analytics query"), `web/src/app.tsx` (the toolbar shows `WorkspacePicker` and
  `TimespanPicker maxDays={730}` on `logs` tabs; Run is disabled without a workspace, with the title "Pick a workspace before running."),
  `web/src/toolbar/workspace-picker.tsx` (`primaryLabel={null}` hides the no-workspace entry),
  `web/src/results/run-status.tsx` (the consent button follows `result.consentAudience`, and the refresh-token audience is `'logs'` for
  `logs` runs), `web/src/signin/consent-button.tsx` (prop `audience: 'arm' | 'logs'`, label "Grant Log Analytics access" for logs),
  `web/src/results/source-wording.ts`, `web/src/results/diagnostics-view.tsx`, `web/src/solutions/solutions-panel.tsx`, `web/src/bridge.mock.ts`
  (a `logs` source answering canned rows on the mock's workspaces), and whatever else `grep -rln "'arg'" web/src` lists that
  switches over sources
- Test: `tab-store.test.ts`, `workspace-picker.test.tsx`, `run-status.test.tsx`, `consent-button.test.tsx`, the `source-wording` tests

**Interfaces:**
- Consumes: `consentAudience` (Task 3), `account.consent {audience:"logs"}` (Task 1).
- Produces: `rememberedLogsWorkspace(accountKey): QueryWorkspace[] | null` and `rememberLogsWorkspace(accountKey, workspaces)` in
  `web/src/toolbar/workspace-memory.ts`. They use `localStorage` key `kustodian.logsWorkspace.<accountKey>`, every access in
  try/catch, and a bad value reads as null (a per-viewer convenience: a lost value only means picking again).

- [ ] **Step 1: Write the failing tests**
  - `a new logs tab starts at P1D with the remembered workspace` (and with none remembered: `workspaces: null`). A new hunting
    tab still starts at "Primary workspace".
  - `picking a workspace on a logs tab remembers it for the account` (a different account remembers its own).
  - `the logs picker has no Primary workspace entry`.
  - `Run on a logs tab without a workspace is disabled and says why`.
  - `consentNeeded with consentAudience logs offers Grant Log Analytics access`, which calls `account.consent` with `audience: 'logs'`.
    An ARG run keeps "Grant Azure access".
  - `logs wording`: running `"Running the query in Log Analytics on contoso-logs"`, and the source name "Log Analytics".
  - `bridge.mock` runs a `logs` query (the mock's own test, if there is one).
- [ ] **Step 2: Run** `cd web && npx vitest run`. Expected: failures.
- [ ] **Step 3: Implement.** Adding `'logs'` to `Source` makes `tsc` list every `Record<Source, …>` and exhaustive switch: fill
  each one in, never with a cast.
- [ ] **Step 4: Run** `npx vitest run`, `npm run typecheck`, `npm run lint` and `npx prettier --check .`. Expected: PASS, with
  only the 3 known warnings.
- [ ] **Step 5: Commit** — `feat: Log Analytics tabs`

### Task 6: Completion and the schema panel per workspace

**Files:**
- Modify: `web/src/schema/schema-store.ts` (a `logs` schema keyed by customer ID: `logsByWorkspace: Record<string, SchemaView>`,
  `loadLogs(customerId, opts?)`, with its own request counter per workspace), `web/src/schema/schema-panel.tsx` (the panel for a
  `logs` tab shows the tab's workspace's tables; with no workspace: "Pick a workspace to see its tables."; with an empty schema
  and a `fallbackReason`: that reason, and completion is off), `web/src/editor/kusto-schema.ts` (`logs` uses the workspace's
  view), `web/src/app.tsx` (the status-bar line `"Tables from {name} · {date}"`)
- Test: `schema-store.test.ts`, `schema-panel.test.tsx`

- [ ] **Step 1: Write the failing tests**
  - `changing a logs tab's workspace loads that workspace's schema` (`schema.get {source:'logs', workspace}`).
  - `an answer for a workspace the tab has left doesn't replace the current one` (Review Focus 4: the A read resolves after the
    switch to B → B's tables are shown and completed).
  - `the panel says pick a workspace without one`; `the panel shows the reason when the schema couldn't be read`.
  - `reset on account change clears logsByWorkspace`.
- [ ] **Step 2–4:** run them failing, implement, then run `npx vitest run`, `npm run typecheck`, `npm run lint` and Prettier.
- [ ] **Step 5: Commit** — `feat: completion from the picked workspace's tables`

### Task 7: Workbooks, docs and changelog

**Files:**
- Modify: `web/src/workbooks/widget-editor.tsx` (the workspace and timespan pickers for `logs` widgets, with no Primary entry),
  `web/src/workbooks/model.ts` (the timespan cap is 730 days for `logs`), `web/src/workbooks/resolve.ts`, `web/src/workbooks/import.ts`
  (`logs` is a known source; workspaces kept, and the review already lists them), `web/src/workbooks/widget-frame.tsx` (a `logs`
  widget with no workspace shows "Pick a workspace" with the editor button, as a blocked widget does)
- Modify: `README.md` (four sources), `docs/EntraPermissions.md` and `docs/LicensesAndPermissions.md` (the Log Analytics API
  `Data.Read` permission, workspace RBAC, Azure CLI and Graph CLI accounts, and the consent button), `docs/workbooks.md` (`logs` in the
  source list), `CHANGELOG.md` (an **Added** entry under Unreleased, wrapped at ~125 characters like its neighbours)
- Test: `widget-editor.test.tsx`, `model.test.ts`, `import.test.ts`, `widget-frame.test.tsx`

- [ ] **Step 1: Write the failing tests**
  - `a logs widget's editor shows the workspace picker without Primary workspace`.
  - `a 90-day workbook timespan is fine for a logs widget`, and 800 days is a problem.
  - `an imported workbook keeps a logs widget's workspace` and lists it in the review.
  - `a logs widget with no workspace asks for one and doesn't run`.
- [ ] **Step 2–4:** run them failing, implement, write the docs, then run the full verification below.
- [ ] **Step 5: Commit** — `feat: Log Analytics widgets in workbooks` and `docs: the Log Analytics source`

## Verification (every task's last run; all of it after Task 7)

- `dotnet build -warnaserror`, `dotnet test tests/Kustodian.Sources.Tests`, `dotnet test tests/Kustodian.Tests`
- in `web/`: `npx vitest run`, `npm run typecheck`, `npm run lint` (only the 3 known warnings), `npx prettier --check .`

## Left open for the owner (not blocking)

- The Log Analytics API's app ID is from memory (`ca7f3f0b-7d91-482c-8e09-c5d840d0eac5`), and Microsoft Learn's permission
  page doesn't print it. Check it once with `az ad sp show --id ca7f3f0b-7d91-482c-8e09-c5d840d0eac5 --query displayName`
  (expect "Log Analytics API") before merging.
- Whether the Azure CLI public client gets a `api.loganalytics.io` token without consent can only be seen against a real
  tenant. If it can't, the consent button covers it.
