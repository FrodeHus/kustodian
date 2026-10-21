# Kustodian Plan 3: Defender Hunting and Azure Resource Graph Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** add two server-side KQL sources next to Microsoft Graph:

- **Defender advanced hunting**, through Graph `security/runHuntingQuery`.
- **Azure Resource Graph**, through ARM.

Each source gets its own:

- tabs and badge;
- schema and completion;
- toolbar control: a timespan picker for hunting, a scope picker for Resource Graph.

They share the results, saved queries, recent runs, the session, snippets, parameters and diagnostics.

**Architecture:**

- **Host dispatch.** The host's `QueryHandler` dispatches `query.run` to an `IQuerySource` by source name. Graph keeps its own runner, and hunting and Resource Graph get new runners in a new `Kustodian.Sources` project.
- **Query options.** Each run carries `QueryOptions`: a hunting timespan or a Resource Graph scope. Tabs, saved queries, recent runs and the session store the same options.
- **ARM calls.** These use a second `HttpClient` with its own auth handler, pinned to `management.azure.com`.
- **ARM consent.** A first request that needs consent is a distinct outcome (`consentNeeded`) with a "Grant Azure access" button. It never marks the account expired.
- **Web.** The web keeps one schema per source and loads each one lazily.

**Tech Stack:** the Plan 1 and Plan 2 stack. No new runtime dependencies.

**Spec:** `kustodian/docs/superpowers/specs/2026-10-21-kustodian-design.md`, section 8, plus sections 6.1, 6.4, 6.6, 6.7, 9, 12 and 14 (risk 1). Mockups: `kustodian/docs/mockups/Hunting.dc.html` and `ResourceGraph.dc.html`.

**Builds on** Plan 2 (FrodeHus/rightsecurity-insights#194). Interfaces named below exist on that branch.

## Global Constraints

- **Plans 1 and 2 still apply.** Everything stays under `kustodian/`.
  - No suppressions. The only open warnings are the two in `kustodian/CLAUDE.md`.
  - Tokens are never logged, persisted or sent to a non-Microsoft host.
  - No browser storage, no network calls from the UI, and every action is a command.
- **User-data files.** Missing fields take their defaults at every level and per array element (Plan 2 rulings 6 and 7). A new nested field is null when absent.
- **Hunting endpoint.** Use only `POST https://graph.microsoft.com/v1.0/security/runHuntingQuery`, with body `{ "Query", "Timespan" }`. Never call the retired `api.security.microsoft.com` endpoints.
- **Hunting schema.** `GET https://graph.microsoft.com/beta/security/getHuntingSchema` is cached per account for 24 hours. Fall back to the bundled schema copied from the portal's `src/Insights.Defender/Hunting/hunting-schema.json` (66 tables and 4 functions; the owner allows the copy).
- **Resource Graph endpoint.** `POST https://management.azure.com/providers/Microsoft.ResourceGraph/resources?api-version=2024-04-01`.
  - Options: `$top` 1,000, `$skipToken` paging, `resultFormat: objectArray`.
  - Follow pages up to `ArgRowsPerRun`: default 50,000, range 1,000–1,000,000 (spec 9).
- **ARM tokens.**
  - Audience `https://management.azure.com/.default`.
  - Requested only when an ARG tab first needs one (spec 6.7).
  - The ARM auth handler attaches tokens only for https `management.azure.com`.
  - Redirects are off.
- **Explain stays Graph-only.** `query.explain` and `query.complete` for other sources answer `bad_request` with "Explain is only available for Microsoft Graph." or "Completion comes from the editor for this source." respectively. The editor never calls them for those sources.
- **Errors land on the tab** (spec 12), as exact copy:
  - **Hunting 403:** "Advanced hunting needs the ThreatHunting.Read.All permission and a Defender role (for example Security Reader). With the Azure CLI client this permission may not be available: use your own app registration."
  - **ARG 403:** "You don't have access to Azure Resource Graph in this scope."
  - **Throttled (429):** show the body's explanation and when to retry.
  - **Error text** is cleaned of HTML (`GraphErrorText.Summarize`).

## Review Focus

1. **The first ARG run for an account that has never consented to ARM.** The tab shows "Grant Azure access". The Graph sign-in stays valid, so Graph tabs keep running. Granting consent and rerunning works.
   Test: Task 2, `Arm_consent_needed_does_not_expire_the_account`.
2. **A hunting or ARG query with parameters.** It is substituted with the same safe literals as Graph, and server error positions map back to the text as written.
   Test: Task 3, `Hunting_error_position_maps_back_through_parameters`. Task 4, `Arg_error_position_maps_back_through_parameters`.
3. **ARG over many pages.** It stops at `ArgRowsPerRun` with `total` reporting the real count. Throttling headers are honoured. A `$skipToken` loop can't run forever.
   Test: Task 4, `Arg_stops_at_rows_limit_and_reports_total` and `Arg_skip_token_repeating_is_refused`.
4. **Switching tabs between sources.** The editor's schema and completion follow the active tab. Graph-only completion (nested fields) never fires on hunting or ARG tabs.
   Test: Task 6, `editor_switches_schema_with_the_active_tab_source`.
5. **A saved query, recent run or restored session tab of each source.** It reopens with its timespan or scope. A file written before Plan 3 (no options) loads with `options: null`, and the source's defaults apply: P30D, "all I can see".
   Test: Task 1, `Old_files_without_options_load_with_null_options`. Task 7, `restored_arg_tab_keeps_its_scope`.

---

## File structure

```
kustodian/src/Kustodian.Graph/
  Run/QueryOptions.cs            QueryOptions, ArgScope (shared records)
  Run/RunResult.cs               RunOutcome gains ConsentNeeded
kustodian/src/Kustodian.Sources/            (new project; references Kustodian.Graph)
  IQuerySource.cs                IQuerySource, QueryRunRequest
  ServerRows.cs                  object rows → positional rows + columns, type normalisation
  Hunting/HuntingClient.cs  Hunting/HuntingSchemaSource.cs  Hunting/HuntingQuerySource.cs
  Hunting/hunting-schema.json    (embedded, copied from the portal)
  Arg/ArgClient.cs  Arg/ArgQuerySource.cs  Arg/ArmDirectory.cs  Arg/arg-schema.json (embedded)
kustodian/src/Kustodian/
  Auth/ArmAuthHandler.cs  Auth/ConsentRequiredException.cs (in Kustodian.Graph.Run for the runner)
  App/ArmHttp.cs  App/GraphQuerySource.cs
  Bridge/Handlers/QueryHandler.cs (dispatch)  SchemaHandler.cs (per source)  ArmHandler.cs  AccountHandler.cs (consent)
  Snippets/builtin-snippets.json (hunting + ARG entries)
kustodian/web/src/
  schema/schema-store.ts  editor/kusto-schema.ts (per source)  toolbar/timespan-picker.tsx  toolbar/scope-picker.tsx
```

---

### Task 1: Source dispatch and query options

**Files:**
- Create: `src/Kustodian.Graph/Run/QueryOptions.cs`, `src/Kustodian.Sources/` (csproj, `IQuerySource.cs`, `ServerRows.cs`) and `src/Kustodian/App/GraphQuerySource.cs`.
- Modify:
  - `QueryHandler.cs`: dispatch by source; `RunParams` gains `Options`.
  - `RecentService.cs`, `LibraryService.cs` and `SessionService.cs`: an `Options` field, plus `LibraryService.ToInput`.
  - `AppServices.cs`.
  - `web/src/wire.ts`: types only.
  - `bridge.mock.ts`.
- Test: `tests/Kustodian.Tests/Bridge/SourceDispatchTests.cs`, plus additions to the Recent, Library and Session tests.

**Interfaces:**
- Produces:
  - Records:
    - `record ArgScope(string Kind, IReadOnlyList<string> Ids)`. `Kind` is `"subscriptions" | "managementGroup" | "all"`. Ids are subscription GUIDs, or one management-group name. Ids are empty for `"all"`.
    - `record QueryOptions(string? Timespan, ArgScope? Scope)`. `Timespan` is an ISO 8601 duration (`P1D`, `P7D`, `P30D`) or an interval `start/end`.
    - Validation:
      - a timespan must parse and cover no more than 30 days;
      - ids must be GUIDs for subscriptions, or `^[A-Za-z0-9_.()-]{1,90}$` for a management group;
      - at most 100 subscriptions.
  - `record QueryRunRequest(string AccountKey, string Kql, IReadOnlyList<ParameterValue> Parameters, bool Refresh, string? RunId, QueryOptions? Options)`.
  - `interface IQuerySource { string Name { get; } Task<RunResult> RunAsync(QueryRunRequest request, IProgress<RunEvent>? progress, CancellationToken ct); }`.
  - `GraphQuerySource(GraphRunner) : IQuerySource` is named `"graph"` and ignores `Options`.
  - `QueryHandler`:
    - takes `IReadOnlyDictionary<string, IQuerySource> sources` in place of the `GraphRun` delegate;
    - `query.run` with an unknown source answers `bad_request` "Unknown source {source}.";
    - `query.explain` and `query.complete` stay Graph-only, with the messages in Global Constraints.
  - `RecentRun`, `SavedQuery`, `SavedQueryInput` and `SessionTab` gain `QueryOptions? Options = null`, carried through every copy and the web types.
  - `ServerRows.Shape(IEnumerable<JsonElement> objectRows, IReadOnlyList<EngineColumn>? declared)` returns `(IReadOnlyList<EngineColumn> Columns, IReadOnlyList<JsonElement[]> Rows)`.
    - Declared columns win.
    - Otherwise columns are the union of keys in order of first appearance, with types inferred: `long`, `real`, `bool`, `datetime` for ISO strings with a zone, `dynamic` for objects and arrays, otherwise `string`.
    - `NormalizeType(string)` maps `int64→long`, `int32→int`, `double|single→real`, `boolean→bool`, `object|array→dynamic`, `integer→long`, `number→real`, and empty to `string`.

- [ ] **Step 1: Write the failing tests.**
  - `Run_dispatches_by_source`.
  - `Unknown_source_is_bad_request`.
  - `Explain_for_hunting_is_refused_with_copy`.
  - `Options_round_trip_through_recent_library_and_session`.
  - `Old_files_without_options_load_with_null_options` (one file each for recent, saved and session, written without `options`).
  - `Invalid_options_are_bad_request`: a 31-day timespan, a non-GUID subscription, 101 subscriptions.
  - `Shape_maps_object_rows_to_positional_by_declared_columns`.
  - `Shape_infers_columns_in_first_appearance_order`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** Existing Graph tests that construct `QueryHandler` move to a `sources` map.
- [ ] **Step 4: Run the full suite.** Expected: PASS, with 0 warnings.
- [ ] **Step 5: Commit.** `feat(kustodian): query sources by name and query options on runs, recent, saved and session`

### Task 2: ARM client, auth and consent

**Files:**
- Create: `src/Kustodian/Auth/ArmAuthHandler.cs`, `src/Kustodian/App/ArmHttp.cs` and `src/Kustodian.Graph/Run/ConsentRequiredException.cs`.
- Modify:
  - `AccountService.cs`: the ARM path; `ConsentAsync`.
  - `IMsalClient` / `MsalClient`: interactive acquire with a login hint for a given scope.
  - `RunResult.cs`: `RunOutcome.ConsentNeeded`.
  - `AccountHandler.cs`: `account.consent`.
  - `AppServices.cs`.
- Test: `tests/Kustodian.Tests/Auth/ArmAuthTests.cs`.

**Interfaces:**
- Produces:
  - `ConsentRequiredException(string audience)`, with `Message` "Kustodian needs your permission to read Azure resources for this account."
  - `AccountService.GetTokenAsync(accountKey, Audience.Arm, ct)`:
    - a silent failure with `MsalUiRequiredException` for `Arm` throws `ConsentRequiredException("arm")`;
    - it does not add the account to the expired set;
    - Graph behaviour is unchanged.
  - `AccountService.ConsentAsync(accountKey, Audience audience, ct)` does an interactive acquire for that audience's scope, with the account's username as login hint, in the system browser. Device code is the fallback when the interactive acquire isn't possible.
  - `ArmAuthHandler(ITokenSource) : DelegatingHandler`:
    - attaches a bearer token only for https `management.azure.com`;
    - reads the account from `GraphRequestAccount` and throws `SignInRequiredException` without one;
    - clears `Authorization` for any other host.
  - `ArmHttp.CreateClient(ITokenSource, ILogger?)`:
    - `BaseAddress https://management.azure.com/`;
    - chain: ArmAuthHandler → DiagnosticsHandler → `SocketsHttpHandler { AllowAutoRedirect = false }`.
    - It is disposed with `AppServices`.
  - `RunOutcome.ConsentNeeded` goes on the wire as `"consentNeeded"`. Update the web `RunOutcome`.
  - Bridge: `account.consent {key, audience: "arm"}` returns `{}`.

- [ ] **Step 1: Write the failing tests.**
  - `Arm_consent_needed_does_not_expire_the_account`: a fake MSAL throws ui-required for ARM only. A Graph token still works, and `ListAccountsAsync` shows the account not expired.
  - `Arm_handler_attaches_token_only_for_management_azure_com` (also checks the `management.azure.com.evil` suffix and http).
  - `Arm_client_does_not_follow_redirects`.
  - `Consent_acquires_arm_scope_with_login_hint`.
  - `Consent_needed_maps_to_run_outcome` (a runner test, through a stub source that throws).
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat(kustodian): ARM client and consent that never expires the Graph sign-in`

### Task 3: Defender advanced hunting source

**Files:**
- Create in `src/Kustodian.Sources/Hunting/`:
  - `HuntingClient.cs`, ported from the portal's `HuntingClients.cs`, `GraphHuntingClient` only.
  - `HuntingSchemaSource.cs`.
  - `HuntingQuerySource.cs`.
  - `hunting-schema.json`, copied and embedded.
- Modify: `SchemaHandler.cs` (source `"hunting"`), `AppServices.cs`.
- Test: `tests/Kustodian.Sources.Tests/` (new xUnit project), with recorded responses under `Fixtures/` scrubbed of tenant data.

**Interfaces:**
- Consumes: the Graph `HttpClient` (Plan 1), `ParameterSubstitution` (Plan 2), `RunDiagnostics` / `ForRun` / `ForAccount`, `GraphErrorText`, `ServerRows` and `IQuerySource` (Task 1).
- Produces:
  - `HuntingClient(HttpClient graph)`, method `Task<HuntingAnswer> RunAsync(string accountKey, string kql, string timespan, RunDiagnostics d, CancellationToken ct)`.
    - POSTs to the absolute v1.0 URL with `{Query, Timespan}`.
    - Reads with `ResponseHeadersRead`, capped at 50 MB (`TooLarge` message: "The result is over Microsoft's 50 MB limit. Add summarize, project or take.").
    - Maps `schema` and `results` through `ServerRows`.
  - Status mapping:
    - 401 with a rejected token → `SignInRequiredException`.
    - 403 → NoPermission, with the copy in Global Constraints.
    - 429 → Throttled. The message is `GraphErrorText.Summarize` of the body plus "Try again in {n} s." when `Retry-After` is present.
    - 400 → QueryError. Parse the position from Graph's message when it names one: the implementer records real 400 bodies, notes the exact pattern in the test fixtures, and parses `line N` / `column M` style positions. Otherwise there is no position.
    - Other statuses → Failed.
  - `HuntingSchemaSource(HttpClient graph, TimeProvider)`, method `Task<HuntingSchemaView> GetAsync(string accountKey, bool refresh, CancellationToken ct)`.
    - Calls `GET beta/security/getHuntingSchema`. The implementer checks the response shape (`huntingSchemaResult`: `tables[]` with columns, and `functions` with built-in and saved functions) against Microsoft Learn and records a fixture.
    - Caches per account for 24 hours. A failure falls back to the bundled schema and retries after 10 minutes. A caller cancellation isn't recorded as a failure.
    - `HuntingSchemaView(string Origin /* "tenant" | "builtIn" */, string? FallbackReason, DateTimeOffset RetrievedAt, IReadOnlyList<HuntingTable> Tables, IReadOnlyList<HuntingFunction> Functions)`.
  - `HuntingQuerySource : IQuerySource`, named `"hunting"`.
    - Substitutes parameters, maps error positions back, and defaults the timespan to `P30D`.
    - Emits `RunEvent` stages `"requesting"` and `"done"`.
    - `RunResult.Tables` is `[]`.
  - `schema.get {source: "hunting", refresh?}` returns a `SchemaView` with `source`, `origin`, `fallbackReason`, `generatedAt`, `tables`, `functions`.
    - `functions` is `[{name, description, parameters: [{name, type}]}]`.
    - The Graph-only table fields (`path`, `docsUrl`, `permissions`, `filterable`, `listable`, `complexType`) become nullable on the wire and in `wire.ts`.

- [ ] **Step 1: Write the failing tests.**
  - `Hunting_posts_query_and_timespan_to_v1`.
  - `Hunting_maps_columns_and_rows_positionally`.
  - `Hunting_403_has_permission_copy`.
  - `Hunting_429_explains_limit_and_retry`.
  - `Hunting_body_over_50mb_is_too_large`.
  - `Hunting_error_position_maps_back_through_parameters`.
  - `Hunting_schema_from_tenant_with_functions`.
  - `Hunting_schema_falls_back_to_builtin_with_reason`.
  - `Hunting_schema_cached_24h_per_account`.
  - `Hunting_schema_refresh_bypasses_cache`.
  - `Builtin_hunting_schema_has_66_tables_and_4_functions`.
  - `Hunting_requests_carry_account_and_run_diagnostics`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** Port the portal code without its tenant, demo or route logic.
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat(kustodian): Defender advanced hunting through Graph runHuntingQuery`

### Task 4: Azure Resource Graph source and the ARM directory

**Files:**
- Create in `src/Kustodian.Sources/Arg/`: `ArgClient.cs`, `ArgQuerySource.cs`, `ArmDirectory.cs`, and `arg-schema.json` (embedded).
- Create: `src/Kustodian/Bridge/Handlers/ArmHandler.cs`.
- Modify:
  - `SchemaHandler.cs`: source `"arg"`.
  - `SettingsService.cs`: add `ArgRowsPerRun` (default 50,000; range "ARG rows per run" 1,000–1,000,000), appended with a default value.
  - `AppServices.cs`.
- Test: `tests/Kustodian.Sources.Tests/Arg*`.

**Interfaces:**
- Produces:
  - `ArgClient(HttpClient arm)`, method `Task<ArgAnswer> RunAsync(string accountKey, string kql, ArgScope scope, int maxRows, RunDiagnostics d, CancellationToken ct)`.
    - POSTs the resources endpoint with `{query, subscriptions | managementGroups, options: {$top: 1000, $skip: 0, resultFormat: "objectArray", $skipToken?}}`.
    - Follows `$skipToken` until `maxRows`, or until there is no token.
    - A repeated `$skipToken` is refused ("Azure Resource Graph returned the same page twice."), and so is any run past 1,000 pages.
    - `total` is ARG's `totalRecords`.
    - Throttling: on 429, wait `Retry-After` (at most 30 s) once, then answer Throttled. Read `x-ms-user-quota-remaining` and `x-ms-user-quota-resets-after` into diagnostics and the Throttled message.
    - Errors: ARG's `error.details` give the message plus `line` and `characterPositionInLine` when present. That becomes QueryError with a position. The implementer checks the exact shape against Microsoft Learn and a recorded fixture.
    - 403 → NoPermission with the copy in Global Constraints. `ConsentRequiredException` propagates.
  - `ArgQuerySource : IQuerySource`, named `"arg"`.
    - Defaults the scope to `"all"`, substitutes parameters, and maps positions back.
    - Its row limit comes from settings at startup.
  - `ArmDirectory(HttpClient arm, TimeProvider)`:
    - `SubscriptionsAsync(accountKey, ct)` returns `[{id, name, tenantId, state}]`. It pages `nextLink` only within `management.azure.com` and caches for 10 minutes per account.
    - `ManagementGroupsAsync(accountKey, ct)` returns `[{name, displayName}]`. A 403 gives an empty list with `note: "You can't list management groups."`.
    - `ResourceTypesAsync(accountKey, ct)` runs `Resources | distinct type | order by type asc` at scope `"all"` and caches for 24 hours per account.
  - Bridge methods:
    - `arm.subscriptions` returns `{subscriptions}`.
    - `arm.managementGroups` returns `{groups, note?}`.
    - `arm.resourceTypes` returns `{types}`.
    - `ConsentRequiredException` maps to `BridgeException("consentNeeded", message)`. Add `consentNeeded` to `BridgeErrorCodes`.
  - `arg-schema.json` holds the tables Microsoft documents: `Resources`, `ResourceContainers`, `AuthorizationResources`, `SecurityResources`, `PolicyResources`, `AdvisorResources`, `HealthResources`, `AlertsManagementResources`, `MaintenanceResources`, `NetworkResources`, and others in the documented list. Each table has its common columns: `id`, `name`, `type`, `tenantId`, `kind`, `location`, `resourceGroup`, `subscriptionId`, `managedBy`, `sku`, `plan`, `properties` (dynamic), `tags` (dynamic), `identity`, `zones`, `extendedLocation`.
  - `schema.get {source: "arg"}` returns the table list. Resource types come separately from `arm.resourceTypes`.

- [ ] **Step 1: Write the failing tests.**
  - `Arg_posts_scope_and_options`.
  - `Arg_follows_skip_tokens`.
  - `Arg_stops_at_rows_limit_and_reports_total`.
  - `Arg_skip_token_repeating_is_refused`.
  - `Arg_429_waits_retry_after_once_then_throttled`.
  - `Arg_error_details_give_position`.
  - `Arg_error_position_maps_back_through_parameters`.
  - `Arg_403_has_copy`.
  - `Arg_consent_needed_propagates`.
  - `Subscriptions_page_only_within_arm`.
  - `Management_groups_403_is_empty_with_note`.
  - `Resource_types_cached_24h`.
  - `Arg_rows_setting_default_range_and_missing_field_default`.
  - `Arm_requests_carry_account_and_run_diagnostics`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat(kustodian): Azure Resource Graph with scopes, paging and the ARM directory`

### Task 5: Built-in hunting and Resource Graph snippets

**Files:**
- Modify: `src/Kustodian/Snippets/builtin-snippets.json`.
- Test: extend `tests/Kustodian.Tests/Snippets/SnippetServiceTests.cs`.

**Interfaces:**
- Produces these built-in snippets, each with a new GUID id, a description and its parameters:
  - **Hunting** (group "Threat hunting"):
    - "Sign-ins from TOR exit nodes" (`AADSignInEventsBeta`, from the mockup, with an `{ips}` list parameter);
    - "Rare process launches" (`DeviceProcessEvents`, rare by count).
  - **Resource Graph** (group "Azure posture"):
    - "Public storage accounts" (from the mockup);
    - "VMs without disk encryption";
    - "Role assignments at subscription scope" (`AuthorizationResources`).
- Validation: every built-in hunting or ARG snippet, with parameter defaults substituted, parses with Kusto.Language against a `GlobalState` built from the bundled hunting schema or `arg-schema.json`, with no errors.

- [ ] **Step 1: Write the failing test.** `Builtin_hunting_and_arg_snippets_parse_against_their_schemas`, and count assertions per source.
- [ ] **Step 2: Run it.** Expected: FAIL.
- [ ] **Step 3: Add the snippets.**
- [ ] **Step 4: Run it.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat(kustodian): built-in hunting and Resource Graph snippets`

### Task 6: Web: schema per source, editor, tabs and panels

**Files:**
- Create: `web/src/schema/schema-store.ts`.
- Modify:
  - `editor/kusto-schema.ts`, `editor/kql-editor.tsx`;
  - `app.tsx`, `tabs/tab-strip.tsx`;
  - `side/side-panel.tsx`, `side/saved-panel.tsx`, `side/recent-panel.tsx`, `side/snippet-panel.tsx`;
  - `schema/schema-panel.tsx`;
  - `results/run-status.tsx`, `results/diagnostics-view.tsx`;
  - `settings/settings-view.tsx` (the ARG rows limit);
  - `session/session-sync.ts`, `library/saving.ts`, `shell/palette.tsx`, `styles.css` (`.src.hunt` and `.src.arg`, if missing), `bridge.mock.ts`.
- Test: next to each file.

**Interfaces:**
- Consumes: `schema.get {source, refresh?}` (Tasks 3–4), `arm.resourceTypes`, and Plan 2's store and commands.
- Produces:
  - `useSchemas()` (zustand), with `byKey: Record<Source, SchemaView | undefined>` plus `load(source, {refresh})` and `reset()`.
    - Loading is lazy, on the first tab of a source.
    - It resets when the active account changes.
    - A "Refresh schema" command applies to the active source.
  - `toKustoSchema(view, source)`:
    - the database name is the source (`graph`, `hunting`, `arg`), and the cluster is `https://{source}.kustodian.invalid`;
    - hunting `functions` become monaco-kusto function symbols with parameters and docstrings;
    - ARG `properties` and `tags` are `dynamic`.
  - **KqlEditor** applies the active tab's source schema. The Graph dot-completion provider stays Graph-only.
  - **`+` menu and commands:** "New Defender hunting query" and "New Resource Graph query". Shortcuts are the implementer's choice; no clash with existing ones, and the dev duplicate warning stays silent.
  - **Footer:**
    - hunting shows "Schema from your tenant (getHuntingSchema) · {date}", or "Built-in schema ({reason})";
    - ARG shows "Resource Graph tables · {n} resource types".
  - **Side panels follow the active tab's source** (spec 6.1). Saved, Recent and Snippets show the active source's items, with an "All sources" toggle (**My call**). The Schema panel shows the active source's tables, plus functions for hunting and resource types for ARG.
  - **Status line and Diagnostics.** The wording comes from the source:
    - "Graph requests" only for Graph;
    - hunting shows "1 hunting query";
    - ARG shows "{n} pages · {subscriptions}".
  - **`.kql` files** opened from disk still become Graph tabs (**My call**; the source can be changed from the tab's badge menu: "Change source").

- [ ] **Step 1: Write the failing tests.**
  - `editor_switches_schema_with_the_active_tab_source`.
  - `dot_completion_only_on_graph_tabs`.
  - `hunting_functions_become_kusto_functions`.
  - `schema_loads_lazily_and_resets_on_account_change`.
  - `new_hunting_and_arg_tabs_from_menu_and_commands`.
  - `panels_follow_active_source_with_all_toggle`.
  - `status_wording_follows_source`.
  - `change_source_from_badge`.
  - `settings_shows_arg_rows_limit`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the checks.** Web lint (only the known warning), typecheck, test and build. Expected: all pass.
- [ ] **Step 5: Commit.** `feat(kustodian): schemas, tabs and panels per source`

### Task 7: Web: timespan, scope, options and consent

**Files:**
- Create: `web/src/toolbar/timespan-picker.tsx` and `web/src/toolbar/scope-picker.tsx`.
- Modify: `tabs/tab-store.ts` (`options` on `Tab`, `TabSeed`, `restore`, `openWith`, `run`), `app.tsx`, `results/run-status.tsx` (consent), `session/session-sync.ts`, `library/saving.ts`, `side/saved-panel.tsx`, `side/recent-panel.tsx`, `library/open-library.ts` and `bridge.mock.ts`.
- Test: next to each file.

**Interfaces:**
- Consumes: `QueryOptions` (Task 1), `arm.subscriptions` / `arm.managementGroups` (Task 4) and `account.consent` (Task 2).
- Produces:
  - **Timespan picker** (hunting tabs, Hunting mockup): 1 day, 7 days, 30 days, or custom (start and end, 30 days at most). The default is `P30D`.
  - **Scope picker** (ARG tabs, ResourceGraph mockup):
    - subscriptions multi-select with search, a management group, or "All I can see";
    - shows the management-groups `note` when there is one;
    - the trigger reads "Scope: N subscriptions", "Scope: {group}" or "Scope: all I can see".
    - Menus close on click-outside or Esc, never on blur (WebKit).
  - `Tab.options` is sent with `query.run` and stored in the session, saved queries ("saved with the query") and recent runs. Reopening restores it.
  - **`consentNeeded`:** RunStatus shows the message and a "Grant Azure access" button. It calls `account.consent {key, audience: "arm"}` and then reruns. A `consentNeeded` bridge error from `arm.*` calls shows the same button in the scope picker.
  - **Commands:** "Pick timespan" and "Pick scope", each enabled on its source's tabs.

- [ ] **Step 1: Write the failing tests.**
  - `hunting_run_sends_timespan_default_p30d`.
  - `custom_timespan_over_30_days_is_refused`.
  - `scope_picker_lists_subscriptions_and_groups_with_note`.
  - `arg_run_sends_scope`.
  - `restored_arg_tab_keeps_its_scope`.
  - `saved_and_recent_keep_options`.
  - `consent_button_grants_and_reruns`.
  - `scope_menu_click_lands_without_focus`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the checks.** The web gate, plus the .NET suite. Expected: all pass.
- [ ] **Step 5: Commit.** `feat(kustodian): hunting timespan, Resource Graph scope and Azure consent`

### Task 8: Checks and manual checklist

**Files:**
- Modify: `kustodian/docs/manual-checks.md`. Add a Plan 3 section with a row per feature and one column per platform.

- [ ] **Step 1: Run the full gate on macOS, Linux (container) and Windows (VM).** Web lint, typecheck, test and build; `dotnet build -warnaserror`; `dotnet test`.
- [ ] **Step 2: Check the windows.**
  - macOS: launch the app and capture only the Kustodian window, using `screencapture -l` with a window id from CGWindowList, as in Plan 2 Task 13.
  - Windows: launch the app on the VM and capture only its window.
  - Never press Run or Send against the owner's account. Everything that needs data stays "owner":
    - hunting run;
    - ARG run across two subscriptions;
    - consent flow;
    - management groups;
    - throttling.
- [ ] **Step 3: Commit.** `docs(kustodian): manual checks for hunting and Resource Graph`
