# Kustodian Plan 2: Workbench Features Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** turn the Plan 1 window into a full workbench for Graph KQL. It adds:

- saved queries, recent runs and restored sessions;
- parameters, snippets and a command palette;
- `.kql` open, save and drop;
- results as rows, chart, JSON and diagnostics, with grid tools, row details, export and compare;
- Explain, a raw Graph request tab, settings, and light and dark themes.

**Architecture:** host and web split.

- **Host:** the host gains small services for user data. Each owns one versioned JSON file under `AppPaths.Root`. Each service has its own bridge handler.
- **Graph library:** gains configurable limits, Explain (the planner, plus pushdown reasons from the filter translator), and a per-run diagnostics log carried by a run id on every request.
- **Web:** gains a command registry, a result-panel abstraction, and new tab kinds. All user data goes through the bridge. The web uses no browser storage.

**Tech Stack:** the Plan 1 stack (.NET 10, Photino.NET 4.0.16, MSAL, Kusto.Language, KustoLoco, React 19, zustand 5, Monaco + monaco-kusto, TanStack Table and Virtual, Tailwind 4, Vitest, xUnit v3), plus **Recharts** for charts (spec 5).

**Spec:** `kustodian/docs/superpowers/specs/2026-10-21-kustodian-design.md`. This plan covers sections 6.2–6.6 and 6.8–6.11, plus section 9's settings. Mockups are in `kustodian/docs/mockups/`. This plan uses the Parameters, Explain, RawRequest, Diagnostics, Palette, Light and Main boards.

**Builds on Plan 1** (merged in FrodeHus/rightsecurity-insights#193). The existing interfaces are named in each task. Hunting and Azure Resource Graph come in Plan 3. Packaging and release come in Plan 4.

## Global Constraints

- Everything stays under `kustodian/`. Nothing references outside it.
- `dotnet build -warnaserror`, `npm run lint` and `npx tsc --noEmit` stay clean, with no suppressions.
  - The only open warnings allowed are the two in `kustodian/CLAUDE.md`: TanStack `react(incompatible-library)` in `result-grid.tsx`, and the Vite chunk size for Monaco.
  - New chunks (for example Recharts) must not add new warnings. Lazy-load them if needed.
- Tokens and `Authorization` headers are never logged, never written to disk outside the OS keychain, and never sent to a non-Microsoft host. Diagnostics and the raw request tab show request URLs, status and sizes, never tokens or request headers named `Authorization`.
- No network fetch from the UI, and no browser storage (`localStorage`, `sessionStorage`, IndexedDB). All user data lives in host files.
- User data files are JSON under `AppPaths.Root`. Each file has a `"version": 1` field, and writes are atomic (`JsonFileStore.WriteAsync`). Each file has exactly one owning service, and that service serialises its own access with a `SemaphoreSlim`. A corrupt file is moved aside (`JsonFileStore`), and the app starts with defaults and says so.
- **File locations** (spec 11):
  - `settings.json`
  - `saved/<id>.json`, one file per saved query
  - `snippets/<id>.json` for the user's own snippets
  - `recent.json`
  - `session.json`
- Saved queries, recent runs, snippets and the session are global, not per account (**My call**). Signing out removes no user data.
- Graph KQL tabs always use beta (spec 6.11). The raw tab's version comes from settings.
- Keyboard: every action is a command in the registry, and every command shows its shortcut in the palette (spec 6.11).
- UI look: tokens and class roles from `kustodian/docs/mockups/studio.css`, already in `web/src/styles.css`. The light theme uses the existing `.theme-light` class.
- Test names use underscore style. .NET tests use xUnit v3. Web tests use Vitest, colocated as `*.test.ts(x)`.

## Review Focus

1. **A saved query or session file written by hand or by an older version** (missing fields, unknown fields, a wrong type). It loads with defaults for what's missing, or that one entry is moved aside. The app never fails to start.
   Test: Task 2, `Library_skips_and_moves_aside_an_unreadable_query_file`. Task 3, `Session_with_missing_fields_restores_with_defaults`.
2. **A parameter value with quotes, backslashes, newlines or KQL syntax** (`a" or 1==1 //`). It becomes one escaped literal and can't change the query's structure.
   Test: Task 5, `Text_value_with_quotes_and_comment_is_one_literal`.
3. **Exporting 50,000 rows with dynamic columns, commas, quotes and newlines.** The file opens correctly in Excel with a decimal-comma locale and in a CSV parser, and no row is dropped.
   Test: Task 11, `Csv_escapes_quotes_commas_and_newlines` and `Excel_csv_uses_semicolon_and_bom_for_decimal_comma_locale`.
4. **Changing settings while a query runs.** The running query keeps the limits it started with. Limit changes apply on the next app start and the UI says so (**My call**). Theme applies at once.
   Test: Task 1, `Limits_are_read_once_at_startup`.
5. **A raw request to a path that tries to leave Graph** (`//evil.example/x`, `https://evil.example`, `..%2f`, a nextLink to another host). It is refused before sending, and no token leaves.
   Test: Task 8, `Path_that_leaves_graph_is_refused` and `Next_link_to_another_host_is_refused`.

---

## File structure

```
kustodian/src/Kustodian.Graph/
  Run/GraphLimits.cs              limits record, used by reader, batch reader and runner
  Run/RunDiagnostics.cs           per-run diagnostic log (entries) and the run id request option
  Query/GraphExplain.cs           Explain over the planner
  Query/FilterExplanation.cs      pushed vs local conditions with reasons
  Query/ParameterSubstitution.cs  {name} → KQL literal, with an offset map for error positions
kustodian/src/Kustodian/
  Storage/UserDataFile.cs         one versioned JSON file with a gate (wraps JsonFileStore)
  Settings/SettingsService.cs     settings.json
  Library/LibraryService.cs       saved/*.json, folders
  Library/RecentService.cs        recent.json (100)
  Session/SessionService.cs       session.json
  Snippets/SnippetService.cs      built-in snippets (embedded) plus snippets/*.json
  Snippets/builtin-snippets.json
  Files/IFileDialogs.cs, Files/PhotinoFileDialogs.cs   open/save dialogs
  Raw/RawRequestService.cs        GET-only raw Graph requests
  App/DiagnosticsHandler.cs       DelegatingHandler recording each request into the run's log
  Bridge/Handlers/SettingsHandler.cs LibraryHandler.cs SessionHandler.cs SnippetHandler.cs FileHandler.cs RawHandler.cs
                                  (QueryHandler gains explain, parameters, run id; AppHandler gains cache.clear)
kustodian/web/src/
  shell/commands.ts               command registry and global key handling
  shell/palette.tsx               command palette
  shell/theme.ts                  apply theme to <html>, follow the OS
  settings/settings-view.tsx
  side/side-panel.tsx             rail: Schema, Saved, Recent, Snippets
  side/saved-panel.tsx  side/recent-panel.tsx  side/snippet-panel.tsx
  params/find-params.ts  params/params-form.tsx
  library/save-dialog.tsx
  results/result-panel.tsx        result tabs: Rows, Chart, JSON, Diagnostics
  results/row-details.tsx  results/copy.ts  results/export.ts
  results/chart-view.tsx  results/chart-shape.ts
  results/compare-view.tsx  results/diff.ts
  results/diagnostics-view.tsx
  explain/explain-view.tsx
  raw/raw-tab.tsx  raw/to-datatable.ts
  session/session-sync.ts
```

---

### Task 1: Settings, configurable limits, cache clear and theme at startup

**Files:**
- Create: `src/Kustodian.Graph/Run/GraphLimits.cs`.
- Create: `src/Kustodian/Storage/UserDataFile.cs`.
- Create: `src/Kustodian/Settings/SettingsService.cs`.
- Create: `src/Kustodian/Bridge/Handlers/SettingsHandler.cs`.
- Modify: `GraphCollectionReader` (const `MaxObjects` → `GraphLimits.ObjectsPerTable`).
- Modify: `GraphBatchReader` (const `MaxObjects` → `PerObjectReadsPerTable`).
- Modify: `GraphRunner` (`MaxRows` → `RowsPerRun`).
- Modify: `MemoryGraphObjectCache` (TTL from limits).
- Modify: `AppHost.cs` (read settings once and build everything from them).
- Modify: `AppOrigin` (start URL gets `?theme=`).
- Modify: `AppHandler` (`cache.clear`).
- Test: `tests/Kustodian.Tests/Settings/SettingsServiceTests.cs`, `tests/Kustodian.Graph.Tests/Run/GraphLimitsTests.cs`, plus existing reader and runner tests updated.

**Interfaces:**
- Consumes: `JsonFileStore`, `AppPaths.Root`, `GraphRunner`, `GraphCollectionReader`, `GraphBatchReader`, `MemoryGraphObjectCache.Clear()` and `GraphEngineOptions` (all Plan 1).
- Produces:
  - `record GraphLimits(int ObjectsPerTable = 50_000, long FetchBudgetBytes = 512L << 20, int PerObjectReadsPerTable = 2_000, TimeSpan PerObjectCacheTtl = 30 min, int RowsPerRun = 50_000)`, with `static GraphLimits Default`.
    - The reader, batch reader and runner take it through their constructors.
    - The existing public constants stay as `GraphLimits.Default` values.
  - `UserDataFile<T>(JsonFileStore store, string relativePath, Func<T> defaults, Func<T, bool> isValid) where T : class`:
    - `Task<UserDataRead<T>> ReadAsync(ct)`;
    - `Task WriteAsync(T value, ct)`;
    - one `SemaphoreSlim` per instance.
    - Invalid or corrupt content is moved aside, and `Corrupt = true` is returned.
    - `record UserDataRead<T>(T Value, bool Corrupt)`.
  - `record AppSettings(int Version, string Theme, string RawDefaultVersion, SignInDefaults SignIn, LimitSettings Limits)`:
    - Theme is `"dark" | "light" | "system"`, default `"dark"`.
    - RawDefaultVersion is `"beta" | "v1.0"`, default `"beta"`.
    - `record SignInDefaults(string? ClientId, string? Tenant)`.
    - `record LimitSettings(int GraphObjectsPerTable, int FetchBudgetMb, int EngineTimeoutSeconds, int EngineHeapMb, int EngineWorkers, int PerObjectReadsPerTable, int PerObjectCacheMinutes, int GraphRowsPerRun)`, with spec 9 defaults: 50000, 512, 120, 1024, 2, 2000, 30, 50000.
  - Ranges. A value outside its range is refused with `bad_request`, and the message names the setting and its range:

    | Setting | Range |
    | --- | --- |
    | objects per table | 1,000–1,000,000 |
    | budget MB | 64–8,192 |
    | timeout s | 10–3,600 |
    | heap MB | 256–16,384 |
    | workers | 1–8 |
    | per-object reads | 0–20,000 |
    | cache minutes | 0–1,440 |
    | rows per run | 1,000–1,000,000 |

  - `SettingsService(JsonFileStore)`:
    - `Task<AppSettings> GetAsync(ct)`;
    - `Task<AppSettings> SetAsync(AppSettings value, ct)`, which validates, writes and returns the stored value;
    - `static GraphLimits ToGraphLimits(LimitSettings)`;
    - `static void Apply(LimitSettings, GraphEngineOptions)`.
  - Bridge methods:
    - `settings.get` → `{settings, limitsAppliedAt: "startup", restartNeeded: bool}`. `restartNeeded` is true when the stored limits differ from those the app started with.
    - `settings.set {settings}` → same shape.
    - `cache.clear` → `{}`.
  - `AppOrigin.For(bool windows, string theme)`: the start URL ends with `?theme=dark|light|system`. The web reads it before first paint (Task 9).

- [ ] **Step 1: Write the failing tests.**
  - `Settings_default_when_file_missing`.
  - `Settings_out_of_range_is_refused_with_named_setting`: workers 0 gives `bad_request` with the message "Engine workers must be between 1 and 8."
  - `Settings_round_trip_and_version_is_1`.
  - `Corrupt_settings_file_is_moved_aside_and_defaults_used`.
  - `Limits_are_read_once_at_startup`: build the host's services with settings A, change the stored settings to B, and assert the runner still uses A and `settings.get` says `restartNeeded: true`.
  - `Reader_uses_limits_object_cap`: limits with 1,000 objects stop at 1,000 with `TooManyObjects`.
  - `Batch_reader_uses_limits_per_object_cap`.
  - `Runner_caps_rows_at_limits_rows_per_run`.
  - `Cache_ttl_comes_from_limits`.
  - `Cache_clear_empties_object_cache`.
  - `Start_url_carries_theme` (AppOriginTests).
- [ ] **Step 2: Run them.** `dotnet test --solution kustodian/Kustodian.slnx`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Move AppHost's service wiring into `static AppServices AppServices.Build(AppSettings startup, …)` in `src/Kustodian/App/AppServices.cs`, so the startup-limits test can build it without a window.
  - AppHost reads settings once before calling it. `Build` creates the budget, cache, reader, runner and pool from those settings. Engine options get `Timeout`, `MemoryLimitBytes` and `Workers` from the settings.
  - `SettingsHandler` holds the startup `LimitSettings` to compute `restartNeeded`.
- [ ] **Step 4: Run them.** Expected: PASS, with 0 build warnings.
- [ ] **Step 5: Commit.** `feat(kustodian): settings, configurable limits, cache clear, theme in start URL`

### Task 2: Saved queries and recent runs

**Files:**
- Create: `src/Kustodian/Library/LibraryService.cs`, `src/Kustodian/Library/RecentService.cs` and `src/Kustodian/Bridge/Handlers/LibraryHandler.cs`.
- Modify: `QueryHandler.cs` (record each run in Recent).
- Test: `tests/Kustodian.Tests/Library/LibraryServiceTests.cs`, `RecentServiceTests.cs` and `tests/Kustodian.Tests/Bridge/LibraryHandlerTests.cs`.

**Interfaces:**
- Consumes: `UserDataFile<T>` and `JsonFileStore` (Task 1), and `QueryHandler`'s run path (Plan 1).
- Produces:
  - `record ParameterDef(string Name, string Type, string Value, bool Required, IReadOnlyList<string>? Choices)`. `Type` is `"text" | "number" | "timespan" | "datetime" | "list"`. Choices come from the Parameters mockup's "Choices" field.
  - `record SavedQuery(int Version, string Id, string Name, string? Folder, string Source, string Text, IReadOnlyList<ParameterDef> Parameters, DateTimeOffset CreatedAt, DateTimeOffset ModifiedAt)`.
    - Id is a GUID string, used as the file name `saved/<id>.json`.
    - Folder is at most one level: a non-empty name, or null. It has no `/`, and is 1–80 chars.
    - Name is 1–200 chars.
    - Text is at most 1 MB.
  - `LibraryService(JsonFileStore, TimeProvider)`:
    - `ListAsync(ct)` returns `LibraryList(IReadOnlyList<SavedQuery> Queries, IReadOnlyList<string> Folders, int Skipped)`.
    - `SaveAsync(SavedQueryInput, ct)` returns `SavedQuery`. It creates when the Id is null and updates otherwise. `CreatedAt` is kept and `ModifiedAt` is set to now.
    - `DeleteAsync(id, ct)`.
    - `record SavedQueryInput(string? Id, string Name, string? Folder, string Source, string Text, IReadOnlyList<ParameterDef> Parameters)`.
  - `record RecentRun(string Id, string Source, string Text, IReadOnlyDictionary<string,string> Parameters, DateTimeOffset StartedAt, long DurationMs, int Rows, string Outcome)`, kept in `recent.json` as `{version:1, runs:[…]}`, newest first, at most 100.
  - `RecentService(JsonFileStore)`:
    - `AddAsync(RecentRun, ct)`;
    - `ListAsync(ct)`;
    - `ClearAsync(ct)`.
  - Bridge methods:
    - `library.list` → `LibraryList`;
    - `library.save {query: SavedQueryInput}` → `SavedQuery`;
    - `library.delete {id}`;
    - `recent.list` → `{runs}`;
    - `recent.clear`.
  - `QueryHandler`, after every finished run (not cancelled), calls `RecentService.AddAsync`. A failure to write Recent is logged and never fails the run.

- [ ] **Step 1: Write the failing tests.**
  - `Save_creates_file_per_query_with_guid_name`.
  - `Save_update_keeps_created_and_bumps_modified` (with a FakeTimeProvider).
  - `Folder_with_slash_is_refused`.
  - `List_returns_folders_sorted_distinct`.
  - `Library_skips_and_moves_aside_an_unreadable_query_file`: one garbage file among two good ones lists two, `Skipped == 1`, and a `.corrupt` file exists.
  - `Delete_removes_file`.
  - `Recent_keeps_newest_100`.
  - `Finished_run_is_recorded_in_recent_but_cancelled_is_not` (QueryHandler with a fake run delegate).
  - `Recent_write_failure_does_not_fail_the_run`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** Register `LibraryHandler` in AppHost.
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat(kustodian): saved queries library and recent runs`

### Task 3: Session file and snippets

**Files:**
- Create: `src/Kustodian/Session/SessionService.cs` and `src/Kustodian/Snippets/SnippetService.cs`.
- Create: `src/Kustodian/Snippets/builtin-snippets.json`, embedded.
- Create: `Bridge/Handlers/SessionHandler.cs` and `SnippetHandler.cs`.
- Test: `tests/Kustodian.Tests/Session/SessionServiceTests.cs` and `tests/Kustodian.Tests/Snippets/SnippetServiceTests.cs`.

**Interfaces:**
- Consumes: `UserDataFile<T>` (Task 1), `ParameterDef` (Task 2), and `GraphQueryPlanner.Plan` and `GraphSchemaCatalog.Beta` (Plan 1), to validate the built-in snippets.
- Produces:
  - `record SessionTab(string Id, string Source, string Title, string Text, bool Dirty, string? SavedId, IReadOnlyList<ParameterDef> Parameters)`.
  - `record Session(int Version, string? ActiveId, IReadOnlyList<SessionTab> Tabs)`. It has at most 50 tabs and at most 1 MB of text per tab. Entries over a cap are dropped on save and the reply says so.
  - `SessionService(JsonFileStore)`:
    - `GetAsync(ct)` returns `UserDataRead<Session>`;
    - `SaveAsync(Session, ct)`.
  - `record Snippet(string Id, string Source, string Name, string Description, string Text, bool BuiltIn, string? Group)`.
  - `SnippetService(JsonFileStore)`:
    - `ListAsync(ct)` returns `IReadOnlyList<Snippet>`, built-in first;
    - `SaveAsync(SnippetInput, ct)` returns `Snippet`;
    - `DeleteAsync(id, ct)`. Built-in snippets can't be deleted: `bad_request`.
  - Built-in Graph snippets (spec 6.4), each with name, description, group "Identity checks", and text that plans without error against `GraphSchemaCatalog.Beta`:
    - "Expired app credentials"
    - "Passthru apps" (`onPremisesPublishing.externalAuthenticationType == "passthru"`)
    - "Stale guests" (`signInActivity` older than `{days}`)
    - "Risky service principals"
    - "Apps with owners outside the tenant"

    Hunting and ARG snippets come in Plan 3.
  - Bridge methods:
    - `session.get` → `{session, corrupt}`;
    - `session.save {session}` → `{dropped: int}`;
    - `snippets.list` → `{snippets}`;
    - `snippets.save {snippet}`;
    - `snippets.delete {id}`.

- [ ] **Step 1: Write the failing tests.**
  - `Session_round_trip`.
  - `Session_with_missing_fields_restores_with_defaults`: a JSON file with tabs that lack `parameters` and `savedId` loads, with empty parameters and a null savedId.
  - `Session_over_tab_cap_drops_and_reports`.
  - `Builtin_graph_snippets_all_plan_without_error`: each built-in Graph snippet, with its parameters substituted by their defaults through `ParameterSubstitution` (Task 5), gets `Plan(...).Error == null`.
    - This depends on Task 5. Write it in Task 3 against raw text with no placeholders, and extend it in Task 5.
  - `Builtin_snippet_cannot_be_deleted`.
  - `User_snippet_round_trip`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat(kustodian): session file and snippets with a built-in Graph library`

### Task 4: File dialogs: open and save .kql, and export

**Files:**
- Create: `src/Kustodian/Files/IFileDialogs.cs`, `PhotinoFileDialogs.cs` and `Bridge/Handlers/FileHandler.cs`.
- Test: `tests/Kustodian.Tests/Files/FileHandlerTests.cs`.

**Interfaces:**
- Produces:
  - `interface IFileDialogs`:
    - `Task<string?> OpenAsync(string title, IReadOnlyList<FileFilter> filters)`;
    - `Task<string?> SaveAsync(string title, string suggestedName, IReadOnlyList<FileFilter> filters)`.
  - `record FileFilter(string Name, IReadOnlyList<string> Extensions)`.
  - `PhotinoFileDialogs(PhotinoWindow)` uses Photino 4.0.16's open and save file dialogs. Verify the exact API in the package.
  - Bridge methods:
    - `file.open {filters}` → `{path, name, text} | null`. Files over 5 MB are refused with the message "Files over 5 MB can't be opened." Text must be UTF-8 (a BOM is stripped).
    - `file.saveAs {suggestedName, filters, content, path?}` → `{path, name} | null`. A null result means the dialog was cancelled. When `path` is given and still exists, the file is written there without a dialog; that is Save on a tab that came from a file. The content limit is 200 MB.
  - The write is atomic: a temp file next to the target, then a rename.

- [ ] **Step 1: Write the failing tests.**
  - `Open_returns_text_and_name` (with a fake `IFileDialogs` and a temp directory).
  - `Open_cancelled_returns_null`.
  - `Open_over_5mb_is_refused`.
  - `Save_with_existing_path_skips_dialog`.
  - `Save_cancelled_returns_null`.
  - `Save_is_atomic_and_overwrites`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat(kustodian): native open and save dialogs for .kql and exports`

### Task 5: Parameters in the host

**Files:**
- Create: `src/Kustodian.Graph/Query/ParameterSubstitution.cs`.
- Modify: `QueryHandler` (`query.run` gains `parameters`).
- Modify: `GraphRunner`, which takes the substituted text and maps error positions back.
- Test: `tests/Kustodian.Graph.Tests/Query/ParameterSubstitutionTests.cs` and a runner test.

**Interfaces:**
- Consumes: `ParameterDef` (Task 2). Its shape is duplicated as `ParameterValue(Name, Type, Value, Required)` in Kustodian.Graph, which can't reference the host.
- Produces:
  - `static IReadOnlyList<string> ParameterSubstitution.Find(string kql)`: placeholder names in order of first use.
    - A placeholder is `{name}` with name `[A-Za-z_][A-Za-z0-9_]*`. Placeholders are not recognised inside string literals or `//` comments.
  - `static SubstitutionResult Apply(string kql, IReadOnlyList<ParameterValue> values)`, returning `SubstitutionResult(string? Text, string? Missing, ParameterError? Error, Func<int,int,(int Line,int Column)> MapBack)`.
    - `Missing` names the first required parameter with an empty value.
    - `Error` is set for an unparsable value. Its message is the type's rule, for example "withinDays: a timespan like 7d, 12h or 30m."
    - `MapBack` maps a 1-based line and column in the substituted text to the original text.
  - Literal rules:
    - **text:** a double-quoted KQL string with `\` and `"` escaped, and newlines as `\n`.
    - **number:** must parse invariantly as long or double. It is emitted invariantly.
    - **timespan:** `^\d+(\.\d+)?(d|h|m|s|ms)$`, emitted as is.
    - **datetime:** ISO 8601, emitted as `datetime(<iso>)`.
    - **list:** one value per line. Each value is a text literal, or a number when every line parses as a number.
      - Emitted as `("a", "b")` when the placeholder directly follows `in`, `in~`, `!in` or `!in~` (ignoring whitespace and an opening `(` that the user wrote).
      - Otherwise emitted as `dynamic(["a", "b"])`.
  - `query.run {tabId, source, kql, refresh, parameters?: ParameterValue[]}`:
    - A missing required parameter gives outcome `QueryError` with the message "Fill in {name} before running." and no position.
    - The runner's `QueryError` positions go through `MapBack`.
    - Recent stores the parameter values.

- [ ] **Step 1: Write the failing tests.**
  - `Find_ignores_strings_and_comments`.
  - `Text_value_with_quotes_and_comment_is_one_literal`: the value `a" or 1==1 //` becomes `"a\" or 1==1 //"`, and the substituted query plans with the same table and structure.
  - `List_after_in_is_tuple_otherwise_dynamic`.
  - `Timespan_rejects_bad_value_with_rule_message`.
  - `Datetime_emits_datetime_literal`.
  - `Missing_required_names_it`.
  - `Error_position_maps_back_to_original` (an error after a long substituted value).
  - Extend Task 3's `Builtin_graph_snippets_all_plan_without_error` to substitute defaults.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat(kustodian): query parameters substituted as safe KQL literals`

### Task 6: Explain

**Files:**
- Create: `src/Kustodian.Graph/Query/FilterExplanation.cs` and `GraphExplain.cs`.
- Modify: `GraphFilterTranslator` (add `Explain`, which returns reasons; `Translate` keeps its behaviour and is built on `Explain`).
- Modify: `QueryHandler` (`query.explain`).
- Test: `tests/Kustodian.Graph.Tests/Query/GraphExplainTests.cs` and `FilterExplanationTests.cs`.

**Interfaces:**
- Consumes: `GraphQueryPlanner.Plan`, `GraphFetch` (`Select`, `Filter`, `Unreadable`, `Named`), `GraphTable` (`Permissions`, `DocsUrl`), `GraphLimits` (Task 1) and `ParameterSubstitution` (Task 5).
- Produces:
  - `record LocalCondition(string Condition, string Reason)`.
  - `record FilterExplanation(string? Filter, IReadOnlyList<string> Pushed, IReadOnlyList<LocalCondition> Local)`.
  - `static FilterExplanation GraphFilterTranslator.Explain(GraphTable, IReadOnlyList<Expression> leadingWherePredicates, DateTimeOffset now)`.
  - Reasons are exact copy, one per spec 7.4 rule:
    - "Graph doesn't allow this operator on {column}"
    - "Case-insensitive comparison only goes to Graph for directory objects"
    - "Graph needs advanced queries for ne and null checks on directory objects"
    - "Graph would drop rows for an empty string"
    - "isnotnull on text isn't sent to Graph"
    - "not() is never sent to Graph"
    - "One side of this or can't be sent to Graph"
    - "Not part of a leading where"
  - `record ExplainTable(string Table, string Url, IReadOnlyList<string> Select, string? Filter, IReadOnlyList<string> Pushed, IReadOnlyList<LocalCondition> Local, IReadOnlyList<string> PerObject, IReadOnlyList<string> Permissions, string DocsUrl)`. `Url` is the exact first-page URL the reader would send, relative to beta.
  - `record ExplainView(GraphQueryError? Error, string? Refusal, IReadOnlyList<ExplainTable> Tables, ExplainLimits Limits)`.
  - `record ExplainLimits(int ObjectsPerTable, int FetchBudgetMb, int PerObjectReadsPerTable)`.
  - `static ExplainView GraphExplain.Explain(GraphSchema, string kql, DateTimeOffset now, GraphLimits)`.
  - Bridge: `query.explain {source, kql, parameters?}` → `ExplainView`. It makes no network call and needs no account.

- [ ] **Step 1: Write the failing tests.**
  - `Explain_url_matches_what_reader_sends`: for a query, `ExplainTable.Url` equals the first request the reader sends to a FakeGraph.
  - `Explain_lists_pushed_and_local_with_reason`, one theory case per reason above.
  - `Translate_unchanged_by_explain_refactor`: the existing translator tests stay green.
  - `Explain_marks_per_object_columns` (`onPremisesPublishing`).
  - `Explain_returns_error_with_position`.
  - `Explain_needs_no_account` (bridge test with no active account).
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat(kustodian): explain what a Graph query would send, with pushdown reasons`

### Task 7: Run ids and diagnostics

**Files:**
- Create: `src/Kustodian.Graph/Run/RunDiagnostics.cs` and `src/Kustodian/App/DiagnosticsHandler.cs`.
- Modify:
  - `GraphRunner`: create a `RunDiagnostics` per run, put `RunId` and `Diagnostics` on `RunResult`, and tag requests.
  - `GraphCollectionReader` and `GraphBatchReader`: tag requests with the run id; record probe steps and cache hits.
  - `GraphEnginePool`: an optional `IProgress<EngineRunInfo>`.
  - `GraphHttp`: add `DiagnosticsHandler` inside `GraphAuthHandler`, so it sees the final status but never the token. It reads only the request URL and method, and never headers.
  - `QueryHandler`: `query.progress` gains `runId`.
  - `RunResultConverter`: emit `runId` and `diagnostics`.
- Test: `tests/Kustodian.Graph.Tests/Run/RunDiagnosticsTests.cs` and `tests/Kustodian.Tests/App/DiagnosticsHandlerTests.cs`.

**Interfaces:**
- Produces:
  - `record DiagnosticEntry(long AtMs, string Kind, string Detail, int? Status, long? DurationMs, long? Bytes)`.
    - `Kind` is `"request" | "retry" | "throttled" | "probe" | "per-object" | "cache" | "engine"`.
    - `Detail` for a request is `"GET applications?$select=…"`: method and relative URL only.
  - `sealed class RunDiagnostics(TimeProvider)`:
    - `string RunId`, a GUID;
    - `void Add(DiagnosticEntry)`, thread-safe;
    - `IReadOnlyList<DiagnosticEntry> Entries`, in time order;
    - capped at 5,000 entries, after which one final entry says "… more entries not shown".
  - `static HttpRequestOptionsKey<RunDiagnostics> RunDiagnostics.Key` and `request.ForRun(diagnostics)`.
  - `record EngineRunInfo(string Event, int WorkerPid, long? PeakBytes, string? Reason)`, with Event `"start" | "done" | "killed"`.
  - `RunResult` gains `string RunId` and `IReadOnlyList<DiagnosticEntry> Diagnostics`, both at the end with defaults.
  - `RunEvent` gains `string RunId`. Progress events become `{tabId, runId, stage, detail}`.

- [ ] **Step 1: Write the failing tests.**
  - `Every_request_is_logged_with_status_duration_and_bytes`.
  - `Retry_after_is_logged_as_throttled_then_retry`.
  - `Probe_steps_are_logged_with_dropped_columns`.
  - `Per_object_batch_and_cache_hits_are_logged`.
  - `Engine_start_and_kill_are_logged`, using the memory-kill query from the Plan 1 pool tests.
  - `Diagnostics_never_contain_authorization_or_token`: the bearer token string appears in no entry.
  - `Entries_cap_at_5000`.
  - `Progress_events_carry_run_id`.
  - `Run_result_wire_has_run_id_and_diagnostics` (bridge test).
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat(kustodian): run ids and a per-run diagnostics log`

### Task 8: Raw Graph requests

**Files:**
- Create: `src/Kustodian/Raw/RawRequestService.cs` and `Bridge/Handlers/RawHandler.cs`.
- Test: `tests/Kustodian.Tests/Raw/RawRequestServiceTests.cs`.

**Interfaces:**
- Consumes: the Graph `HttpClient` from `GraphHttp.CreateClient` (pass it into the service from AppHost), `ForAccount` (Plan 1) and `AccountService.ActiveAccountKey`.
- Produces:
  - `RawRequestService(HttpClient graph)`:
    - `Task<RawResponse> SendAsync(string accountKey, string version, string path, IReadOnlyDictionary<string,string> headers, ct)`;
    - `Task<RawResponse> NextAsync(string accountKey, string nextLink, ct)`.
  - `record RawResponse(int Status, IReadOnlyDictionary<string,string> Headers, string Body, long DurationMs, string? NextLink, bool Truncated)`.
  - Rules:
    - GET only.
    - `version` is `"beta"` or `"v1.0"`.
    - `path` is relative. It is refused if it is absolute, starts with `/` or `\`, contains `..` after percent-decoding, or contains `://`.
    - The URL is built as `https://graph.microsoft.com/{version}/{path}`.
    - User headers: `Authorization`, `Host` and `Cookie` are refused (case-insensitive). Others are passed, at most 20 headers and 8 KB in total.
    - The body is capped at 10 MB (`Truncated = true` past that).
    - A `nextLink` must be absolute https on `graph.microsoft.com`.
    - Response headers exclude `Set-Cookie`.
  - Bridge methods:
    - `raw.send {version, path, headers}` → `RawResponse`. A missing account gives a `signInNeeded` BridgeException.
    - `raw.next {nextLink}` → `RawResponse`.

- [ ] **Step 1: Write the failing tests.**
  - `Get_builds_graph_url_for_version`.
  - `Path_that_leaves_graph_is_refused`: a theory over `//evil.example/x`, `https://evil.example`, `..%2fme`, `/me` and `\\x`. Each gives `bad_request`, and the FakeGraph sees no request.
  - `Authorization_header_is_refused`.
  - `Next_link_to_another_host_is_refused`.
  - `Body_over_10mb_is_truncated`.
  - `Request_carries_account_key`: GraphAuthHandler sees the key.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat(kustodian): raw Graph GET requests with path and header guards`

### Task 9: Web foundation: tab store, session sync, theme, commands and palette

**Files:**
- Modify: `web/src/tabs/tab-store.ts`, `web/src/wire.ts`, `web/src/bridge.mock.ts`, `web/src/app.tsx` and `web/src/editor/kql-editor.tsx` (light theme, palette keys).
- Create: `web/src/session/session-sync.ts`, `web/src/shell/theme.ts`, `web/src/shell/commands.ts` and `web/src/shell/palette.tsx`.
- Test: a test beside each file.

**Interfaces:**
- Consumes: `session.get` and `session.save` (Task 3), `settings.get` and `settings.set` (Task 1), `library.list` and `snippets.list` (Tasks 2–3), and Plan 1's `useTabs`, `call` and `on`.
- Produces:
  - `type Source = 'graph' | 'hunting' | 'arg' | 'raw'`. `'raw'` is the raw request tab (Task 12).
  - Tab changes:
    - `Tab` gains `savedId?: string`, `filePath?: string`, `parameters: ParameterDef[]`, `pinned?: RunResult` and `history: RunResult[]` (at most 5, newest first).
    - Tab ids are `crypto.randomUUID()`.
  - New store actions:
    - `openWith({source, title, text, savedId?, filePath?, parameters?}): string`;
    - `restore(session)`;
    - `setTitle(id, title)`;
    - `markSaved(id, {savedId?, filePath?, title})`, which clears `dirty`;
    - `setParameters(id, params)`;
    - `pin(id)`;
    - `unpin(id)`.
  - `run(id, mode, opts?: {refresh?: boolean})` sends `parameters` with the run. The progress handler ignores events whose `runId` isn't the tab's current run.
  - `startSessionSync(): () => void`. It loads the session at start, falls back to one empty Graph tab, and saves 1 s after any tab change (debounced). It also saves on `pagehide`. Unsaved text is restored (spec 6.1).
  - `applyTheme(theme: 'dark'|'light'|'system')`:
    - toggles `theme-light` on `<html>`;
    - for `system`, follows `matchMedia('(prefers-color-scheme: light)')` with a change listener;
    - switches Monaco between `kustodian-dark` and `kustodian-light`. The light token colours come from `.theme-light` in `studio.css`, as hex values.
    - The initial theme is read from `location.search` (`?theme=`) in `main.tsx` before React renders.
    - The footer shows the active theme instead of the hard-coded "Dark".
  - `type Command = {id: string; title: string; shortcut?: string; group: string; run: () => void; enabled?: () => boolean}`.
  - Command registry:
    - `registerCommands(cmds): () => void`;
    - `allCommands()`;
    - `runCommand(id)`;
    - `bindGlobalKeys(): () => void`, one keydown listener for shortcuts outside Monaco.
    - Monaco binds the same shortcuts with `editor.addCommand` through `bindRunKeys`'s pattern.
  - Commands this task registers: palette (`Ctrl/⌘ K` and `Ctrl/⌘ Shift P`), new Graph tab (`Ctrl/⌘ T`, moved from TabStrip), close tab, next and previous tab, run block, run all, cancel, run without cache, format, theme dark, light and system, clear cache.
  - Later tasks register their own commands.
  - `Palette`, following the Palette mockup:
    - fuzzy subsequence match over commands, saved queries and snippets;
    - arrow keys and Enter;
    - Esc closes it;
    - groups are shown, and each row shows its shortcut;
    - choosing a saved query opens it in a new tab, and choosing a snippet inserts it at the cursor (Shift+Enter opens it in a new tab).

- [ ] **Step 1: Write the failing tests.**
  - Tab store:
    - `openWith_sets_text_title_and_not_dirty`;
    - `restore_recreates_tabs_and_active`;
    - `markSaved_clears_dirty`;
    - `stale_progress_from_superseded_run_is_ignored`;
    - `run_sends_parameters_and_refresh`;
    - `history_keeps_5_newest`.
  - Session sync:
    - `session_sync_debounces_saves_1s`;
    - `session_restore_falls_back_to_one_tab`.
  - Theme:
    - `theme_system_follows_media_query`;
    - `initial_theme_from_query_string`.
  - Commands and palette:
    - `palette_filters_by_subsequence_and_runs_on_enter`;
    - `palette_lists_shortcuts`;
    - `global_keys_run_registered_command`.
- [ ] **Step 2: Run them.** `npm --prefix kustodian/web test`. Expected: FAIL.
- [ ] **Step 3: Implement.** Extend `bridge.mock.ts` for every new method. Extend `app.test.tsx`'s bridge mock `on` for `query.progress` with `runId`.
- [ ] **Step 4: Run the checks.** Test, lint (only the known warning), typecheck and build. Expected: all pass.
- [ ] **Step 5: Commit.** `feat(kustodian): session restore, themes, command registry and palette`

### Task 10: Side panels, saving, files and the parameters form

**Files:**
- Create: `web/src/side/side-panel.tsx`, `saved-panel.tsx`, `recent-panel.tsx` and `snippet-panel.tsx`.
- Create: `web/src/library/save-dialog.tsx`, `web/src/params/find-params.ts` and `web/src/params/params-form.tsx`.
- Modify: `app.tsx`, which replaces the hard-coded Schema rail.
- Test: a test beside each file.

**Interfaces:**
- Consumes:
  - `library.*`, `recent.*`, `snippets.*` (Tasks 2–3), `file.open` and `file.saveAs` (Task 4);
  - `openWith`, `markSaved` and `setParameters` (Task 9);
  - `KqlEditorHandle.insert` (Plan 1).
- Produces:
  - Rail buttons Schema, Saved, Recent and Snippets, with `aria-pressed` on the active one. The side panel shows the chosen one.
  - **Saved panel:** folders as collapsible groups, search, open on click, and rename and delete from a row menu (delete asks first).
  - **Recent panel:** newest first, showing outcome, rows and when. Clicking opens the run in a new tab with its parameters. It has a "Clear recent" button.
  - **Snippets panel**, following the Parameters mockup's left side:
    - built-in groups, then "Mine";
    - click inserts at the cursor, and the row menu has "Open in new tab";
    - a "Save the selection as a snippet" button.
  - **Commands:**
    - Save (`Ctrl/⌘ S`): a tab from the library updates its saved query, a tab from a file writes the file, and a new tab opens the save dialog;
    - Save as (`Ctrl/⌘ Shift S`);
    - Open .kql (`Ctrl/⌘ O`);
    - Save to file;
    - show Saved, Recent and Snippets.
  - **Drop:** dropping a `.kql` file on the window opens it in a new tab (through FileReader).
  - **Save dialog:** name, folder (pick an existing one or type a new one), and "Save to library" or "Save to file".
  - `findParams(text): string[]` mirrors the host's `Find`: same rules, and a shared fixture test file keeps them in agreement.
  - **ParamsForm**, following the Parameters mockup:
    - a field per parameter with name and type, a type picker, and Choices (one per line);
    - a "Required" checkbox;
    - "The query as it will run" preview, a client-side substitution for display only (the host substitutes for real);
    - "Run with these values";
    - "Remember as defaults for this query", which saves the parameters with the saved query.
    - The toolbar shows "Parameters · N" when the query has placeholders.

- [ ] **Step 1: Write the failing tests.**
  - `rail_switches_panels_and_marks_pressed`.
  - `saved_open_creates_tab_from_query`.
  - `save_on_library_tab_updates_without_dialog`.
  - `save_on_new_tab_opens_dialog`.
  - `recent_click_opens_with_parameters`.
  - `snippet_click_inserts_at_cursor`.
  - `drop_kql_opens_tab`.
  - `find_params_matches_host_fixture` (the fixture file `web/src/params/find-params.fixture.json`, also read by a .NET test).
  - `params_form_shows_preview_and_runs`.
  - `toolbar_shows_parameter_count`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** Add a .NET test `Find_matches_shared_fixture` reading the same JSON (copy it into the test project at build time, or reference it with a relative path inside `kustodian/`).
- [ ] **Step 4: Run the checks.** The web checks and the .NET tests. Expected: all pass.
- [ ] **Step 5: Commit.** `feat(kustodian): saved, recent and snippet panels, save and open, parameters form`

### Task 11: Results: tabs, grid tools, row details, copy, export, chart and compare

**Files:**
- Create: `web/src/results/result-panel.tsx`, `row-details.tsx`, `copy.ts`, `export.ts`, `chart-shape.ts`, `chart-view.tsx`, `diff.ts`, `compare-view.tsx` and `diagnostics-view.tsx`.
- Modify: `result-grid.tsx`, `run-status.tsx`, `app.tsx` and `package.json` (add `recharts`).
- Test: a test beside each file.

**Interfaces:**
- Consumes: `RunResult` with `runId` and `diagnostics` (Task 7), `file.saveAs` (Task 4), and `pin` and `unpin` (Task 9).
- Produces:
  - **`ResultPanel({result, pinned})`.** Tabs are Rows, Chart, JSON and Diagnostics, with Compare added when the tab has a pinned run. Tabs use `role=tab`, roving arrow keys and `aria-controls`.
  - **ResultGrid gains:**
    - column hide and reorder through a columns menu (TanStack visibility and ordering);
    - group by a column (TanStack grouping, groups collapsible);
    - row selection: click, Shift-click a range, `Ctrl/⌘`-click to toggle;
    - `onOpenRow(index)` on double-click or Enter;
    - a copy menu: cells or rows as CSV, Markdown or JSON.
  - **`RowDetails({columns, row, onClose})`:** a side sheet (Palette mockup) showing every column, with dynamic values expanded as formatted JSON and a copy button per value.
  - **`toCsv(columns, rows, {separator, bom})`, `toMarkdown(...)` and `toJson(...)`:**
    - CSV follows RFC 4180: fields with separator, quote, CR or LF are quoted and quotes doubled. Dynamic values are compact JSON strings. Line ends are CRLF.
    - Excel CSV uses a UTF-8 BOM, and `;` as separator when `new Intl.NumberFormat().format(1.5)` contains `,`.
    - Markdown escapes `|` and newlines.
    - JSON is an array of objects keyed by column name.
  - **Export commands:** CSV, Excel CSV, JSON and Markdown. Each goes through `file.saveAs` with the suggested name `<tab title>.<ext>` and writes every row returned.
  - **`chartShape(columns, rows, renderHint?)`** returns `ChartSpec {type: 'column'|'bar'|'line'|'area'|'pie'|'timechart'; x: string; series: string[]} | null`.
    - `renderHint` comes from `/\|\s*render\s+(\w+)/i` on the last line that contains it. The map is `columnchart→column`, `barchart→bar`, `linechart→line`, `areachart→area`, `piechart→pie` and `timechart→timechart`.
    - With no hint:
      - a datetime column and numeric column(s) give a timechart;
      - one string and one numeric column give column when there are 20 rows or fewer, and bar otherwise;
      - otherwise null, and the Chart tab says "This result has no shape to chart: it needs a text or date column and a number column."
  - **ChartView:** Recharts, lazy-loaded, with a type picker that overrides the shape. Colours come from CSS tokens.
  - **`diffRows(a, b, keyColumn)`** returns `{added, removed, changed: {key, columns: string[]}[]}`. Compare shows two grids side by side, or the diff as a table with added rows in `--ok`, removed in `--bad` and changed cells marked. The key column is picked from the common columns.
  - **RunStatus status line:** rows (`total` when more than shown: "50,000 of 61,204 rows"), duration, requests sent (the sum of `tables[].requests.length`) and cached objects (the sum of `perObjectCached`).
  - **DiagnosticsView** (Diagnostics mockup): entries as a virtualized list, with kind badges and a "Copy as text" button. The text format is one line per entry: `+{atMs}ms {kind} {status?} {detail} {durationMs?}ms {bytes?}B`.

- [ ] **Step 1: Write the failing tests.**
  - `Csv_escapes_quotes_commas_and_newlines`.
  - `Excel_csv_uses_semicolon_and_bom_for_decimal_comma_locale` (stub `Intl.NumberFormat`).
  - `Markdown_escapes_pipes`.
  - `Json_export_keys_by_column`.
  - `Export_writes_all_50000_rows` (a fake `file.saveAs`, then count the lines).
  - `chart_shape_uses_render_hint`.
  - `chart_shape_timechart_for_datetime_and_number`.
  - `chart_shape_null_explains`.
  - `diff_rows_added_removed_changed`.
  - `grid_hides_and_reorders_columns`.
  - `grid_groups_by_column`.
  - `grid_shift_click_selects_range_and_copies_csv`.
  - `row_details_expands_dynamic`.
  - `status_line_shows_total_requests_and_cache`.
  - `diagnostics_copy_text_format`.
  - `result_tabs_roving_keys`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** Recharts is lazy-loaded so it doesn't grow the main chunk. Confirm the build adds no new chunk-size warning.
- [ ] **Step 4: Run the checks.** The web checks. Expected: all pass, with only the two known warnings.
- [ ] **Step 5: Commit.** `feat(kustodian): result tabs, grid tools, row details, export, chart, compare and diagnostics`

### Task 12: Explain view, raw request tab and settings

**Files:**
- Create: `web/src/explain/explain-view.tsx`, `web/src/raw/raw-tab.tsx`, `web/src/raw/to-datatable.ts` and `web/src/settings/settings-view.tsx`.
- Modify: `tab-strip.tsx` (the `+` menu gains "Raw Graph request"), `app.tsx` and `title-bar.tsx` (settings button).
- Test: a test beside each file.

**Interfaces:**
- Consumes: `query.explain` (Task 6), `raw.send` and `raw.next` (Task 8), `settings.*` and `cache.clear` (Task 1), `openWith` (Task 9) and `SchemaView` (Plan 1).
- Produces:
  - **Explain command** (`Ctrl/⌘ E`) and toolbar button. It is shown on Graph tabs.
  - **`ExplainView`** (Explain mockup), per table:
    - the URL, copyable;
    - `$select` chips and the `$filter`;
    - a "Sent to Graph" list and a "Runs locally" list with reasons;
    - per-object columns, and permissions with a docs link;
    - the limits footer.
    - It shows the error and its position, or the refusal, when there is one.
  - **`RawTab`** (RawRequest mockup), for tabs with `source: 'raw'`:
    - version select (default from settings), a path input with schema completion of entity sets and properties, and a headers editor;
    - Send;
    - the response: status, duration, headers, and the body as formatted JSON (collapsible);
    - "Next page" when there is a `nextLink`;
    - "Open array as KQL tab" on any JSON array in the body.
    - The tab text is the path. The headers are saved in the session.
  - **`toDatatable(name, array, maxRows = 5000)`** returns `{kql, truncated}`:
    - columns are the union of object keys in order of first appearance;
    - types are inferred per column: long, real, bool, datetime when the value is ISO 8601, otherwise string, and dynamic for objects and arrays;
    - the output is `let {name} = datatable(col:type, …) [ … ];\n{name}`;
    - values are escaped as KQL literals.
    - It opens a Graph tab, which runs on the local engine with no Graph fetch because it names no Graph tables.
  - **`SettingsView`** (`Ctrl/⌘ ,`):
    - theme (applies at once);
    - the raw request default version;
    - default sign-in client ID and tenant;
    - limits with their ranges, and a notice "Limits apply the next time Kustodian starts." when `restartNeeded`;
    - a "Clear cached Graph objects" button;
    - validation errors from the host shown beside the field.
    - The sign-in screen (Plan 1's `SignIn`) pre-fills "My own app registration" from the default client ID and tenant when they are set.

- [ ] **Step 1: Write the failing tests.**
  - `explain_view_shows_pushed_and_local_reasons`.
  - `explain_shows_error_position`.
  - `raw_tab_sends_and_shows_status_and_json`.
  - `raw_next_page_appends`.
  - `raw_path_completion_offers_entity_sets`.
  - `to_datatable_infers_types_and_escapes`.
  - `to_datatable_truncates_at_5000`.
  - `open_array_as_kql_tab_creates_graph_tab`.
  - `settings_shows_restart_notice_and_validation_error`.
  - `sign_in_prefills_default_client`.
  - `theme_change_applies_immediately`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the checks.** Web, then the .NET suite. Expected: all pass.
- [ ] **Step 5: Commit.** `feat(kustodian): explain view, raw request tab and settings`

### Task 13: End-to-end check and manual checklist

**Files:**
- Modify: `kustodian/docs/manual-checks.md`. Add rows for each Plan 2 feature, with a column per platform.

- [ ] **Step 1: Run the full gate on macOS.**
  - Web: lint (only the known warning), typecheck, test and build (only the known chunk warning).
  - .NET: `dotnet build -warnaserror` and `dotnet test`.
  - Expected: all pass.
- [ ] **Step 2: Launch on macOS.** Screenshot only the Kustodian window and record each check:
  - Restart with two unsaved tabs, and confirm both come back.
  - Theme light, dark and system.
  - The palette opens with `⌘ K`.
  - Save a query, restart, and open it from Saved.
  - Run a snippet that needs no Graph data (for example a `datatable` snippet), or record "owner" for snippets that need a tenant.
  - Explain a query, which needs no sign-in.
  - Open and save a `.kql` file through the dialogs.
  - Settings validation, and the restart notice.
  - Never press Run against the owner's cached account. Graph-data rows stay "owner".
- [ ] **Step 3: Windows (Parallels VM, `windows-vm` skill).** Run the build and tests, then launch and check theme, palette, Explain and the file dialogs. Linux: build and test in the Ubuntu container. Record each result.
- [ ] **Step 4: Commit.** `docs(kustodian): manual checks for the workbench features`
