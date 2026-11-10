# Workspaces: hunting workspace picker and a Log Analytics source — design

Status: draft, 2026-11-10. Not approved.

## Intent

Kustodian queries Graph, Defender advanced hunting and Azure Resource Graph. What it can't reach yet is the data in
**Log Analytics workspaces**: Sentinel's tables, Entra logs past Graph's 30 days (`SigninLogs`, `AuditLogs`),
`MicrosoftGraphActivityLogs`, `AzureActivity`, Azure diagnostics, workspace-based **Application Insights** (`AppRequests`,
`AppDependencies`, `AppExceptions`, `AppTraces`, …) and custom `_CL` tables.

There are two stable ways in, and they're built in this order (the owner's decision):

1. **A workspace picker for the existing hunting source.** Graph v1.0 `security/runHuntingQuery`, which Kustodian already
   calls, takes an optional `workspaceId`. For a Sentinel workspace onboarded to the Defender portal, that query reaches the
   workspace's tables alongside Defender's. Microsoft says Sentinel will only be supported in the Defender portal after
   March 31, 2027, so this covers every Sentinel workspace in time. Small change, no new permission.
2. **A new `logs` source on the Azure Monitor Logs query API**, for every workspace, Sentinel or not: App Insights, Azure
   diagnostics, and Entra logs in workspaces without Sentinel. It reuses the picker and workspace list from part 1.

The owner's own requirement: **the user picks the workspace a query targets.**

## Goals

- **Part 1:** hunting tabs, saved queries, history and workbook widgets can name a workspace. The toolbar shows a workspace
  picker on hunting tabs; "Primary workspace" (no workspace sent) stays the default and works exactly as today.
- **Part 2:** a fourth query source, `logs` (UI name "Log Analytics"), next to `graph`, `hunting` and `arg`, working
  everywhere the server-side sources work (tabs, saved queries, history, Recent, workbook widgets). It **requires** a
  workspace.
- One workspace list and one picker component, shared by both parts.
- Timespans that match the data: Sentinel and Logs tables keep more than 30 days.
- Schema-aware completion for the chosen workspace's tables.
- The Entra app planner and the permissions docs list what each part needs.

## Non-goals

- Ingestion, table management, alert or detection rules, anything that writes.
- The Sentinel data lake (`api.securityplatform.microsoft.com`). It's a separate source, later, once its API is confirmed GA.
- Application Insights' classic API (`api.applicationinsights.io`) and the classic table names (`requests`, `dependencies`).
  Classic resources are retired; workspace-based ones come through part 2 under their workspace names.
- Basic and Auxiliary table plans (the Logs `/search` endpoint). Queries on them fail with the service's own error.
- Async Logs export jobs (preview).
- Several workspaces in one picker choice. One workspace per query in v1; `workspace("name").Table` in the KQL still reaches
  others (see the open question).
- A workbook parameter that picks the workspace (see the open question).

## Anti-goals

- **Never send a query to a workspace the user didn't pick.** No silent default to "the first workspace". A `logs` tab with
  no workspace says "Pick a workspace" and doesn't run.
- **Never hide where an answer came from.** Part 1 has a catch (below): the hunting API falls back to the caller's primary
  workspace when the chosen one isn't found or isn't accessible, without saying so.
- Never send a Logs token anywhere but `api.loganalytics.azure.com` (the rule `ArmDirectory` follows for `nextLink`).
- No change for anyone who doesn't pick a workspace: hunting with no workspace sends exactly today's request.

## Constraints

- Stable APIs only: Graph v1.0 `runHuntingQuery`, Logs query API `v1` (its `beta` version and batch API are deprecated and
  not used), Azure Resource Graph for listing workspaces.
- Warnings are fixed, never suppressed (CLAUDE.md).
- Worktrees for all edits.

## Shared: the workspace list and picker

**Listing.** An ARG query through the existing `ArgClient`, at scope "all", cached 10 minutes per account like subscriptions
in `ArmDirectory`:

```kusto
resources
| where type =~ 'microsoft.operationalinsights/workspaces'
| project name, resourceId = id, customerId = tostring(properties.customerId), resourceGroup, subscriptionId, location
| order by name asc
```

Both APIs take the workspace's **customer ID** (a GUID), not its ARM resource ID. Seeing a workspace in ARG doesn't mean you
can query it. Listing needs Resource Graph's permission (Azure Service Management `user_impersonation`), which the planner
adds when either part is chosen.

**Run options.** `QueryOptions` gets a third part:

```csharp
public sealed record QueryWorkspace(string CustomerId, string Name, string ResourceId);
public sealed partial record QueryOptions(string? Timespan, ArgScope? Scope, IReadOnlyList<QueryWorkspace>? Workspaces);
```

`Workspaces` is a list so that several workspaces later need no format change; in v1, `QueryOptions.Problem` allows at most
one (my call). `Name` and `ResourceId` are for display, and so a saved query can name a workspace the account can't see any
more ("contoso-sentinel isn't available to this account"). Only `CustomerId` is sent. `Problem` checks it's a GUID.
Saved queries, history and workbook files already keep `options` as an object; a missing `workspace` reads as null, so old
files load unchanged and no file format version changes.

**Picker.** `web/src/toolbar/workspace-picker.tsx`, built like `scope-picker.tsx`, with the same consent, sign-in and error
states: a searchable list (name, resource group, subscription name, location). On hunting tabs the first entry is
"Primary workspace" (no `workspaceId` sent; Graph then uses the caller's primary workspace, if one is connected). The toolbar always shows what's set. Changing it marks the tab dirty. The last workspace
picked is remembered per account and preselected on a new `logs` tab only (my call: hunting tabs start at "Primary workspace",
so nobody's hunting runs change underneath them).

**Workbooks.** The widget editor shows the picker for hunting and `logs` widgets; the workspace is stored in the widget's
`options`. The workbook's timespan parameter drives hunting and `logs` widgets alike (my call). Its cap follows each widget:
30 days for hunting without a workspace, 2 years otherwise, so `huntingTimespanProblem` and `model.ts`'s 30-day literal take
the widget into account. `widgetRunOptions` in `workbooks/resolve.ts` replaces only the timespan and keeps the widget's
workspaces; today it replaces the whole options and would drop them.

## Part 1: hunting with a workspace

**Request.** `HuntingClient.HuntingRequest` gains `workspaceId`, sent only when a workspace is set, so the no-workspace
request is byte-for-byte today's:

```json
{ "Query": "SigninLogs | take 10", "Timespan": "P90D", "workspaceId": "00000000-0000-0000-0000-000000000001" }
```

**The fallback.** Per Graph's docs: "If the workspace isn't found or not accessible, the service falls back to the caller's
primary workspace." The answer doesn't say which workspace answered. My call for v1: when a workspace is set, the run status
names it, and the run's diagnostics always carry a note that Defender answers from the primary workspace when this one isn't
reachable. The builder should try to find a reliable signal (for example the `TenantId` column, which in Log Analytics tables
holds the workspace ID, when the result has it) and, where there is one, turn the note into a warning when the IDs differ.
See the open question.

**Permissions.** Unchanged: `ThreatHunting.Read.All`. Querying Sentinel data in advanced hunting needs at least the
**Microsoft Sentinel Reader** role on the workspace; `HuntingClient.NoPermission`'s text mentions it when a workspace is set.

**Timespan.** `QueryOptions.MaxTimespan` (30 days) stops being one number. With no workspace, hunting stays at 30 days. With a
workspace, Defender follows each table's own retention, so the cap is 2 years (my call; interactive retention goes up to 2
years). The timespan picker gets 90 days and the custom range follows the cap.

**Schema.** The builder checks whether `getHuntingSchema` (beta) lists a workspace's Sentinel tables, and whether it takes a
workspace. If it doesn't, Sentinel table names aren't completed in part 1 (the query still runs, and the editor marks unknown
tables as it does today). Part 2's `/metadata` schema can fill that gap later for accounts that have the Logs permission. The
builder should not make part 1 depend on part 2's permission.

## Part 2: the `logs` source

### The API, as checked on Microsoft Learn

| Need | Call |
|---|---|
| Run a query | `POST https://api.loganalytics.azure.com/v1/workspaces/{customerId}/query`, body `{ "query", "timespan" }`. |
| Server timeout | `Prefer: wait=<seconds>`. Default 3 minutes, maximum 10. Over it: `504`. |
| Schema | `GET https://api.loganalytics.azure.com/v1/workspaces/{customerId}/metadata`: tables, columns, functions. |
| Token | Scope `https://api.loganalytics.io/.default`. The `api.loganalytics.io` host is being replaced by `api.loganalytics.azure.com`; the token audience stays `api.loganalytics.io`. |
| Own app permission | **Log Analytics API**, delegated `Data.Read`. Data access is Azure RBAC on the workspace (Reader, Log Analytics Reader, or table-level RBAC). |
| Answer | `{ "tables": [{ "name", "columns": [{ "name", "type" }], "rows": [[…]] }] }`. A query that partly fails can return 200 with an `error` next to `tables`. |
| Errors | 400 `BadArgumentError` with an `innererror` (syntax and semantic errors); 403 `InsufficientAccessError` (no RBAC on the workspace); 403 `InvalidAuthenticationToken*` (sign in again); 204 for a workspace with no data. |

The builder confirms two things the docs didn't settle: that the **Azure CLI public client** (Kustodian's default) gets a
token for `api.loganalytics.io` without extra consent (`az monitor log-analytics query` suggests it does), and the Log
Analytics API's **app ID** for `SourcePermissions` (I believe `ca7f3f0b-7d91-482c-8e09-c5d840d0eac5`).

### Back end (`src/Kustodian.Sources/Logs/`)

Mirror `Hunting/` and `Arg/`:

- **`LogsClient`**: posts the query with the timespan and a `Prefer: wait` header, reads the body with `BodyReader` under a
  size cap, and turns the first table (`PrimaryResult`) into rows as `ServerRows` does for the other sources. An error's
  position, when the 400 body has one, goes through `ParameterSubstitution.MapBack`. A 200 with an `error` is a successful run
  with a warning diagnostic. A 204 is an empty result.
- **`LogsQuerySource : IQuerySource`** (`Name => "logs"`), shaped like `HuntingQuerySource`. No workspace in the options is a
  `QueryError`: "Pick a workspace before running."
- **`LogsSchemaSource`**: reads `/metadata` per account **and workspace**, cached 24 hours, with the 10-minute retry and the
  "keep the last good one" rule of `HuntingSchemaSource`. No bundled fallback: with no schema, completion is off and the schema
  panel says why.
- **Auth**: `Audience.LogAnalytics` (scope `https://api.loganalytics.io/.default`), an auth handler like `ArmAuthHandler`, and
  an `HttpClient` that only talks to `api.loganalytics.azure.com`. It follows ARM's rules in `AccountService.ConfigFor` (my
  call): Graph CLI accounts get Logs tokens from the Azure CLI client, a consent or step-up need becomes
  `ConsentRequiredException("logs")` with its own consent kind on the wire and in the picker, and own-app accounts get
  `Data.Read` through the planner only.
- **Permissions**: `SourcePermissions.LogAnalytics` (Log Analytics API, `Data.Read`, no admin consent, "Log Analytics tabs"),
  in the planner next to Resource Graph.
- Wire `logs` wherever `arg` is wired today: the bridge's source list, `SchemaHandler`, `HistoryHandler`, `SolutionRules`
  (`grep -rl '"arg"' src` lists them).

### Front end (`web/src/`)

- `Source` gains `'logs'` in `wire.ts`. `tabs/sources.ts` gets its label and icon, plus "New Log Analytics query" in the
  command palette and the tab strip's menu.
- The workspace picker (shared) and the timespan picker show on `logs` tabs. Presets: 1 day (the default for a new tab, the
  portal's default), 7, 30 and 90 days, custom up to 2 years.
- The schema store loads per workspace; changing the workspace reloads completion and the schema panel.
- Results, diagnostics, run status and `source-wording.ts` get the `logs` wording ("Running the query in Log Analytics on
  contoso-logs").
- `bridge.mock.ts` gets sample workspaces and a `logs` source (`grep -rl "'arg'" web/src` lists the rest to wire).

## Docs

- `README.md`: Features lists four sources and the hunting workspace option.
- `docs/EntraPermissions.md`, `docs/LicensesAndPermissions.md`: Sentinel Reader for part 1; the Log Analytics API permission
  and workspace RBAC for part 2.
- `docs/workbooks.md`: `logs` in the source list, and the workspace on hunting and `logs` widgets.

## Testing

As the other sources are tested.

- Part 1: the request has `workspaceId` only when set; `QueryOptions.Problem` with the workspace part and per-source caps; the
  fallback note in diagnostics; the picker's "Primary workspace" entry; the tab store sending `options.workspace`; old saved
  queries and workbooks loading unchanged.
- Shared: the ARG workspace query's parsing; the picker's states (`workspace-picker.test.tsx`).
- Part 2: `LogsClient` on canned answers (success, partial error, 400 with position, 403, 204, 504, oversized body);
  `LogsSchemaSource` caching and fallback; the token-host rule.

## Delivery

Part 1 ships on its own (with the shared list and picker) before part 2 starts. Each part is its own branch and PR.

## Left to the builder

- The 2-year cap and the 1-day `logs` default are my calls; change them if the services say otherwise.
- The `Prefer: wait` value (my call: 10 minutes, with the run's cancel button as the way out).
- Response size and row caps for `logs`, in line with `ArgRowsPerRun` and hunting's 50 MB.
- Icon, shortcut, file and class names, and whether `ServerRows` takes the Logs answer as-is or needs a small adapter.

## Owner decisions (2026-11-10)

1. **A workspace that arrives in a file is confirmed before it runs.** Imported or shared workbooks and saved queries, and
   solutions, keep the workspace they carry (`workbooks/import.ts` and sharing copy `workspaces` along with `timespan` and
   `scope`), but nothing with a workspace runs until the user confirms it. The confirmation is the review a file already gets
   before anything is saved or run (`ImportReview`, and the solution dialog): it gains a **Workspaces** section listing each
   workspace with its widget count, and Save / Install confirms (planner's call: the review already exists for this, and a
   prompt on first open would be lost after a restart). A saved query opened in a tab shows the workspace in the toolbar and
   runs only when the user runs it, as today.
2. **A saved workspace the account can't see blocks the run until a workspace is picked.** Before a hunting or `logs` run with
   a workspace, the source checks it against the cached ARG workspace list. Not in the list: the run doesn't start, the
   toolbar picker shows "contoso-sentinel isn't available to this account. Pick a workspace.", and a widget shows the same in
   its body. If the list can't be read, the run is blocked with the list's own error.
3. **Part 1 ships with the visible fallback note** and the best-effort `TenantId` mismatch warning. No "onboarded to Defender"
   check in v1.

4. **Solutions never carry a workspace** (owner, 2026-11-10): solutions are generic and workspaces are tenant-specific, so the
   host removes any workspace from a solution's queries and workbook widgets at install, and the user picks one afterwards.
   This replaces decision 1's solution-dialog confirmation for solutions.

Still open, not v1: a workbook parameter that picks the workspace, and several workspaces per query (stored as a list
already, limited to one). An empty-table filter for the schema panel is dropped for now.

## Mockups

`docs/design/mockups/`: `HuntingWorkspace.dc.html` (the picker on a hunting tab), `LogAnalytics.dc.html` (a `logs` tab),
`WorkspaceBlocked.dc.html` (a saved workspace this account can't see), `WorkbookConfirm.dc.html` (a workbook from a file asking
before it runs). `studio.css` gains the `logs` source badge.
