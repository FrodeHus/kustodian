# Community Solutions, plan 1: catalog, install, uninstall — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `Solutions/` in this repo holds solutions of saved queries and workbooks that CI validates. The app lists the
catalog from `main` in a **Solutions** rail panel, shows a solution's README and items, installs the ticked items into a
library folder named after the solution with provenance recorded, and uninstalls them, asking about the ones the user
changed.

**Architecture:**

- **Host owns everything that touches the network or the disk.** `SolutionService` fetches `index.json` and item files from
  `raw.githubusercontent.com`, checks each file's SHA-256 against the index, caches the index, keeps `solutions.json`, and
  installs through `LibraryService` and `WorkbookService` so their validation applies. `SolutionHandler` exposes
  `solution.*`. The web side never sees a URL or writes an item itself.
- **The rules are shared code.** `SolutionRules` (manifest and id checks) and `SolutionHash` (canonical content hashes) are
  used by the app and by the repo test that is CI's validation job, so the app refuses anything CI would.
- **The index is checked, not committed by a bot.** A test rebuilds `Solutions/index.json` with `SolutionIndex.Build` and
  fails when it differs, telling the author how to regenerate it. This settles spec §11's "how the index job commits":
  no bot commits to `main`.
- **Web:** `web/src/solutions/` — a rail panel (list, search, filters) and one dialog (README, items, Install / Uninstall).
- **Not in this plan:** updates and the library's "from" / "modified" markers (plan 2); tools, requirements and Grant
  permissions (plan 3). Until plan 3, a solution's `tools.json` and `requires` are validated by CI but not shown or
  installed.

**Tech Stack:** .NET 10, xUnit v3, `Microsoft.Azure.Kusto.Language` (already referenced), React 19 + TypeScript, zustand,
Vitest + Testing Library, oxlint. No new dependencies.

**Spec:** `docs/design/specs/2026-11-07-community-solutions-design.md` §4–§7.2, §7.5, §9, §10 (minus markers). Read it first.

## Global Constraints

- No warning suppressions: `dotnet build -warnaserror`, `oxlint` and `tsc` pass clean (`CLAUDE.md`).
- Work only in a worktree; run each git command on its own. Commit after each task.
- No new npm or NuGet dependency.
- **Only one place is fetched:** `https://raw.githubusercontent.com/FrodeHus/kustodian/main/Solutions/`, through the
  existing `UpdateCheck.CreateClient()` client. Paths are built from validated ids and index entries, never taken whole
  from fetched content.
- **Nothing is written until every file of the install is fetched and its SHA-256 matches the index.** A mismatch shows
  "The download didn't match the catalog. Try again later." and writes nothing.
- Ids (solution folder and item file names): `^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$` (3–64 characters).
- Sizes: `index.json` 4 MB, `README.md` 256 KB, `tools.json` 64 KB; queries and workbooks use the services' own limits
  (1 MB text, 2 MB workbook, 100 widgets). Index refetched at most once an hour unless the user presses Refresh.
- Data folder: `solutions.json` (installed solutions) and `solution-cache/index.json` (last index, with its fetch time).
  A `solutions.json` that can't be read is moved aside as `*.corrupt` like the other stores, and nothing counts as
  installed.
- Installed items go in the library folder `importFolder(manifest.name)`'s host twin (same rule: one level, 1–80
  characters, `/` replaced) and get new GUID ids. Nothing runs on install.
- Copy: rail button "Solutions"; panel title "Community Solutions"; badges "Kustodian" and "Community"; community caveat
  "Not maintained by Kustodian. Review before running."; "Needs Kustodian x.y"; buttons "Install", "Uninstall",
  "Installed", "Refresh"; offline line "Showing the catalog from {time}. Kustodian couldn't reach GitHub."
- Match the surrounding code: XML doc comments on public C# types, `BridgeException(BridgeErrorCodes.BadRequest, …)` for
  refusals, `call()` from `web/src/bridge.ts`, `errorText`/`reportIdOf` for errors, types in `web/src/wire.ts`.

## Review Focus

1. **A hostile or broken `index.json`** (a file path with `..`, an absolute path, an id that breaks the rule, a manifest
   for another folder, a 50 MB file): the entry is dropped from the list or the install refused; nothing outside
   `Solutions/<id>/` is ever requested. Tested in Task 4.
2. **`main` moves during an install** (index fetched, then a file changes): the hash check fails and nothing is written,
   not half a solution. Tested in Task 5.
3. **GitHub unreachable**: with a cache the panel shows it with the offline line; with no cache it shows the error and
   Refresh. Tested in Tasks 4 and 6.
4. **The user deleted or moved an installed item by hand, then uninstalls**: missing items are skipped and the uninstall
   finishes; moved items are still found by id. Tested in Task 5.
5. **A workbook in the repo that the web would rewrite on first save** (missing default fields): every later save would
   look "modified". CI fails such a file. Tested in Task 2.

---

## File structure

| File | Responsibility |
| --- | --- |
| `src/Kustodian/Solutions/SolutionManifest.cs` | manifest and index records. |
| `src/Kustodian/Solutions/SolutionRules.cs` | id, manifest and index-entry checks. |
| `src/Kustodian/Solutions/SolutionHash.cs` | file SHA-256, canonical JSON, content hashes. |
| `src/Kustodian/Solutions/SolutionIndex.cs` | builds the index from a `Solutions/` folder. |
| `src/Kustodian/Solutions/SolutionService.cs` | fetch, cache, `solutions.json`, install, uninstall. |
| `src/Kustodian/Bridge/Handlers/SolutionHandler.cs` | `solution.list/get/install/uninstall`. |
| `src/Kustodian/Library/LibraryService.cs` | `SolutionOrigin`, `SavedQuery.Origin`. |
| `src/Kustodian/Workbooks/WorkbookService.cs` | keeps `origin` across saves. |
| `src/Kustodian/App/AppServices.cs` | wiring. |
| `tests/Kustodian.Tests/Solutions/*` | unit tests and `RepoSolutionsTests` (CI validation). |
| `web/src/solutions/solutions-panel.tsx` | rail panel. |
| `web/src/solutions/solution-dialog.tsx` | README, items, install and uninstall. |
| `web/src/solutions/repo-workbooks.test.ts` | round-trip check of the repo's workbook files. |
| `Solutions/README.md`, `Solutions/entra-risky-users/*` | authoring guide and the first solution. |
| `.github/CODEOWNERS`, `.github/instructions/solution-tools.instructions.md`, `.github/workflows/solutions.yml` | review gates. |
| `docs/solutions.md`, `CHANGELOG.md` | user docs. |

---

### Task 1: Manifest, rules and hashes

**Files:**
- Create: `src/Kustodian/Solutions/SolutionManifest.cs`, `SolutionRules.cs`, `SolutionHash.cs`
- Test: `tests/Kustodian.Tests/Solutions/SolutionRulesTests.cs`, `SolutionHashTests.cs`

**Interfaces:**
- Produces:
  - `record SolutionManifest(int Version, string Id, string Name, string SolutionVersion, string Description, string Author, string Support, IReadOnlyList<string> Categories, IReadOnlyList<string> Sources, string MinAppVersion, SolutionRequires? Requires, SolutionContent Content)`
  - `record SolutionRequires(IReadOnlyList<string>? Graph, IReadOnlyList<string>? Roles, IReadOnlyList<string>? Licenses, string? Azure)`
  - `record SolutionContent(IReadOnlyList<string> Queries, IReadOnlyList<string> Workbooks, IReadOnlyList<string> Tools)`
  - `record IndexFile(string Path, string Sha256, long Size)` — `Path` relative to the solution folder (`queries/risky-users.json`).
  - `record IndexEntry(SolutionManifest Manifest, IReadOnlyList<IndexFile> Files)`; `record SolutionIndexDoc(int Version, IReadOnlyList<IndexEntry> Solutions)`
  - `static class SolutionRules`: `bool IsId(string)`, `string? ManifestProblem(SolutionManifest m, string folderId)`, `string? FileProblem(IndexFile f)`, `IReadOnlyList<string> ExpectedFiles(SolutionManifest m)`
  - `static class SolutionHash`: `string Sha256(ReadOnlySpan<byte>)` (lowercase hex), `string Canonical(JsonNode?)`, `string Query(SavedQueryInput q)`, `string Workbook(JsonObject wb)`

- [ ] **Step 1: Write the failing tests**

`SolutionRulesTests`: `IsId` accepts `entra-risky-users`, `abc`; refuses `ab`, `-abc`, `abc-`, `ABC`, `a_b`, 65 characters.
`ManifestProblem` returns null for a valid manifest and a message for: `Id != folderId`; `Support` not `kustodian`/`community`;
`SolutionVersion` or `MinAppVersion` not `x.y.z`; a source outside `graph`/`hunting`/`arg`; an item id failing `IsId`; a
duplicate item id; empty `Name`. `ExpectedFiles` for the spec §5.1 manifest is
`["README.md", "queries/risky-users.json", "queries/risky-signins.json", "workbooks/weekly-review.json", "tools.json"]`
(`tools.json` only when `Content.Tools` is non-empty). `FileProblem` refuses `../x.json`, `/x.json`, `queries/../../x`,
`a\\b.json`, any path not in the shape `README.md | tools.json | queries/<id>.json | workbooks/<id>.json`, a `Sha256` that
isn't 64 lowercase hex, and sizes over the constraint limits.

`SolutionHashTests`: `Canonical` of `{"b":1,"a":[{"d":2,"c":3}]}` is `{"a":[{"c":3,"d":2}],"b":1}`; `Query` ignores
`Id`, `Name`, `Folder` (same hash for two inputs differing only there) and changes when `Text` changes; `Workbook` ignores
`id`, `name`, `folder`, `modifiedAt`, `createdAt`, `origin`, and each widget's `query.text`/`source`/`parameters`/`options`
when `query.saved` is set, but changes when a widget's `layout` changes.

- [ ] **Step 2: Run them to see them fail**

Run: `dotnet test tests/Kustodian.Tests --filter "FullyQualifiedName~Solutions"` — Expected: build fails, types missing.

- [ ] **Step 3: Implement the three files**

`Query` hashes `Canonical` of `{source, text, parameters, options}`. `Workbook` deep-clones, removes the ignored fields and
the linked-copy fields, then hashes `Canonical`. Hashes are `Sha256` of the UTF-8 canonical text.

- [ ] **Step 4: Run them to see them pass** — same command, Expected: PASS.

- [ ] **Step 5: Commit** — `feat: solution manifest rules and content hashes`

### Task 2: The repo's `Solutions/` folder, its index and CI validation

**Files:**
- Create: `src/Kustodian/Solutions/SolutionIndex.cs`, `Solutions/README.md`, `Solutions/entra-risky-users/{solution.json,README.md,queries/risky-users.json,queries/risky-signins.json,workbooks/weekly-review.json}`, `Solutions/index.json`
- Test: `tests/Kustodian.Tests/Solutions/RepoSolutionsTests.cs`, `tests/Kustodian.Tests/Solutions/SolutionIndexTests.cs`, `web/src/solutions/repo-workbooks.test.ts`

**Interfaces:**
- Consumes: Task 1.
- Produces: `static class SolutionIndex { SolutionIndexDoc Build(string solutionsDir); string Serialize(SolutionIndexDoc doc); }` — entries sorted by id, files by path, `Serialize` uses `JsonFileStore.Options` with a trailing `\n`.

- [ ] **Step 1: Write the failing tests**

`SolutionIndexTests` (temp folder): `Build` lists each folder's manifest and files with the SHA-256 of the file bytes and
their size; ignores `index.json` and dot-files.

`RepoSolutionsTests` finds the repo's `Solutions/` by walking up from `AppContext.BaseDirectory` to the folder with
`Kustodian.slnx`. One test per rule, each failing with the solution id and file in its message:
- `EveryManifestIsValid`: `ManifestProblem(m, folderName)` is null.
- `FilesMatchTheManifest`: the folder's files equal `ExpectedFiles(m)`; no other files.
- `QueriesLoad`: each query file passes `LibraryService.ReadInput` and the library's save rules (call the service's checks
  through a `LibraryService` on a temp store: `SaveAsync` must not throw), with `Source` one of the manifest's `sources`.
- `QueriesParse`: `KustoCode.Parse(text)` after `ParameterSubstitution.Apply` with each parameter's `Value`, or when empty a
  sample by type (`text` → `x`, `number` → `0`, `timespan` → `1d`, `datetime` → `2000-01-01`, `list` → first choice or
  `x`), has no `GetSyntaxDiagnostics()` errors.
- `WorkbooksLoad`: `WorkbookService.Check` is null; every widget `query.saved.id` is one of the manifest's query ids.
- `NoTenantData`: no file contains a GUID other than the workbook's own `id` and widget ids, or an e-mail address.
- `MinAppVersionIsReachable`: `MinAppVersion` ≤ the `Directory.Build.props` `<Version>` with its minor raised by one.
- `IndexIsCurrent`: `SolutionIndex.Serialize(SolutionIndex.Build(dir))` equals `Solutions/index.json`. When the
  environment variable `KUSTODIAN_WRITE_SOLUTIONS_INDEX=1` is set, it writes the file instead and passes. Failure message:
  `Solutions/index.json is out of date. Run: KUSTODIAN_WRITE_SOLUTIONS_INDEX=1 dotnet test --filter IndexIsCurrent`.

`repo-workbooks.test.ts`: for every `Solutions/*/workbooks/*.json` (`import.meta.glob('../../../Solutions/*/workbooks/*.json', { eager: true })`),
`parseWorkbook(json)` is not a string and `toEqual(json)` after removing `modifiedAt` from both. Failure names the file.

- [ ] **Step 2: Run them to see them fail** — `dotnet test tests/Kustodian.Tests --filter "FullyQualifiedName~Solution"` and `npm test -- repo-workbooks` in `web/`. Expected: FAIL (no `SolutionIndex`, no folder).

- [ ] **Step 3: Implement `SolutionIndex` and add the first solution**

`entra-risky-users`: `support: "kustodian"`, `sources: ["graph"]`, two Graph queries (`identityProtection/riskyUsers`
filtered on `riskLevel`, `riskyUsers` joined to sign-ins), and one workbook with a Markdown widget, a Stat of risky users and
a Table linked to `risky-users` with a `{RiskLevel}` list parameter; `requires.graph: ["IdentityRiskyUser.Read.All"]`,
`licenses: ["AAD_PREMIUM_P2"]`, `minAppVersion: "1.1.0"`. Write the workbook by building it in the app and exporting, so it
is already in `parseWorkbook`'s form; replace `saved.id` with the query item id. `Solutions/README.md` is the authoring
guide: layout, manifest fields (spec §5.1), id rule, version bump on every change, how to regenerate the index, and that the
owner reviews every PR here. Regenerate `index.json` with the env var.

- [ ] **Step 4: Run them to see them pass** — same commands. Expected: PASS.

- [ ] **Step 5: Commit** — `feat: Solutions folder, index and repo validation`

### Task 3: Review gates on GitHub

**Files:**
- Create: `.github/CODEOWNERS`, `.github/instructions/solution-tools.instructions.md`, `.github/workflows/solutions.yml`
- Modify: `.github/pull_request_template.md`

- [ ] **Step 1: `CODEOWNERS`** — `/Solutions/ @FrodeHus` (spec §9, **Owner**).

- [ ] **Step 2: Copilot instruction file** — front matter `applyTo: "Solutions/**/tools.json"`; body lists what to flag, from
spec §9: shell interpreters as `command` (`bash`, `sh`, `zsh`, `pwsh`, `powershell`, `cmd`), download or install commands
(`curl`, `wget`, `Invoke-WebRequest`, package managers), write or delete API calls (`--method post|put|patch|delete`,
`az … delete|stop|create`), `{param}` placed inside a URL or script text, and `batch` tools whose command sends stdin to a
network target. Ask it to quote the tool name and argument for each finding.

- [ ] **Step 3: `solutions.yml`**

Two jobs on `pull_request` with `paths: ['Solutions/**']`:
- `version-bump` (`contents: read`): checks out with `fetch-depth: 0`; for each `Solutions/<id>/` changed against the
  base (`git diff --name-only origin/${{ github.base_ref }}...HEAD`), fails unless `solution.json`'s `solutionVersion`
  (read with `jq`) is greater than the base's (`sort -V`), or the folder is new.
- `tools-change` on `pull_request_target` (`pull-requests: write`, never checks out or runs the PR's code): lists the PR's
  files with `gh api`, and when any `Solutions/*/tools.json` changed, adds the label `tools-change` and posts or updates
  one comment with each changed file's tools as `name: command arg1 arg2 …`, read from the head SHA with
  `gh api repos/{repo}/contents/{path}?ref={sha}` and `jq`.

The validation itself is `dotnet test` and `npm test` in the existing `ci.yml`; no change there.

- [ ] **Step 4: PR template** — add a "Solutions" checklist: version bumped, index regenerated, no tenant data, tools
reviewed by Copilot.

- [ ] **Step 5: Verify** — `actionlint .github/workflows/solutions.yml` if installed, else `python3 -c "import yaml,sys; yaml.safe_load(open(sys.argv[1]))" .github/workflows/solutions.yml`. Expected: no output. Note for the owner (in the commit body): turn on the branch ruleset "Automatically request Copilot code review" and make Code Owner review required; both are repo settings.

- [ ] **Step 6: Commit** — `ci: owner and tool review for Solutions`

### Task 4: Fetching and caching the catalog

**Files:**
- Create: `src/Kustodian/Solutions/SolutionService.cs` (fetch half)
- Test: `tests/Kustodian.Tests/Solutions/SolutionServiceFetchTests.cs`

**Interfaces:**
- Consumes: Task 1, `JsonFileStore`, `UpdateCheck.VersionOf`.
- Produces:
  - `sealed class SolutionService(JsonFileStore store, HttpClient http, LibraryService library, WorkbookService workbooks, TimeProvider time, string appVersion, ILogger<SolutionService>? logger = null)`
  - `const string BaseUrl = "https://raw.githubusercontent.com/FrodeHus/kustodian/main/Solutions/"`
  - `record CatalogItem(SolutionManifest Manifest, bool Compatible, string? InstalledVersion)`; `record Catalog(IReadOnlyList<CatalogItem> Solutions, DateTimeOffset FetchedAt, bool Offline)`
  - `Task<Catalog> ListAsync(bool refresh, CancellationToken ct)` — throws `SolutionRejectedException("Kustodian couldn't reach GitHub.")` only when offline with no cache.
  - `Task<(SolutionManifest Manifest, string Readme)> GetAsync(string id, CancellationToken ct)`
  - `private Task<byte[]> FetchFileAsync(IndexEntry e, IndexFile f, CancellationToken ct)` — size-capped read, SHA-256 checked.
  - `sealed class SolutionRejectedException(string message) : Exception(message)`

- [ ] **Step 1: Write the failing tests** (fake `HttpMessageHandler`, as in `UpdateCheckTests`; `FakeTimeProvider`)

- `ListFetchesAndCaches`: one request to `BaseUrl + "index.json"`; `solution-cache/index.json` written; a second `ListAsync(false)` within the hour makes no request; after 61 minutes it fetches again; `refresh: true` always fetches.
- `ListOfflineUsesCache`: handler throws `HttpRequestException` with a cache present → `Offline: true`, cached `FetchedAt`.
- `ListOfflineWithoutCacheThrows`.
- `ListDropsBadEntries`: entries whose manifest fails `ManifestProblem` (with the entry's own id), or any file fails `FileProblem`, or files ≠ `ExpectedFiles` are left out; the rest are listed.
- `CompatibleFollowsMinAppVersion`: app `1.0.0`, manifest `1.1.0` → `Compatible: false`.
- `IndexOverLimitIsRefused`: a 5 MB body → treated as unreachable.
- `GetChecksHash`: README whose bytes don't match → `SolutionRejectedException` with the constraint's mismatch copy; requested URL is exactly `BaseUrl + id + "/README.md"`.

- [ ] **Step 2: Run them to see them fail** — `dotnet test tests/Kustodian.Tests --filter "FullyQualifiedName~SolutionServiceFetch"`.

- [ ] **Step 3: Implement the fetch half** — one gate for the cache and `solutions.json`; URLs built as `BaseUrl + id + "/" + file.Path` only after both pass the rules.

- [ ] **Step 4: Run them to see them pass.**

- [ ] **Step 5: Commit** — `feat: fetch and cache the solutions catalog`

### Task 5: Provenance, install and uninstall

**Files:**
- Modify: `src/Kustodian/Library/LibraryService.cs`, `src/Kustodian/Workbooks/WorkbookService.cs`, `src/Kustodian/Solutions/SolutionService.cs`
- Test: `tests/Kustodian.Tests/Library/LibraryServiceTests.cs`, `tests/Kustodian.Tests/Workbooks/WorkbookServiceTests.cs`, `tests/Kustodian.Tests/Solutions/SolutionServiceInstallTests.cs`

**Interfaces:**
- Produces:
  - `record SolutionOrigin(string SolutionId, string SolutionVersion, string ItemId, string UpstreamHash, string ContentHash)` in `Kustodian.Library`.
  - `SavedQuery` gains a last positional `SolutionOrigin? Origin = null`. `LibraryService.SaveAsync(SavedQueryInput input, CancellationToken ct)` keeps the existing file's `Origin`; new `internal Task<SavedQuery> SaveAsync(SavedQueryInput input, SolutionOrigin origin, CancellationToken ct)` sets it.
  - `WorkbookService.SaveAsync` keeps the existing file's `origin` when the incoming document has none.
  - `record InstalledItem(string Kind, string ItemId, string LibraryId)` (`Kind` is `query` or `workbook`); `record InstalledSolution(string Id, string SolutionVersion, DateTimeOffset InstalledAt, IReadOnlyList<InstalledItem> Items)`; `solutions.json` is `{ version: 1, installed: InstalledSolution[] }`.
  - `Task<InstalledSolution> InstallAsync(string id, IReadOnlySet<string> skip, CancellationToken ct)` — `skip` holds item ids.
  - `Task<IReadOnlyList<InstalledItem>> ModifiedAsync(string id, CancellationToken ct)` — installed items whose current content hash differs from `Origin.ContentHash`.
  - `Task UninstallAsync(string id, IReadOnlySet<string> keepModified, CancellationToken ct)` — `keepModified` holds library ids to keep (their origin is cleared).

- [ ] **Step 1: Write the failing tests**

Library/Workbook: a query saved through the internal overload keeps `Origin` after a plain `SaveAsync` of the same id; a
workbook saved with `origin` keeps it after a save without one; an old file without the field reads with `Origin: null`.

`SolutionServiceInstallTests` (fake handler serving the Task 2 solution's bytes and a matching index):
- `InstallWritesQueriesThenWorkbooks`: 2 queries and 1 workbook in folder `Entra risky users`, new GUIDs; the workbook's
  `query.saved.id` is the new query id and `saved.name` its name; each item's `Origin` has the solution id and version,
  the item id, the file's SHA-256 as `UpstreamHash`, and `SolutionHash.Query/Workbook` of what was written as
  `ContentHash`; `solutions.json` lists the three items.
- `InstallSkipsItems`: `skip = {"risky-signins"}` → that query isn't written or listed.
- `InstallSkippedLinkedQueryCopiesIntoWidget`: skipping `risky-users` leaves the widget with `saved: null` and the linked
  copy as its text.
- `HashMismatchWritesNothing`: one query's bytes changed → `SolutionRejectedException`, library and workbooks empty, no `solutions.json`.
- `FailureMidwayRollsBack`: `WorkbookService` refuses the workbook (make it 101 widgets) → the queries written are deleted.
- `InstallTwiceIsRefused`: "This solution is already installed."
- `IncompatibleIsRefused`: "Needs Kustodian 1.1.0".
- `UninstallRemovesUnmodifiedAndAsks`: edit one query's text → `ModifiedAsync` returns it; `UninstallAsync(id, {thatId})`
  deletes the others, keeps it with `Origin: null`, and removes the solution from `solutions.json`.
- `UninstallSkipsMissing`: an installed query deleted by hand → no error.
- `CorruptSolutionsJsonMovedAside`.

- [ ] **Step 2: Run them to see them fail** — `dotnet test tests/Kustodian.Tests --filter "FullyQualifiedName~Solution|FullyQualifiedName~LibraryService|FullyQualifiedName~WorkbookService"`.

- [ ] **Step 3: Implement** — fetch and verify every needed file first; then queries, then workbooks (with `saved.id`
rewritten, and a fresh workbook `id`), then `solutions.json`; on any exception delete what was written and rethrow. The
folder name follows `importFolder` in `web/src/workbooks/import.ts` (shorten to 80, replace `/`).

- [ ] **Step 4: Run them to see them pass.**

- [ ] **Step 5: Commit** — `feat: install and uninstall solutions with provenance`

### Task 6: Bridge and wiring

**Files:**
- Create: `src/Kustodian/Bridge/Handlers/SolutionHandler.cs`
- Modify: `src/Kustodian/App/AppServices.cs`, `web/src/wire.ts`
- Test: `tests/Kustodian.Tests/Bridge/SolutionHandlerTests.cs`

**Interfaces:**
- Produces bridge methods (params → answer):
  - `solution.list {refresh?: boolean}` → `Catalog`
  - `solution.get {id}` → `{manifest, readme, installed: InstalledSolution | null, modified: string[]}` (`modified` = library ids)
  - `solution.install {id, skip: string[]}` → `InstalledSolution`
  - `solution.uninstall {id, keep: string[]}` → `null`
- `SolutionRejectedException` → `bad_request` with its message; an id failing `IsId` → `bad_request` "That isn't a solution id.". Wire types in `wire.ts` mirror the records (camelCase).
- After install or uninstall the handler's caller bumps the library and workbook revisions on the web side (Task 7).

- [ ] **Step 1: Failing tests** — each method's happy path with a fake service setup, and the two refusals.
- [ ] **Step 2: Run, see FAIL.** `dotnet test tests/Kustodian.Tests --filter "FullyQualifiedName~SolutionHandler"`
- [ ] **Step 3: Implement**; register in `AppServices` after `WorkbookHandler`, with `_github`, `_library`, `_workbooks`, `_time`, `AppVersion.Text`.
- [ ] **Step 4: Run, see PASS;** then `dotnet build -warnaserror`.
- [ ] **Step 5: Commit** — `feat: solution.* bridge methods`

### Task 7: The Solutions panel and dialog

**Files:**
- Create: `web/src/solutions/solutions-panel.tsx`, `web/src/solutions/solution-dialog.tsx`, `web/src/solutions/filter.ts`, tests beside each
- Modify: `web/src/side/panels.tsx` (`PanelName` gains `'solutions'`), `web/src/side/side-panel.tsx`, `web/src/app.tsx` (mount the dialog once, as `import-review` is)

**Interfaces:**
- Consumes: Task 6 bridge methods; `MarkdownWidget({ text, values })`; `useRevisions` from `web/src/library/saving.ts`.
- Produces: `filterCatalog(items: CatalogItem[], f: { search: string; category: string | null; source: Source | null; support: 'kustodian' | 'community' | null; installed: boolean }) : CatalogItem[]` (search over name, description, author, categories; case-insensitive); `useSolutionDialog` zustand store `{ id: string | null; open(id): void; close(): void }`.

- [ ] **Step 1: Failing tests**

`filter.test.ts`: each filter alone and combined; search matches a category.
`solutions-panel.test.tsx` (mock `call`): rows show name, support badge, item counts ("2 queries · 1 workbook") and
"Installed" / "Needs Kustodian 1.1.0"; Offline shows the offline line with the time; a rejected `solution.list` shows the
error and Refresh, and Refresh calls `solution.list {refresh: true}`; clicking a row opens the dialog.
`solution-dialog.test.tsx`: shows the README through `MarkdownWidget`, the community caveat only for `community`; items
listed with checkboxes, all ticked; unticking one and Install calls `solution.install {id, skip: [thatId]}` and bumps the
library and workbook revisions; Install is disabled when not `compatible`; for an installed solution, Uninstall lists the
`modified` items with "Keep my copy" ticked and sends the ticked ones as `keep`.

- [ ] **Step 2: Run, see FAIL.** `npm test -- solutions` in `web/`.
- [ ] **Step 3: Implement** — rail icon a stacked-boxes glyph in the existing `icon()` style; panel layout follows `saved-panel.tsx` (heading, search, list). Filters as one row of selects under the search.
- [ ] **Step 4: Run, see PASS;** then `npm run lint`, `npm run typecheck`.
- [ ] **Step 5: Check it in the app** — run the app (the `run` skill), open Solutions, install `entra-risky-users`, open its workbook from Saved, uninstall. Screenshot the panel and the dialog.
- [ ] **Step 6: Commit** — `feat: Community Solutions panel`

### Task 8: Docs

**Files:**
- Create: `docs/solutions.md`
- Modify: `CHANGELOG.md` (`[Unreleased] › Added`), `docs/README.md` (link), `docs/workbooks.md` (one line pointing to solutions)

- [ ] **Step 1: Write `docs/solutions.md`** — what a solution is, the panel, install (folder, new ids, nothing runs),
uninstall (asks about changed items), the support badges and caveat, offline behaviour, and "Contributing a solution"
linking `Solutions/README.md`. State that updates, tools and permissions come in later versions only if plan 2 or 3 hasn't
landed by release.
- [ ] **Step 2: CHANGELOG entry** in the existing style: **Community Solutions** — one paragraph.
- [ ] **Step 3: Commit** — `docs: Community Solutions`
