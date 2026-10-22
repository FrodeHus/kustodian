# Kustodian Plan 1: Foundation and Graph KQL Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a Kustodian desktop window on macOS, Windows and Linux. You sign in with the Azure CLI client or your own client ID,
open Graph KQL tabs with completion, run a query against Graph beta, and see the rows in a virtualized grid. Missing permissions,
budgets, cancel and engine kills all end on the tab as clear messages.

**Architecture:**
- **Kustodian.Graph** is a .NET library ported from RightSecurity Insights. It holds the schema, planner, reader, cache, engine
  pool and runner.
- **Kustodian.Engine** is the KustoLoco worker logic. It runs in a separate process: the app's own executable started with
  `--engine`.
- **Kustodian** is the host. It opens a Photino window, serves the React UI from embedded resources, and connects the two
  through a JSON message channel. There is no HTTP server.

**Tech Stack:**
- .NET 10 (SDK 10.0.401), Photino.NET.
- Microsoft.Azure.Kusto.Language 12.4.1 and KustoLoco.Core 1.4.9.
- MSAL.NET and Microsoft.Identity.Client.Extensions.Msal.
- xUnit v3 (`xunit.v3.mtp-v2` 4.0.1) on Microsoft.Testing.Platform.
- React 19, TypeScript ~6.0, Vite 8, Tailwind 4, Monaco ~0.55.1 and `@kusto/monaco-kusto` 15.0.1.
- TanStack Table 8 and TanStack Virtual 3, zustand 5 (tab state), Vitest 5, oxlint.

**Spec:** `kustodian/docs/design/specs/2026-10-21-kustodian-design.md`. Mockups:
https://claude.ai/artifact/3fn5aBUiWTu7EMD7BFyYap (boards Main and SignIn for this plan).

**The four plans:** this is Plan 1 of 4. Each ships working software.

- **Plan 1:** foundation and Graph KQL, end to end.
- **Plan 2:** workbench features, spec 6.2–6.6 and 6.8–6.11 beyond what Plan 1 builds:
  - saved and recent queries, session restore, parameters, snippets and the palette;
  - export, chart, compare and row details;
  - Explain, the raw request tab, diagnostics and themes.
- **Plan 3:** the hunting and Azure Resource Graph sources (spec 8).
- **Plan 4:** packaging, CI and the three-platform release (spec 10, 13 and 14).

Plans 2–4 are written after this one is reviewed, against the interfaces it produces.

## Global Constraints

- Everything lives under `kustodian/`. Nothing in it references a path outside it, and nothing outside references it (spec 10).
- `dotnet build -warnaserror` (run in `kustodian/`), `npm run lint` (oxlint) and `npx tsc --noEmit` must pass with zero
  warnings.
  - No `#pragma warning disable`, `[SuppressMessage]`, `<NoWarn>`, `oxlint-disable` or `@ts-ignore`.
  - Generated files are exempt as their generators write them.
- Namespaces start `Kustodian.`. No name, string, colour or asset from RightSecurity Insights or Sopra Steria (spec 4).
- Ported code is copied from `src/Insights.Graph`, `src/Insights.GraphEngine` and `tools/graph-schema` at the repository root,
  then adapted. Its tests come along with their scenarios (spec 7, 13). The owner owns that code and allows relicensing under MIT
  (spec 15).
- KQL parsing runs under `CultureInfo.InvariantCulture` (spec 7.2).
- Graph calls go to `https://graph.microsoft.com/beta/`. A `@odata.nextLink` is followed only when its host is
  `graph.microsoft.com`.
- Tokens and `Authorization` headers are never logged, never written to disk outside the OS keychain, and never sent to any host
  other than Microsoft's (spec 4, 6.7, 6.10).
- Default client ID: `04b07795-8ddb-461a-bbee-02f9e1bf7b46`. Default tenant: `organizations`. Graph scope:
  `https://graph.microsoft.com/.default`. Always `.default`, with no incremental consent (spec 6.7).
- Defaults (spec 9):
  - Graph objects per table: 50,000.
  - Fetch budget per run: 512 MB, estimated as raw bytes ×3.
  - Engine: 120 s timeout, 1 GB heap limit per worker, 2 workers.
  - Per-object reads: 2,000 objects per table, cached for 30 minutes.
- UI look: the tokens, fonts and class roles of the mockups' `studio.css`. Dark is the default. Inter and JetBrains Mono are
  bundled with the app, never fetched (spec 6.11).

## Review Focus

1. **A query naming a column Graph refuses** (`onPremisesPublishing` without `Directory.ReadWrite.All`, or a 400 like "Invalid
   object identifier"). The run returns rows, with the column empty and a chip that names it. It must not fail.
   Test: Task 6, `Run_with_denied_column_returns_rows_and_names_the_column`.
2. **A tenant too big for the budget.** The run ends with "too large: add a filter or project", promptly. It must not hang or
   report "busy". Test: Task 6, `Run_over_budget_reports_too_large`.
3. **Cancel during fetch and during the engine.** The tab returns to idle, the worker process is gone, and the next run works.
   Test: Task 6, `Cancel_during_engine_kills_worker_and_next_run_succeeds`.
4. **Closing the window while a query runs.** No orphaned engine processes are left behind.
   Test: Task 5, `Dispose_kills_running_workers`.
5. **The OS culture is nb-NO or de-DE.** `ago(1.5d)` and `0.5` parse the same as under en-US.
   Test: Task 3, `Plan_parses_reals_and_timespans_under_comma_decimal_culture`.

---

## File structure

```
kustodian/
  global.json  Directory.Build.props  Directory.Packages.props  Kustodian.slnx
  LICENSE  README.md  .editorconfig  .gitignore
  src/Kustodian.Graph/
    Schema/   GraphSchema.cs GraphMetadata.cs GraphSchemaBuilder.cs GraphSchemaJson.cs GraphSchemaDiff.cs
              GraphSchemaCatalog.cs GraphPermissions.cs graph-beta.json (embedded)
    Query/    GraphGlobals.cs GraphCompletion.cs GraphQueryPlanner.cs GraphFilterTranslator.cs
    Fetch/    GraphCollectionReader.cs GraphBatchReader.cs GraphFetchBudget.cs GraphObjectCache.cs
              MemoryGraphObjectCache.cs GraphReadException.cs GraphErrorText.cs
    Engine/   EngineProtocol.cs GraphEnginePool.cs GraphEngineOptions.cs GraphEngineException.cs
    Run/      GraphRunner.cs RunResult.cs RunEvent.cs
  src/Kustodian.Engine/      EngineMain.cs EngineHandler.cs TableLoader.cs QueryClock.cs
  src/Kustodian/             Program.cs  App/AppWindow.cs  App/EmbeddedAssets.cs
                             Bridge/Bridge.cs Bridge/BridgeMessages.cs Bridge/Handlers/*.cs
                             Auth/ClientConfig.cs Auth/AccountService.cs Auth/TokenCacheFactory.cs Auth/GraphAuthHandler.cs
                             Storage/AppPaths.cs Storage/JsonFileStore.cs
  tools/schema/              Program.cs schema.csproj README.md
  tests/Kustodian.Graph.Tests/  tests/Kustodian.Engine.Tests/  tests/Kustodian.Tests/
  tests/Kustodian.EngineWorker/   (a tiny console host the pool tests start, calling EngineMain.Run)
  web/  package.json vite.config.ts tsconfig.json .oxlintrc.json index.html
        src/main.tsx src/app.tsx src/styles.css src/bridge.ts src/bridge.mock.ts
        src/tabs/tab-store.ts src/tabs/tab-strip.tsx
        src/editor/kql-editor.tsx src/editor/block-at.ts src/editor/kusto-schema.ts
        src/schema/schema-panel.tsx src/results/result-grid.tsx src/results/run-status.tsx
        src/signin/sign-in.tsx src/shell/title-bar.tsx
```

---

### Task 1: Scaffold the self-contained solution

**Files:**
- Create: `kustodian/global.json` (copy of the root `global.json`: SDK `10.0.401`, `rollForward: latestFeature`, test runner
  `Microsoft.Testing.Platform`).
- Create: `kustodian/Directory.Build.props`:
  - `TargetFramework net10.0`, `Nullable enable`, `ImplicitUsings enable`;
  - `TreatWarningsAsErrors true`, `AnalysisLevel latest-recommended`, `EnforceCodeStyleInBuild true`.
- Create: `kustodian/Directory.Packages.props`: central package versions for every package in the Tech Stack.
- Create: `kustodian/Kustodian.slnx`, listing every project below.
- Create: `kustodian/LICENSE` (MIT, "Copyright (c) 2026 Frode Hus"), `README.md` (one paragraph plus build commands),
  `.editorconfig` (copied from the root, without repo-specific rules), `.gitignore` (`bin/ obj/ node_modules/ web/dist/`).
- Create the projects:
  - `src/Kustodian/Kustodian.csproj` (`OutputType Exe`);
  - `src/Kustodian.Graph/Kustodian.Graph.csproj`;
  - `src/Kustodian.Engine/Kustodian.Engine.csproj`;
  - `tests/Kustodian.Graph.Tests`, `tests/Kustodian.Engine.Tests`, `tests/Kustodian.Tests` (xUnit v3 MTP);
  - `tests/Kustodian.EngineWorker` (`OutputType Exe`, references `Kustodian.Engine`).
- Test: `tests/Kustodian.Tests/ScaffoldTests.cs`.

**Interfaces:**
- Produces: the project names and namespaces above. `Kustodian` references `Kustodian.Graph` and `Kustodian.Engine`.

- [ ] **Step 1: Write the failing test** `Solution_has_no_reference_outside_kustodian`. It walks every `*.csproj` and
  `Directory.*.props` under `kustodian/`, and asserts that no `ProjectReference`, `Import` or `Include` path resolves outside the
  `kustodian/` directory.
- [ ] **Step 2: Run it.** `dotnet test --project tests/Kustodian.Tests` (from `kustodian/`). Expected: FAIL (projects missing).
- [ ] **Step 3: Create the files above.**
- [ ] **Step 4: Run the build and the test.** `dotnet build -warnaserror` and then `dotnet test`. Expected: 0 warnings, PASS.
- [ ] **Step 5: Commit.** `git add kustodian && git commit -m "chore(kustodian): scaffold the self-contained solution"`

### Task 2: Schema, permissions and the schema tool

Port `Schema/*` (except `Demo/`) and `tools/graph-schema`. Add per-table permissions and the hand-kept column permission list
(spec 7.1).

**Files:**
- Create: `src/Kustodian.Graph/Schema/*.cs` (ported).
- Create: `src/Kustodian.Graph/Schema/GraphPermissions.cs`.
- Create: `tools/schema/*` (ported) and `tools/schema/README.md`.
- Create: `src/Kustodian.Graph/Schema/graph-beta.json`, generated and embedded as a resource.
- Test: `tests/Kustodian.Graph.Tests/Schema/*` (ported `GraphSchemaBuilderTests`, `GraphSchemaJsonTests`,
  `GraphSchemaDiffTests`, `GraphSchemaCatalogTests`, `TestSchemas`), plus `GraphPermissionsTests.cs`.

**Interfaces:**
- Produces:
  - `GraphTable` gains `IReadOnlyList<string> Permissions` (init property, default `[]`): the least-privileged delegated
    permissions for listing the table.
  - `GraphColumn` gains `string? KnownPermission` (init property, default `null`).
  - `static class GraphPermissions`:
    - `IReadOnlyDictionary<string, IReadOnlyList<string>> ReadDelegated(Stream permissionsJson)`, keyed by API path;
    - `static readonly IReadOnlyDictionary<(string Table, string Column), string> KnownColumns`.
  - `GraphSchemaBuilder.Build(GraphMetadata metadata, IReadOnlyDictionary<string, IReadOnlyList<string>> permissions, string
    source, DateTimeOffset generatedAt)`.
  - `GraphSchemaCatalog.Beta : GraphSchema`, loaded once from the embedded `graph-beta.json`.
  - Schema tool: `dotnet run --project tools/schema -- [--metadata <path|url>] [--permissions <path|url>] [--out <path>]`.
    It prints `GraphSchemaDiff.ToSummary()` against the current file.

- [ ] **Step 1: Copy the ported files and tests, renaming namespaces.** Delete `GraphDemoData` and any reference to it.
- [ ] **Step 2: Run the ported tests.** `dotnet test --project tests/Kustodian.Graph.Tests`. Expected: PASS once namespaces
  compile.
- [ ] **Step 3: Check Microsoft's permissions data.** Open `microsoftgraph/msgraph-metadata` and find the permissions file keyed
  by API path. Record its exact URL and shape in `tools/schema/README.md`. Save an excerpt covering `/applications`, `/users` and
  `/auditLogs/signIns` as `tests/Kustodian.Graph.Tests/Schema/permissions-excerpt.json`.
- [ ] **Step 4: Write the failing tests.**
  - `ReadDelegated_returns_least_privileged_delegated_permissions_per_path`: from the excerpt, `/applications` contains
    `Application.Read.All`.
  - `Build_sets_table_permissions_from_path`: a table with path `applications` gets
    `Permissions == ["Application.Read.All"]` (or whatever the excerpt lists as least-privileged).
  - `Build_sets_known_column_permission`: `applications.onPremisesPublishing.KnownPermission == "Directory.ReadWrite.All"`.
  - `GraphSchemaJson_round_trips_permissions`.
  - `Beta_catalog_has_no_me_tables_and_no_listable_stream_columns`.
- [ ] **Step 5: Run them.** Expected: FAIL.
- [ ] **Step 6: Implement.**
  - `GraphPermissions.ReadDelegated` reads the shape recorded in Step 3.
  - `KnownColumns = { ("applications", "onPremisesPublishing") → "Directory.ReadWrite.All" }`.
  - The builder sets both properties. `GraphSchemaJson` writes `permissions` on tables and `knownPermission` on columns, and
    omits them when empty.
- [ ] **Step 7: Generate the schema.** Run the tool to write `graph-beta.json`, and mark it `EmbeddedResource`.
- [ ] **Step 8: Run all tests.** Expected: PASS.
- [ ] **Step 9: Commit.** `feat(kustodian): Graph schema with permissions, and the schema tool`

### Task 3: Planner, filter translation and completion

**Files:**
- Create: `src/Kustodian.Graph/Query/*.cs` (ported).
- Test: `tests/Kustodian.Graph.Tests/Query/*` (ported `GraphQueryPlannerTests`, `GraphFilterTranslatorTests`,
  `GraphGlobalsTests`, `GraphCompletionTests`).

**Interfaces:**
- Consumes: `GraphSchema` and `GraphTable` from Task 2.
- Produces (unchanged from the port):
  - `GraphQueryPlanner.Plan(GraphSchema schema, string kql, DateTimeOffset now) -> GraphQueryPlan`;
  - `GraphQueryPlan(IReadOnlyList<GraphFetch> Fetches, GraphQueryError? Error, string? Refusal)`;
  - `GraphFetch(GraphTable Table, IReadOnlyList<string> Select, string? Filter)`;
  - `GraphQueryError(int Line, int Column, string Message)`;
  - `GraphCompletion.Complete(GraphSchema, string kql, int position) -> IReadOnlyList<GraphCompletionItem>`;
  - `GraphGlobals.Typed(GraphSchema, int depth = 3) -> GlobalState`.

- [ ] **Step 1: Copy the files and tests, renaming namespaces.**
- [ ] **Step 2: Run the ported tests.** Expected: PASS.
- [ ] **Step 3: Write the failing test** `Plan_parses_reals_and_timespans_under_comma_decimal_culture`. Set
  `CultureInfo.CurrentCulture` to `nb-NO`, plan `applications | where createdDateTime > ago(1.5d) | extend x = 0.5`, and assert
  `Error is null`. The pushed filter's datetime equals the one the same plan produces under `en-US`.
- [ ] **Step 4: Run it.** Expected: PASS if the port already forces the invariant culture inside `Plan`. If it only did so in the
  portal's worker, FAIL.
- [ ] **Step 5: If it failed,** wrap parsing in `Plan` and `Complete` in an invariant-culture scope that restores the caller's
  culture.
- [ ] **Step 6: Write the failing pushdown tests,** one per spec 7.4 rule not already covered by a ported test.
  - Check the ported file first and add only the missing ones from this list:
    - `Empty_string_is_not_pushed`;
    - `Case_insensitive_ops_push_only_on_directory_objects`;
    - `Datetime_gt_pushes_as_ge`;
    - `Ne_and_null_not_pushed_on_directory_objects`;
    - `Isnotnull_on_text_not_pushed`;
    - `Or_pushes_only_when_both_sides_push`;
    - `Not_is_never_pushed`.
  - Each asserts the plan's `Filter` for one KQL snippet.
- [ ] **Step 7: Run them.** Expected: PASS, or fix the translator until they do.
- [ ] **Step 8: Commit.** `feat(kustodian): KQL planner, $filter pushdown and completion`

### Task 4: Graph reader, batch reads, budget and cache

Port `Fetch/*` for one signed-in account.

**Files:**
- Create: `src/Kustodian.Graph/Fetch/*.cs` (ported), `MemoryGraphObjectCache.cs`, `GraphErrorText.cs`.
- Test: `tests/Kustodian.Graph.Tests/Fetch/*` (ported `GraphCollectionReaderTests`, `GraphBatchReaderTests`), plus
  `MemoryGraphObjectCacheTests.cs` and `GraphErrorTextTests.cs`.

**Interfaces:**
- Consumes: `GraphFetch` from Task 3.
- Produces:
  - `GraphCollectionReader(HttpClient http, GraphFetchBudget budget, IGraphObjectCache cache)`.
    - `ReadAsync(string accountKey, GraphFetch fetch, GraphFetchLease lease, bool refresh, CancellationToken ct) ->
      GraphCollection`.
    - The tenant id and name parameters are removed. The `HttpClient`'s handler adds the token (Task 7). `accountKey` keys the
      cache.
  - `GraphCollection` stays as ported: `Objects`, `Requests`, `Unfiltered`, `Unreadable`, `PerObject`, `PerObjectFailed`,
    `PerObjectCapped`, `PerObjectCached`, `PerObjectCachedAt`, `Denied`.
  - `GraphBatchReader.ReadAsync(string path, IReadOnlyList<JsonObject> objects, IReadOnlyList<string> columns,
    CancellationToken ct) -> GraphBatchRead`.
  - `IGraphObjectCache`: `GetAsync`, `SetAsync` and `RemoveAccountAsync`, with `string accountKey` in place of `Guid tenantId`.
  - `MemoryGraphObjectCache(TimeProvider time, TimeSpan? ttl = null) : IGraphObjectCache`. The TTL defaults to 30 minutes. It
    has a `Clear()` method.
  - `GraphFetchBudget(long maxBytes = 512L << 20, TimeSpan? patience = null)`. `Lease()` has no tenant cap: one account, so a
    lease gets `maxBytes / EstimatedSizeFactor`.
  - `GraphReadException` and `GraphReadFailure` (`NoPermission`, `Throttled`, `TooLarge`, `NotFound`, `Busy`, `Failed`).
  - `GraphErrorText.Summarize(int status, string? body) -> string`. For HTML it returns `"{status} from Graph's backend: {title
    or first heading}"`, cut to 200 characters. For JSON it returns `error.message`.

- [ ] **Step 1: Copy the files and tests.** Remove the tenant parameters and `DefenderRequestOptions`. Tests drop their tenant
  arguments.
- [ ] **Step 2: Run the ported tests.** Expected: PASS. They cover paging, the nextLink host check, budgets, the 400 refetch,
  probing (16 probes, 401/403 → `Denied`, other 4xx → not listable), batches of 20 with 4 in flight, and the 2,000 cap.
- [ ] **Step 3: Write the failing tests.**
  - `Entries_expire_after_30_minutes` (with a `FakeTimeProvider`).
  - `Clear_removes_everything`.
  - `Summarize_html_body_returns_status_and_title`: status 404 and body `<html><head><title>404 - File or directory not
    found.</title>` give `404 from Graph's backend: 404 - File or directory not found.`
  - `Summarize_json_returns_error_message`.
- [ ] **Step 4: Run them.** Expected: FAIL.
- [ ] **Step 5: Implement** `MemoryGraphObjectCache` (a `ConcurrentDictionary` keyed by account, path, sorted columns and id) and
  `GraphErrorText`. Use `GraphErrorText` wherever the reader builds a message from a response body.
- [ ] **Step 6: Run them.** Expected: PASS.
- [ ] **Step 7: Commit.** `feat(kustodian): Graph reader with probing, batch reads, budget and cache`

### Task 5: Engine worker and pool

**Files:**
- Create: `src/Kustodian.Engine/*.cs`, ported from `src/Insights.GraphEngine`. Its `Program.cs` logic becomes
  `EngineMain.Run(Stream input, Stream output) -> int`.
- Create: `tests/Kustodian.EngineWorker/Program.cs`, which calls `EngineMain.Run(stdin, stdout)`.
- Create: `src/Kustodian.Graph/Engine/*.cs`, ported. Drop `GraphEngineHealthCheck` (it needs ASP.NET Core).
- Test: `tests/Kustodian.Engine.Tests/*` (ported `EngineHandlerTests`, `EngineFramesTests`, `PushdownEquivalenceTests`,
  `ODataMatcher`, `EngineTables`, `GraphEnginePoolTests`).

**Interfaces:**
- Produces:
  - `EngineRequest`, `EngineResponse`, `EngineTable`, `EngineColumn` and `EngineFrames`, as ported.
  - `GraphEngineOptions`:
    - `Workers = 2`, `Timeout = 120 s`, `MemoryLimitBytes = 1L << 30`;
    - `WorkerPath` defaults to `Environment.ProcessPath`;
    - new `IReadOnlyList<string> WorkerArgs`, defaulting to `["--engine"]`.
    - A `.dll` path still runs on the dotnet host. Tests point `WorkerPath` at `Kustodian.EngineWorker.dll` with
      `WorkerArgs = []`.
  - `GraphEnginePool(GraphEngineOptions options, ILogger<GraphEnginePool> logger, TimeProvider time)`, with no `IOptions`.
    - `RunAsync(EngineRequest, string runTag, CancellationToken) -> EngineResponse`.
    - `Snapshot() -> GraphEngineSnapshot`.
    - `DisposeAsync()`.
  - `EngineMain.Run(Stream input, Stream output) -> int`, which `Kustodian`'s `Program.Main` calls for `--engine` (Task 8).

- [ ] **Step 1: Copy the files and tests.** Point the pool tests at `Kustodian.EngineWorker.dll`, copied to the test output with
  a `ProjectReference` (`ReferenceOutputAssembly=false`) plus a copy target.
- [ ] **Step 2: Run the ported tests.** Expected: PASS. They cover the timeout kill, memory kill, oversized frame kill, crash
  guard, external-data refusal, and the 1,000-character cell cut except series.
- [ ] **Step 3: Write the failing test** `Dispose_kills_running_workers`. Start a run of a query that never finishes (the ported
  tests have one), dispose the pool, and assert within 5 s that the worker's process id has exited and `RunAsync` threw
  `OperationCanceledException` or `GraphEngineException`.
- [ ] **Step 4: Run it.** Expected: PASS if the port already kills workers on dispose; otherwise make `DisposeAsync` kill every
  worker's process tree.
- [ ] **Step 5: Write the failing test** `Default_options_match_spec`: asserts 2 workers, 120 s, 1 GiB and `["--engine"]`.
- [ ] **Step 6: Run the tests until both pass.**
- [ ] **Step 7: Commit.** `feat(kustodian): engine worker and killable pool`

### Task 6: GraphRunner, one run from KQL to rows

Desktop orchestration, ported from the portal's `src/Insights.Api/GraphQuery/GraphQueryRunner.cs`. Drop customers, tenants, the
database, rate limits and demo data.

**Files:**
- Create: `src/Kustodian.Graph/Run/GraphRunner.cs`, `RunResult.cs`, `RunEvent.cs`.
- Test: `tests/Kustodian.Graph.Tests/Run/GraphRunnerTests.cs`, with a `FakeGraph` `HttpMessageHandler` ported from
  `tests/Insights.Api.Tests/Infrastructure/FakeGraph.cs`, and the engine pool on `Kustodian.EngineWorker`.

**Interfaces:**
- Consumes: Tasks 2–5.
- Produces:
  - `GraphRunner(GraphSchema schema, GraphCollectionReader reader, GraphFetchBudget budget, GraphEnginePool engine,
    TimeProvider time)`.
  - `Task<RunResult> RunAsync(string accountKey, string kql, bool refresh, IProgress<RunEvent>? progress, CancellationToken
    ct)`.
    - It plans, then reads every fetch in parallel under one lease, then runs the engine.
    - It never throws, except `OperationCanceledException` when `ct` is cancelled.
  - `RunResult`:
    - `Outcome` (`RunOutcome`): `Ok`, `QueryError`, `Refused`, `NoPermission`, `Throttled`, `TooLarge`, `EngineTimeout`,
      `EngineMemory`, `SignInNeeded` or `Failed`;
    - `Message` (string?) and `Error` (`GraphQueryError?`);
    - `Columns` (`IReadOnlyList<EngineColumn>`), `Rows` (`IReadOnlyList<JsonElement[]>`), `Total` (int);
    - `Tables` (`IReadOnlyList<TableFetch>`), `Duration` (`TimeSpan`).
  - `TableFetch(string Table, IReadOnlyList<string> Requests, bool Unfiltered, IReadOnlyList<string> Unreadable,
    IReadOnlyList<string> Denied, IReadOnlyList<string> PerObject, int PerObjectFailed, bool PerObjectCapped, int
    PerObjectCached)`.
  - `RunEvent(string Stage, string Detail)`. `Stage` is one of `planning`, `fetching`, `probing`, `per-object` or `engine`.
  - Messages (spec 12), as exact copy:
    - `TooLarge`: `"Too much data from {table} for one run ({budget} MB). Add a filter or project fewer columns."`
    - `EngineTimeout`: `"The query took longer than {s} s and was stopped."`
    - `EngineMemory`: `"The query used more than {MB} MB and was stopped."`
    - `NoPermission` (whole table): `"You don't have permission to read {table}. It needs {permissions}."` When the table's
      `Permissions` is empty: `"You don't have permission to read {table}."` plus its docs URL.
    - `SignInNeeded`: `"Sign in again to run this query."`

- [ ] **Step 1: Write the failing tests.**
  - `Run_returns_rows_for_simple_query`: `applications | project displayName` against two fake apps gives two rows.
  - `Run_with_denied_column_returns_rows_and_names_the_column`: the fake answers the first page with 403 when `$select` includes
    `onPremisesPublishing`. Outcome `Ok`, rows returned, and `Tables[0].Denied == ["onPremisesPublishing"]`.
  - `Run_with_400_on_probe_marks_column_unreadable_and_continues`: the "Invalid object identifier '[sourceEntityId]'" case.
  - `Run_over_budget_reports_too_large`: budget 1 MB, a fake that pages 5 MB. Outcome `TooLarge`, the message names the table,
    and the test finishes in under 10 s.
  - `Cancel_during_engine_kills_worker_and_next_run_succeeds`: cancel during a slow engine query, assert
    `OperationCanceledException`, `engine.Snapshot().Busy == 0`, then a second run returns `Ok`.
  - `Query_error_returns_position`: `applications | wher x` gives `QueryError` with `Line` 1 and `Column` > 0.
  - `Refused_query_returns_refusal`: `cluster('x').database('y').T` gives `Refused`.
  - `Unauthorized_token_returns_sign_in_needed`: the fake returns 401 with `WWW-Authenticate: Bearer error="invalid_token"` on
    the first page with only `id` selected. Outcome `SignInNeeded`.
  - `Progress_reports_stages_in_order`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement** `GraphRunner`, `RunResult` and `RunEvent`, following the portal's `RunTenantAsync` and
  `FetchAsync`, with one target.
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat(kustodian): GraphRunner from KQL to rows with clear outcomes`

### Task 7: Sign-in, accounts and the token handler

**Files:**
- Create: `src/Kustodian/Auth/ClientConfig.cs`, `AccountService.cs`, `TokenCacheFactory.cs`, `GraphAuthHandler.cs`.
- Create: `src/Kustodian/Storage/AppPaths.cs`, `JsonFileStore.cs`.
- Test: `tests/Kustodian.Tests/Auth/*`, `tests/Kustodian.Tests/Storage/*`.

**Interfaces:**
- Produces:
  - `ClientConfig(string ClientId, string Tenant)`.
    - `static ClientConfig AzureCli => new("04b07795-8ddb-461a-bbee-02f9e1bf7b46", "organizations")`.
    - `bool IsAzureCli`.
  - `enum Audience { Graph, Arm }`. Scopes: `https://graph.microsoft.com/.default` and `https://management.azure.com/.default`.
    `Arm` is unused until Plan 3.
  - `interface ITokenSource { Task<string> GetTokenAsync(Audience audience, CancellationToken ct); string? ActiveAccountKey { get;
    } }`.
  - `AccountService : ITokenSource`, built on `IPublicClientApplication`.
    - `SignInInteractiveAsync(ClientConfig, CancellationToken)` uses the system browser with redirect `http://localhost`.
    - `SignInDeviceCodeAsync(ClientConfig, Action<string> showCode, CancellationToken)`.
    - `ListAccountsAsync() -> IReadOnlyList<AccountInfo>`, `UseAsync(string accountKey)`, `SignOutAsync(string accountKey)`.
    - `GetTokenAsync` tries silent first. It throws `SignInRequiredException` when silent fails with `MsalUiRequiredException`.
  - `AccountInfo(string Key, string Username, string TenantName, string TenantId, string ClientId, bool Active, bool Expired,
    IReadOnlyList<string> Scopes)`. `Scopes` comes from the last Graph token's `scp` claim, for the "What this sign-in can read"
    chips.
  - `TokenCacheFactory.TryCreateAsync(string cacheDir) -> Task<TokenCacheStatus>`:
    - `Persistent` on Windows (DPAPI), macOS (Keychain) and Linux when libsecret works, checked with `VerifyPersistence()`;
    - otherwise `MemoryOnly(string reason)`.
    - It never falls back to plain text (spec 6.7).
  - `GraphAuthHandler(ITokenSource tokens) : DelegatingHandler`. It adds `Authorization: Bearer` with an `Audience.Graph` token,
    and only when the request's host is `graph.microsoft.com`.
  - `AppPaths.Root`:
    - Windows: `%APPDATA%\Kustodian`;
    - macOS: `~/Library/Application Support/Kustodian`;
    - Linux: `$XDG_CONFIG_HOME/kustodian`, else `~/.config/kustodian`.
  - `JsonFileStore`:
    - `ReadAsync<T>(string relativePath, T fallback)`;
    - `WriteAsync<T>(string relativePath, T value)`, atomic (write to a temp file, then rename);
    - a corrupt file is renamed `*.corrupt` and `fallback` returned with `Corrupt = true`.
  - `accounts.json` stores `AccountInfo` metadata and the active key, never tokens.

- [ ] **Step 1: Write the failing tests.**
  - `AzureCli_config_has_spec_client_id_and_organizations`.
  - `Handler_adds_bearer_only_for_graph_host`: a request to `example.com` has no `Authorization` header.
  - `Handler_never_logs_token`: capture the logger, assert the token string never appears.
  - `Cache_falls_back_to_memory_when_persistence_check_fails`: inject a failing verifier, get `MemoryOnly`, and assert no file
    was written in `cacheDir`.
  - `AppPaths_root_per_platform`: use `OperatingSystem` overrides through an injected platform enum.
  - `Write_is_atomic_and_corrupt_file_is_moved_aside`.
  - `GetToken_without_account_throws_SignInRequired`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** `AccountService` wraps MSAL behind a small `IMsalClient` interface, so tests fake it. One
  `IPublicClientApplication` per `ClientConfig`.
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat(kustodian): MSAL sign-in, keychain token cache and local storage`

### Task 8: Host window and message channel

**Files:**
- Create: `src/Kustodian/Program.cs`. With `--engine` it returns `EngineMain.Run(stdin, stdout)` before anything else loads.
  Otherwise it builds services and opens `AppWindow`.
- Create: `src/Kustodian/App/AppWindow.cs` (Photino: title `Kustodian`, 1440×900, minimum 1024×640) and
  `App/EmbeddedAssets.cs`. `web/dist` is embedded at build time, by an MSBuild target that runs `npm ci && npm run build` when
  `web/dist` is missing or older than `web/src`, and is served on a custom scheme `app://`.
- Create: `src/Kustodian/Bridge/Bridge.cs`, `BridgeMessages.cs`, and `Bridge/Handlers/SchemaHandler.cs`, `QueryHandler.cs`,
  `AccountHandler.cs`, `AppHandler.cs`.
- Test: `tests/Kustodian.Tests/Bridge/*`.

**Interfaces:**
- Consumes: `GraphRunner` (Task 6), `GraphCompletion` and `GraphSchemaCatalog` (Tasks 2–3), `AccountService` (Task 7).
- Produces the wire contract, JSON in camelCase:
  - Request: `{ "id": string, "method": string, "params": object }`.
  - Response: `{ "id": string, "result": object }` or `{ "id": string, "error": { "code": string, "message": string } }`.
  - Event: `{ "event": string, "data": object }`.
  - Methods in Plan 1:
    - `app.info → { version, platform }`.
    - `schema.get { source: "graph" } → SchemaView`.
      - `SchemaView`: `{ source, generatedAt, tables: [{ name, description, docsUrl, permissions, columns: [{ name, type,
        description, filterable, listable, complexType, collection }] }], complexTypes }`.
    - `query.complete { source, kql, position } → GraphCompletionItem[]`.
    - `query.run { tabId, source, kql, refresh } → RunResult`, serialized with `outcome` as a camelCase string. During the run,
      `query.progress` events go out with `{ tabId, stage, detail }`.
    - `query.cancel { tabId } → {}`.
    - `account.list → { accounts: AccountInfo[], cache: "persistent" | "memoryOnly", cacheReason? }`,
      `account.signIn { clientId?, tenant?, deviceCode? } → AccountInfo`, `account.use { key }`, `account.signOut { key }`.
    - During device-code sign-in, an `account.deviceCode { message }` event goes out.
  - `Bridge.Register(string method, Func<JsonElement, CancellationToken, Task<object?>> handler)`.
  - `Bridge.HandleAsync(string message) -> Task<string?>`.
  - `Bridge.Emit(string evt, object data)`.

- [ ] **Step 1: Write the failing tests.**
  - `Unknown_method_returns_error_code_unknown_method`.
  - `Handler_exception_returns_error_code_failed_with_message_and_no_stack`.
  - `Run_then_cancel_same_tab_cancels_the_run`.
  - `Second_run_on_same_tab_cancels_the_first`.
  - `Progress_events_carry_tab_id`.
  - `Schema_get_graph_returns_tables_with_permissions`.
  - `Program_with_engine_flag_runs_engine_main_and_never_opens_window`: test the dispatch function, not `Main`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement** `Bridge` and its handlers. Photino's `RegisterWebMessageReceivedHandler` passes each message to
  `HandleAsync`, and `SendWebMessage` sends the reply. Keep one `CancellationTokenSource` per `tabId`.
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Smoke-test the window.** `dotnet run --project src/Kustodian` on macOS opens a window titled Kustodian that shows
  the web placeholder page from Task 9.
- [ ] **Step 6: Commit.** `feat(kustodian): Photino host, embedded UI and message channel`

### Task 9: Web scaffold, tokens and bridge client

**Files:**
- Create: `web/package.json`, with the versions from the Tech Stack and scripts `dev`, `build`, `lint` (`oxlint`), `typecheck`
  (`tsc --noEmit`) and `test` (`vitest run`).
- Create: `web/vite.config.ts`, `tsconfig.json`, `.oxlintrc.json`, `index.html`, `src/main.tsx`.
- Create: `web/src/styles.css`, with Tailwind 4 plus the `studio.css` tokens (dark `:root` and the `.light` variant) as CSS
  variables. Inter and JetBrains Mono come from `@fontsource/*` packages, bundled.
- Create: `web/src/bridge.ts` and `bridge.mock.ts`.
- Test: `web/src/bridge.test.ts`.

**Interfaces:**
- Produces:
  - `call<T>(method: string, params?: unknown, signal?: AbortSignal): Promise<T>`. It rejects with `BridgeError { code,
    message }`.
  - `on(event: string, handler: (data: unknown) => void): () => void`.
  - The transport is `window.external.sendMessage` and `receiveMessage` under Photino. When those are absent (`vite dev`, tests),
    `bridge.mock.ts` answers from fixtures: the schema from a trimmed `graph-beta.json` excerpt, and canned rows.

- [ ] **Step 1: Write the failing tests.**
  - `call_resolves_matching_id_only`.
  - `call_rejects_with_bridge_error`.
  - `on_unsubscribe_stops_delivery`.
  - `abort_signal_sends_query_cancel`: when the call is `query.run`, aborting sends `query.cancel` with the same `tabId`.
- [ ] **Step 2: Run them.** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test`, `npm run lint`, `npm run typecheck` and `npm run build`. Expected: all pass with 0 warnings.
- [ ] **Step 5: Commit.** `feat(kustodian): web scaffold, design tokens and bridge client`

### Task 10: The main window, tabs, editor, schema panel and grid

Build the Main board's layout for Graph tabs (spec 6.1, 6.2 core and 6.5 core). The `+` menu shows only "Microsoft Graph query"
in Plan 1. Its other entries arrive in Plans 2–3.

**Files:**
- Create: `web/src/app.tsx`, `shell/title-bar.tsx`, `tabs/tab-store.ts`, `tabs/tab-strip.tsx`.
- Create: `editor/kql-editor.tsx`, `editor/block-at.ts`, `editor/kusto-schema.ts`.
- Create: `schema/schema-panel.tsx`, `results/result-grid.tsx`, `results/run-status.tsx`, `signin/sign-in.tsx`.
- Test: a `*.test.ts(x)` beside each file.

**Interfaces:**
- Consumes: the bridge methods from Task 8, and `call` and `on` from Task 9.
- Produces (Plan 2 builds on these):
  - `type Source = "graph" | "hunting" | "arg"`.
  - `type Tab = { id: string; source: Source; title: string; text: string; dirty: boolean; run?: TabRun }`.
  - `TabRun`: `{ state: "running" | "done"; stage?: string; result?: RunResult; startedAt: number }`.
  - `useTabs()`, a zustand store: `tabs`, `activeId`, `open(source)`, `close(id)`, `activate(id)`, `setText(id, text)`,
    `run(id, mode)` and `cancel(id)`.
  - `run(id, mode)` takes `mode: "block" | "selection" | "all"`.
  - `blockAt(text: string, line: number): { start: number; end: number; text: string }`. It returns the lines around `line`
    bounded by blank lines (spec 6.2). On a blank line it returns the nearest block above.
  - `toKustoSchema(view: SchemaView)`: the `@kusto/monaco-kusto` `EngineSchema` with one database, `graph`, whose tables and
    columns carry descriptions. Dynamic columns are typed `dynamic`.

- [ ] **Step 1: Write the failing tests.**
  - `blockAt_returns_lines_between_blank_lines`.
  - `blockAt_on_blank_line_takes_block_above`.
  - `blockAt_single_block_returns_all`.
  - `toKustoSchema_maps_tables_columns_and_types`.
  - Tab strip:
    - `opening_a_tab_shows_source_badge_GR`;
    - `closing_dirty_tab_asks_to_confirm`;
    - `ctrl_enter_runs_block_shift_enter_runs_all`.
  - `run_status_shows_denied_columns_chip_with_names`: for a `RunResult` whose `tables[0].denied` is
    `["onPremisesPublishing"]` the chip reads `onPremisesPublishing: no permission, values empty`.
  - `run_status_too_large_shows_message`.
  - `run_status_sign_in_needed_shows_sign_in_button_and_keeps_text`.
  - `result_grid_virtualizes_10000_rows`: fewer than 100 row elements in the DOM.
  - `sign_in_defaults_to_azure_cli_and_disables_client_fields`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement,** following the Main and SignIn boards:
  - **Title bar:** the account pill with tenant name and user.
  - **Tab strip:** source badges, a dirty dot, `+`.
  - **Left panel:** the schema tree with search, and table and column descriptions on hover.
  - **Toolbar:** Run, Cancel, Format.
  - **Editor:** Monaco with monaco-kusto set to `toKustoSchema(schema)`. Nested-field completion is a completion provider calling
    `query.complete`.
  - **Status row:** run chips.
  - **Results:** a Rows tab (TanStack Table + Virtual: sort, filter, show a dynamic cell as JSON).
  - Plan 1 shows only the Rows tab. Chart, JSON and Diagnostics come in Plan 2.
  - **Sign-in screen** when there is no active account, and from the account pill otherwise. It has:
    - the Azure CLI or own-client choice;
    - device code;
    - the accounts list with Use and Sign out;
    - "What this sign-in can read" chips from `AccountInfo.Scopes`;
    - the memory-only token cache notice when `TokenCacheStatus` is `MemoryOnly`.
- [ ] **Step 4: Run** `npm test`, `npm run lint`, `npm run typecheck` and `npm run build`. Expected: all pass with 0 warnings.
- [ ] **Step 5: Commit.** `feat(kustodian): main window with tabs, KQL editor, schema panel and results grid`

### Task 11: End-to-end check on three platforms, and the CI workflow

**Files:**
- Create: `kustodian/.github/workflows/ci.yml`. It runs a matrix of `windows-latest`, `macos-latest` and `ubuntu-latest`:
  - setup .NET from `global.json` and Node 22;
  - on Ubuntu, `apt-get install libwebkit2gtk-4.1-dev libsecret-1-dev`;
  - `npm ci`, `npm run lint`, `npm run typecheck`, `npm test` and `npm run build` in `web/`;
  - `dotnet build -warnaserror` and `dotnet test`.
- Create: `kustodian/docs/manual-checks.md`, the spec 13 checklist with a column per platform. Plan 1 fills in only the rows it
  can.

- [ ] **Step 1: Run the full gate locally on macOS.** Run the web commands above, then `dotnet build -warnaserror` and
  `dotnet test`. Expected: all green, 0 warnings.
- [ ] **Step 2: Check on macOS against a real tenant.** Sign in with the Azure CLI client. Run `applications | where
  passwordCredentials has "endDateTime" | mv-expand c = passwordCredentials | where todatetime(c.endDateTime) < now() | project
  displayName, appId, c.endDateTime`. Then add `onPremisesPublishing` to the project and confirm the denied chip and that rows
  still return.
  - Record in `manual-checks.md`: monaco-kusto completion works in WKWebView, and no orphaned `Kustodian --engine` process
    remains after closing the window mid-run (check with `ps`).
- [ ] **Step 3: Repeat on Windows** using the Parallels VM (the `windows-vm` skill), and on Linux (Ubuntu LTS in a VM or
  container with a display).
  - Record whether monaco-kusto runs in WebKitGTK (spec 5, risk 2). If it doesn't, stop and report: the fallback (completion from
    the host over the bridge) becomes a task before Plan 2.
- [ ] **Step 4: Commit.** `ci(kustodian): three-platform build and test workflow, manual check list`
