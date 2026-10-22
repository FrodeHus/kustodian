# Relationship Columns Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Graph navigation properties on a curated list (`users.memberOf`, `groups.members`, …) become `dynamic` columns on
their table, read one object at a time only when the query names them, so `users | where … | mv-expand g = memberOf` works.

**Architecture:**

- **Schema.** The schema tool keeps navigation properties from the CSDL, checks the curated `graph-relationships.json`
  against them, and writes each as a `listable: false` column with `relationship: true`, a `permissions` list and the shared
  entry shape `kustodian.directoryObjectRef`.
- **Planner.** Relationship columns flow through the existing get-only path (`Unreadable`). `GraphFetch` gains
  `FilteredLocally`.
- **Fetch.** A new `GraphRelationshipReader` sends one `$batch` item per object, follows paging up to the entry cap, and
  maps entries to the shape. `GraphCollectionReader.ReadPerObjectAsync` routes relationship columns to it, under their own
  object cap and cache entries.
- **Results.** `TableFetch` and `ExplainTable` carry a per-relationship record; the web shows chips and an Explain section.
- **Snippets.** Three built-in graph snippets.

**Tech Stack:** .NET 10, xUnit v3, Kusto.Language, React + TypeScript, Vitest, oxlint. No new dependencies.

**Spec:** `docs/design/specs/2026-10-22-relationship-columns-design.md`.

## Global Constraints

- No warning suppressions: `dotnet build -warnaserror`, `oxlint` and `tsc` must pass (`CLAUDE.md`). The two known open
  warnings (TanStack `useReactTable`, Monaco chunk size) stay as they are.
- Work only in a git worktree; several agents share this repository. Run each git command on its own.
- GET only. Relationship reads never write. `@odata.nextLink` is followed only to https on `graph.microsoft.com`.
- Never read a relationship the query doesn't name (`*`, `search`, `pack_all`, pass-through don't count).
- Direct relationships only. Never add `transitiveMemberOf` or `transitiveMembers` to the curated list.
- Limits (`GraphLimits`): `RelationshipObjectsPerTable = 100`, `RelationshipEntriesPerObject = 1_000`. Not exposed in
  Settings in this plan (my call; `SettingsService` is untouched).
- Request per object: collection `/{path}/{id}/{relationship}?$select=id,displayName,userPrincipalName,mail,appId,deviceId&$top=999`;
  single `/{path}/{id}/{relationship}?$select=id,displayName,userPrincipalName,mail,appId,deviceId`.
- Entry shape `kustodian.directoryObjectRef`, fields in this order, all `string`: `id`, `objectType`, `displayName`,
  `userPrincipalName`, `mail`, `appId`, `deviceId`. `objectType` is `@odata.type` with the `#microsoft.graph.` prefix
  removed. A field the object doesn't have is absent from the entry (not null).
- Curated list (`src/Kustodian.Graph/Schema/graph-relationships.json`), exactly:
  `users`: `memberOf`, `manager`, `directReports`, `ownedObjects`, `registeredDevices`, `ownedDevices`;
  `groups`: `members`, `owners`; `servicePrincipals`: `owners`; `applications`: `owners`;
  `devices`: `registeredOwners`, `registeredUsers`.
- Chip copy (exact; `{n}` formatted with thousands separators):
  - truncated: ``{table}.{column}: cut off at {cap} entries for {n} objects``
  - all refused: ``No permission to read {table}.{column}; it needs one of: {permissions}``
  - some refused: ``{table}.{column}: no permission for {refused} of {objects} objects, their values are empty``
  - filtered locally: ``{table}.{column} read for all {n} listed objects; the filter ran locally. Use a filter Graph can apply (==, startswith) to read fewer.``
  - over the object cap: the existing ``{table}: too many objects to read one at a time, values empty``.

## Review Focus

1. **A user with no manager.** `manager` answers 404; the value is null, nothing counts as failed or refused, no chip.
   Test in Task 4.
2. **Same name in a get-only property and the cache.** A relationship's cache entry must never be served for a property read
   of the same id (and the reverse). Test in Task 5.
3. **A query that names a relationship only through `project *` or `pack_all`.** No relationship request is sent. Test in
   Task 3.
4. **A table that is both filtered locally and over the relationship cap** (`users | where displayName contains "a" | mv-expand
   memberOf` with 150 listed users). Column empty, the capped chip *and* the filtered-locally chip both show; no relationship
   requests sent. Test in Task 5.
5. **A nextLink to another host inside a relationship page.** The object counts as failed and no request goes to that host.
   Test in Task 4.

---

### Task 1: Schema model carries relationship columns

**Files:**
- Modify: `src/Kustodian.Graph/Schema/GraphSchema.cs`
- Modify: `src/Kustodian.Graph/Schema/GraphSchemaJson.cs`
- Modify: `src/Kustodian.Graph/Schema/GraphSchemaDiff.cs`
- Test: `tests/Kustodian.Graph.Tests/Schema/GraphSchemaJsonTests.cs`, `GraphSchemaDiffTests.cs`

**Interfaces:**
- Produces: on `GraphColumn`, init properties `bool Relationship { get; init; }` and
  `IReadOnlyList<string> Permissions { get; init; } = []`. JSON keys `relationship` (written only when true) and
  `permissions` (written only when non-empty), after `knownPermission`.
- Produces: `GraphSchemaJson.DirectoryObjectRef = "kustodian.directoryObjectRef"` (const string).

- [ ] **Step 1: Write the failing tests**
  - `GraphSchemaJsonTests.Relationship_columns_round_trip`: a table with column `new GraphColumn("memberOf", "dynamic", "d", [], false, "kustodian.directoryObjectRef", Collection: true, Listable: false) { Relationship = true, Permissions = ["GroupMember.Read.All", "Directory.Read.All"] }` survives `Write` then `Read` with `Relationship` true and both permissions in order.
  - `GraphSchemaJsonTests.Plain_columns_write_no_relationship_keys`: the written JSON of a plain column contains neither `"relationship"` nor `"permissions"`.
  - `GraphSchemaDiffTests.Reports_an_added_relationship_column`: adding the column above to `users` shows up in `ToSummary()` like any added column.
- [ ] **Step 2: Run them and see them fail** — `dotnet test tests/Kustodian.Graph.Tests --filter "FullyQualifiedName~GraphSchemaJsonTests|FullyQualifiedName~GraphSchemaDiffTests"`; expect compile errors on `Relationship`.
- [ ] **Step 3: Add the properties and the JSON keys.** Diff needs a change only if it compares columns field by field; a changed `permissions` list counts as a changed column.
- [ ] **Step 4: Run the tests; expect PASS.** Then `dotnet build -warnaserror`.
- [ ] **Step 5: Commit** — `git commit -m "feat(graph): schema columns can be relationships"`

### Task 2: The schema tool emits curated relationships

**Files:**
- Modify: `src/Kustodian.Graph/Schema/GraphMetadata.cs`
- Create: `src/Kustodian.Graph/Schema/GraphRelationships.cs`
- Create: `src/Kustodian.Graph/Schema/graph-relationships.json` (contents: Global Constraints list, each value `{}`)
- Modify: `src/Kustodian.Graph/Schema/GraphSchemaBuilder.cs`
- Modify: `tools/schema/Program.cs`, `tools/schema/README.md`
- Modify: `src/Kustodian.Graph/Schema/graph-beta.json` (regenerated)
- Modify: `tests/Kustodian.Graph.Tests/Fixtures/mini-metadata.xml`: on `application` add
  `<NavigationProperty Name="primaryOwner" Type="graph.directoryObject" />`.
- Modify: `tests/Kustodian.Graph.Tests/Schema/permissions-excerpt.json`: a `GroupMember.Read.All`-style entry granting
  DelegatedWork GET on `/applications/{id}/owners` (least), and none for `/applications/{id}/primaryOwner`.
- Test: `tests/Kustodian.Graph.Tests/Schema/GraphSchemaBuilderTests.cs`, new `GraphRelationshipsTests.cs`

**Interfaces:**
- Produces: `public sealed record CsdlNavigation(string Name, string TypeName, bool IsCollection, string Description);` and
  `CsdlType.Navigations` (`IReadOnlyList<CsdlNavigation>`, inherited ones included, base first; default `[]`).
- Produces: `public static class GraphRelationships` with
  `IReadOnlyDictionary<string, IReadOnlyList<string>> Load(Stream json)` (table name → relationship names, file order) and
  `IReadOnlyDictionary<string, IReadOnlyList<string>> Bundled` (the embedded file).
- Produces: `GraphSchemaBuilder.Build(GraphMetadata metadata, IReadOnlyDictionary<string, IReadOnlyList<string>> permissions,
  IReadOnlyDictionary<string, IReadOnlyList<string>> relationships, string source, DateTimeOffset generatedAt,
  ICollection<string>? warnings = null)`. The old overload stays and passes an empty relationship map.
- Produces: `public sealed class GraphRelationshipException(string message) : Exception(message)`, thrown for a curated name
  that isn't a navigation property of the table's entity type, or a curated table that doesn't exist.

- [ ] **Step 1: Write the failing tests**
  - `GraphRelationshipsTests.Bundled_list_is_the_spec_list`: `Bundled` equals the Global Constraints list exactly, and contains no name starting with `transitive`.
  - `GraphSchemaBuilderTests.Curated_relationship_becomes_a_get_only_dynamic_column`: building the fixture with `{ "applications": ["owners", "primaryOwner"] }` gives `applications.owners` with `Type == "dynamic"`, `Collection == true`, `Listable == false`, `Relationship == true`, `ComplexType == "kustodian.directoryObjectRef"`, `Permissions` equal to the excerpt's least delegated permissions; `primaryOwner` has `Collection == false`, empty `Permissions`, and one entry in `warnings` naming `applications.primaryOwner`.
  - `GraphSchemaBuilderTests.Directory_object_ref_shape_is_in_complex_types`: `ComplexTypes["kustodian.directoryObjectRef"]` field names equal `id, objectType, displayName, userPrincipalName, mail, appId, deviceId`, all `string`, none collections.
  - `GraphSchemaBuilderTests.Unknown_curated_name_fails`: `{ "applications": ["nope"] }` throws `GraphRelationshipException` whose message contains `applications.nope`.
  - `GraphSchemaBuilderTests.Uncurated_navigation_properties_stay_out`: without a relationship map, `applications` has no `owners` column (current behaviour kept).
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.** `GraphMetadata.Build` reads `NavigationProperty` elements into `Navigations` (description from inline or external annotations, as for properties). The builder appends relationship columns after the property columns; permissions come from `permissions.GetValueOrDefault(GraphPermissions.NormalizePath($"/{collection.Path}/{{id}}/{name}"))`, distinct and sorted like table permissions. Add the shape to `complexTypes` only when at least one relationship column exists. `Program.cs` passes `GraphRelationships.Bundled`, prints each warning, and exits 3 with the message on `GraphRelationshipException`. README gets one paragraph on the curated file.
- [ ] **Step 4: Run the tests; expect PASS.**
- [ ] **Step 5: Regenerate the schema** — `dotnet run --project tools/schema`. Expected: the summary lists the 13 added columns, no warnings or only warnings for relationships Microsoft lists no permission for (note them in the commit message). Spot-check `users.memberOf` in `graph-beta.json`.
- [ ] **Step 6: Full Graph test run** — `dotnet test tests/Kustodian.Graph.Tests`; fix any test that counts columns of the real schema.
- [ ] **Step 7: Commit** — `git commit -m "feat(schema): curated Graph relationships as columns"`

### Task 3: Completion and planning

**Files:**
- Modify: `src/Kustodian.Graph/Query/GraphQueryPlanner.cs`
- Test: `tests/Kustodian.Graph.Tests/Query/GraphQueryPlannerTests.cs`, `GraphCompletionTests.cs`

**Interfaces:**
- Consumes: Task 2's `applications.owners` / `primaryOwner` in `TestSchemas.Fixture()` (rebuild the fixture with
  `{ "applications": ["owners", "primaryOwner"] }` in `TestSchemas`).
- Produces: `GraphFetch.FilteredLocally` (`bool`, init): true when any of the table's `where` conditions run locally (the
  explanation's `Local` plus the later predicates), or when the table is read more than once and any `where` applies to it.

- [ ] **Step 1: Write the failing tests**
  - `Completion_offers_relationship_entry_fields`: `applications | mv-expand o = owners | where o.` completes `objectType`, `userPrincipalName`, `displayName`.
  - `Completion_types_single_relationship_as_a_bag`: `applications | where primaryOwner.` completes `displayName`.
  - `Relationship_named_is_read_per_object_not_selected`: plan of ``applications | where displayName == "x" | mv-expand o = owners`` has `owners` in `Unreadable`, not in `Select`, and `FilteredLocally == false`.
  - `Relationship_through_star_is_not_read`: `applications | project *` and `applications | extend p = pack_all()` have no `owners` in `Unreadable`.
  - `Local_condition_marks_filtered_locally`: ``applications | where displayName contains "x" | mv-expand o = owners`` → `FilteredLocally == true`; a later `where` after `mv-expand` on the table's own column also → true.
  - `Self_join_marks_filtered_locally`: a self-join of `applications` with a `where` on one side → `FilteredLocally == true`.
  - `No_where_is_not_filtered_locally`: `applications | mv-expand o = owners` → `FilteredLocally == false`.
- [ ] **Step 2: Run them and see them fail** (completion tests may already pass since `GraphGlobals.Typed` handles `ComplexType`; keep them as guards).
- [ ] **Step 3: Set `FilteredLocally`** in `PlanExplained` where `GraphFetch` is built.
- [ ] **Step 4: Run the tests; expect PASS.**
- [ ] **Step 5: Commit** — `git commit -m "feat(graph): plan relationship columns and note local filtering"`

### Task 4: Relationship reader

**Files:**
- Create: `src/Kustodian.Graph/Fetch/GraphRelationshipReader.cs`
- Modify: `src/Kustodian.Graph/Run/GraphLimits.cs` (the two limits, with doc comments)
- Test: `tests/Kustodian.Graph.Tests/Fetch/GraphRelationshipReaderTests.cs`

**Interfaces:**
- Produces:
  ```csharp
  public sealed record GraphRelationshipRead(
      IReadOnlyDictionary<string, JsonNode?> Values, // object id → array (collection) or bag/null (single)
      IReadOnlyList<string> Truncated,              // ids cut off at the entry cap
      int Refused, int Failed);
  public sealed class GraphRelationshipReader(HttpClient http, GraphLimits limits)
  {
      public static string Template(string path, string relationship, bool collection); // "{path}/{id}/{relationship}?$select=…[&$top=999]"
      public static JsonObject Entry(JsonObject graphObject); // to kustodian.directoryObjectRef
      public Task<GraphRelationshipRead> ReadAsync(string accountKey, string path, GraphColumn relationship,
          IReadOnlyList<JsonObject> objects, GraphFetchLease lease, RunDiagnostics? diagnostics, CancellationToken ct);
  }
  ```
  Same batch size (20), batches in flight (4) and single throttling retry as `GraphBatchReader`; reuse its constants.

- [ ] **Step 1: Write the failing tests** (with `FakeGraph`):
  - `Template_matches_the_spec`: `Template("users", "memberOf", true)` equals the collection request in Global Constraints with `{id}`; `collection: false` has no `$top`.
  - `Entry_maps_type_and_drops_absent_fields`: `{"@odata.type":"#microsoft.graph.group","id":"g1","displayName":"SOC","mail":"soc@x","securityEnabled":true}` → exactly `{"id":"g1","objectType":"group","displayName":"SOC","mail":"soc@x"}` (fields outside the shape dropped, absent shape fields not added); a `user` with `userPrincipalName` keeps it.  - `Collection_values_become_arrays`: two objects, `$batch` answers `value` arrays; `Values["u1"]` is a two-entry array of mapped entries.
  - `Follows_next_link_until_the_entry_cap`: with `RelationshipEntriesPerObject = 3`, a page of 2 plus a nextLink page of 2 → 3 entries, `Truncated == ["u1"]`, no third page requested.
  - `Single_relationship_404_is_null`: `manager` item 404 → `Values["u1"]` is null, `Failed == 0`, `Refused == 0`.
  - `Refused_items_are_counted`: items with 403 → `Refused` equals their count, no value for those ids.
  - `Foreign_next_link_fails_the_object`: nextLink `https://evil.example/…` → `Failed == 1`, no request to that host in `FakeGraph.Requests`.
  - `Every_body_is_charged_to_the_lease`: a small `GraphFetchBudget` makes a large relationship read throw `GraphReadException` with `TooLarge`.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.** Follow-up pages: builder's call (later `$batch`es with the nextLink made relative, or plain GETs).
- [ ] **Step 4: Run the tests; expect PASS.**
- [ ] **Step 5: Commit** — `git commit -m "feat(graph): read relationships one object at a time"`

### Task 5: Collection reader routes relationships

**Files:**
- Modify: `src/Kustodian.Graph/Fetch/GraphCollectionReader.cs` (`ReadPerObjectAsync` and `GraphCollection`)
- Test: `tests/Kustodian.Graph.Tests/Fetch/GraphCollectionReaderTests.cs`, `MemoryGraphObjectCacheTests.cs` if the key helper lives there

**Interfaces:**
- Consumes: `GraphRelationshipReader` (Task 4), `GraphColumn.Relationship` (Task 1).
- Produces:
  ```csharp
  public sealed record GraphRelationshipOutcome(string Column, int Objects, int Truncated, int Refused, int Failed,
      bool Capped, int Cached);
  // on GraphCollection:
  public IReadOnlyList<GraphRelationshipOutcome> Relationships { get; init; } = [];
  ```
  Relationship columns no longer appear in `PerObject`, `PerObjectFailed` or `PerObjectCapped`; property columns behave as
  today.
- Cache: one entry per object and relationship, `columns` argument `["rel:" + column]`; stored JSON
  `{"value": <array|bag|null>, "truncated": true|false}`. `IGraphObjectCache` is unchanged.

- [ ] **Step 1: Write the failing tests**
  - `Relationship_reads_only_listed_objects`: list returns `a1`, `a2`; query names `owners`; the `$batch` carries `/applications/a1/owners?…` and `/applications/a2/owners?…`; rows get arrays.
  - `Relationship_over_its_own_cap_stays_empty`: 101 objects, default limits → no relationship request, outcome `Capped == true`, column absent on rows; a get-only property column on the same 101 objects is still read (cap 2,000).
  - `Relationship_and_property_cache_entries_do_not_mix` (Review Focus 2): with `MemoryGraphObjectCache`, a run naming property `getOnlyGroup` then a run naming relationship `owners` for the same id both go to Graph; a second run naming `owners` is served from cache with `Cached == 1` and keeps `Truncated`.
  - `Capped_and_unfiltered_together` (Review Focus 4): Graph refuses the filter (`Unfiltered`), 150 objects → no relationship request, `Capped == true`, `Unfiltered == true`.
  - `Refresh_skips_the_relationship_cache`.
  - `Diagnostics_name_the_relationship`: with `RunDiagnostics`, the `per-object` entry text contains `applications.owners`.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.** In `ReadPerObjectAsync`, split `columns` by `fetch.Table` column `Relationship`; run the existing path for properties and, per relationship column, cache lookup → cap check against `limits.RelationshipObjectsPerTable` (over it, nothing merged) → `GraphRelationshipReader.ReadAsync` for misses → merge and cache. Add `GraphRelationshipReader.Template(…)` to `requests` once per relationship. Log `DiagnosticKinds.PerObject` / `Cache` entries naming `{table}.{column}`.
- [ ] **Step 4: Run the tests; expect PASS.** Then the whole Graph test project.
- [ ] **Step 5: Commit** — `git commit -m "feat(graph): route relationship columns through their own reads and cap"`

### Task 6: Run results and Explain

**Files:**
- Modify: `src/Kustodian.Graph/Run/RunResult.cs`, `src/Kustodian.Graph/Run/GraphRunner.cs` (`Describe`, `ReportReads`)
- Modify: `src/Kustodian.Graph/Query/GraphExplain.cs`
- Test: `tests/Kustodian.Graph.Tests/Run/GraphRunnerTests.cs`, `tests/Kustodian.Graph.Tests/Query/GraphExplainTests.cs`

**Interfaces:**
- Produces:
  ```csharp
  public sealed record RelationshipFetch(string Column, int Objects, int Truncated, int EntryCap, int Refused,
      IReadOnlyList<string> Permissions, bool Capped, bool FilteredLocally);
  // TableFetch: public IReadOnlyList<RelationshipFetch> Relationships { get; init; } = [];
  public sealed record ExplainRelationship(string Column, string Url, IReadOnlyList<string> Permissions, int EntryCap);
  // ExplainTable: public IReadOnlyList<ExplainRelationship> Relationships { get; init; } = [];
  //               public bool FilteredLocally { get; init; }
  // ExplainLimits gains: int RelationshipObjectsPerTable, int RelationshipEntriesPerObject
  ```
  `RelationshipFetch.FilteredLocally = fetch.FilteredLocally || read.Unfiltered`. Wire names are the camelCase of these.

- [ ] **Step 1: Write the failing tests**
  - `GraphRunnerTests.Relationship_outcome_reaches_the_result`: a run naming `owners` with one 403 of two objects gives `Relationships[0]` with `Objects == 2`, `Refused == 1`, the column's `Permissions`, `EntryCap == 1000`.
  - `GraphRunnerTests.Unfiltered_read_marks_relationship_filtered_locally`.
  - `GraphExplainTests.Explain_lists_relationship_requests`: explaining ``applications | where displayName == "x" | mv-expand o = owners`` gives one `ExplainRelationship` with `Url == GraphRelationshipReader.Template("applications", "owners", true)`, the permissions and `EntryCap == 1000`, `FilteredLocally == false`; with `contains` → true. `owners` no longer appears in `PerObject`.
  - `GraphExplainTests` limits test: `ExplainLimits` carries 100 and 1,000 from `GraphLimits.Default`.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.** `ExplainTable.PerObject` keeps only property columns.
- [ ] **Step 4: Run the tests; expect PASS.** Also `dotnet test tests/Kustodian.Tests` (bridge serialization of results).
- [ ] **Step 5: Commit** — `git commit -m "feat(graph): report relationship reads in results and Explain"`

### Task 7: Web chips and Explain section

**Files:**
- Modify: `web/src/wire.ts` (`TableFetch.relationships`, `RelationshipFetch`, `ExplainTable.relationships`, `ExplainTable.filteredLocally`, `ExplainRelationship`, `ExplainLimits` fields)
- Modify: `web/src/results/run-status.tsx` (`tableChips`)
- Modify: `web/src/explain/explain-view.tsx`
- Modify: `web/src/bridge.mock.ts` (new fields, empty or false)
- Test: `web/src/results/run-status.test.tsx`, `web/src/explain/explain-view.test.tsx`

**Interfaces:**
- Consumes: Task 6's wire shapes.

- [ ] **Step 1: Write the failing tests** (`run-status.test.tsx`), one per chip in Global Constraints with exact text:
  - truncated: `{column:'members', truncated:2, entryCap:1000, …}` on `groups` → `groups.members: cut off at 1,000 entries for 2 objects`.
  - all refused: `refused == objects == 40` → `No permission to read users.memberOf; it needs one of: GroupMember.Read.All, Directory.Read.All`.
  - some refused: `refused 3, objects 40` → `users.memberOf: no permission for 3 of 40 objects, their values are empty`.
  - filtered locally: `filteredLocally: true, objects: 87` → the filtered-locally text with `87`.
  - capped: `capped: true` → the existing capped chip text for the table, once even with two capped relationships.
  - nothing to say: a clean relationship read adds no chip.
  - read one at a time: the existing "N columns read one object at a time" chip counts `perObject` plus `relationships`
    (spec 5.5), and its title lists both as `table: col, …`.
  - Review Focus 4: `capped: true` and `filteredLocally: true` on the same relationship show both chips.
  - `explain-view.test.tsx`: a table with one relationship shows its column, URL, permissions and "up to 1,000 entries per object"; with `filteredLocally` it shows "The filter runs locally, so every listed object's relationships are read." The limits line shows "100 objects per relationship".
- [ ] **Step 2: Run** `npm --prefix web test -- run-status explain-view`; expect failures.
- [ ] **Step 3: Implement** chips (all `tone: 'warn'`) and the Explain section beside the per-object list.
- [ ] **Step 4: Run tests, then** `npm --prefix web run lint` and `npm --prefix web run typecheck`; expect only the known `react(incompatible-library)` warning.
- [ ] **Step 5: Commit** — `git commit -m "feat(web): show relationship reads in run status and Explain"`

### Task 8: Snippets and docs

**Files:**
- Modify: `src/Kustodian/Snippets/builtin-snippets.json`
- Modify: `tests/Kustodian.Tests/Snippets/SnippetServiceTests.cs`
- Modify: `docs/README.md` (a short "Relationships" section: what the columns are, the two example queries, the caps, direct only)

**Interfaces:**
- Consumes: the regenerated schema from Task 2.

- [ ] **Step 1: Update the test first.** `Builtin_graph_snippets_all_plan_without_error`: 7 graph snippets; 4 in "Identity checks", 3 in "Directory relationships". Add `Relationship_snippets_read_their_relationship`: planning each new snippet gives a fetch whose `Unreadable` contains `memberOf`, `members` or `owners` respectively, with `FilteredLocally == false`.
- [ ] **Step 2: Run it and see it fail.**
- [ ] **Step 3: Add the three snippets** from spec section 6, ids `5f0e6a6e-6d0a-4a55-9a53-0b7e3a1c0010` to `…0012`, group `Directory relationships`. Parameters are `string`, `required: true`, with an example default so the test's substitution succeeds: `upn` = `someone@contoso.com`, `groupName` = `SOC Analysts`, `appName` = `Kustodian`.
- [ ] **Step 4: Run** `dotnet test tests/Kustodian.Tests --filter FullyQualifiedName~SnippetServiceTests`; expect PASS.
- [ ] **Step 5: Write the docs section.**
- [ ] **Step 6: Final check** — `dotnet build -warnaserror`, `dotnet test`, web tests, oxlint and tsc all pass.
- [ ] **Step 7: Commit** — `git commit -m "feat(snippets): directory relationship snippets and docs"`

## Manual check by the owner (not for the builder)

On a real tenant: a user's groups; a large group's members (truncation chip); a user without a manager; an account without
`GroupMember.Read.All` (denied chip); `$select` with derived-type fields accepted on `memberOf` and `members`. If Graph
refuses `$select` on a relationship, that relationship drops it (spec 5.4).
