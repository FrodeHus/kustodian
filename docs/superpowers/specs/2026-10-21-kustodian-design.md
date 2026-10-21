# Kustodian design

Date: 2026-10-21. Status: for the owner's review (builder check done; the owner's answers are in section 15).

Kustodian is a desktop app for Windows, macOS and Linux. It runs KQL against three Microsoft sources for the one tenant you're
signed in to:

- **Microsoft Graph (beta)**, where KQL runs locally over Graph data. This is the hard part, and the reason the tool exists.
- **Defender advanced hunting**, through Graph's `security/runHuntingQuery`.
- **Azure Resource Graph**, through Azure Resource Manager.

Mockups (approved 2026-10-21): https://claude.ai/artifact/3fn5aBUiWTu7EMD7BFyYap. There are 10 boards: main window, light theme
with chart and compare, Explain, parameters and snippets, raw request tab, diagnostics, command palette and row details, sign-in,
hunting tab, and Azure Resource Graph tab.

Marking used below: **Owner** means the owner decided it. **My call** means I chose it on the owner's behalf; it can be changed.
Anything unmarked follows from those two.

## 1. Why

The owner built "Graph Query" inside RightSecurity Insights, a multi-tenant security portal. It turned out to be useful well
beyond that portal: an analyst who can write KQL can answer questions about an Entra tenant that Graph Explorer and the admin
portals can't answer in one step. One example is "applications with expired credentials, or with `externalAuthenticationType` set
to passthru". Kustodian takes what was learned there into a standalone tool anyone can run with their own account. It has nothing
to do with RightSecurity Insights and will move to its own repository (**Owner**).

Hunting and Azure Resource Graph were added (**Owner**) so the analyst has one KQL tool for identity, security events and Azure
resources. The UI follows the Graph query page and Defender advanced hunting, with one query per tab (**Owner**).

## 2. Goals

1. Run KQL over every Graph beta entity set the signed-in user can read. Missing permissions fail at column or table level with a
   clear message, never by crashing the run.
2. Run Defender advanced hunting and Azure Resource Graph queries in the same window, with the same results, export, saved queries
   and history.
3. Work the same on Windows, macOS and Linux, as one installable app (**Owner**).
4. Sign in with the Azure CLI's public client ID by default. Bring your own client ID as an option (**Owner**).
5. Include every feature listed in section 6 in v1 (**Owner**: "all of them").
6. Live in one self-contained directory, `kustodian/`, so moving it to its own repository means moving that directory and nothing
   else (**Owner**).

## 3. Non-goals

- **More than one tenant at once.** You query the tenant you signed in to (**Owner**). Switching accounts is allowed, but only one
  is active.
- **Joins across sources**, such as Graph users joined with hunting events (**My call**). Each tab runs against one source.
  Copy-paste and export are the bridge.
- **Writing to Graph or Azure.** KQL is read-only. The raw request tab is limited to GET (**My call**; see 6.9).
- **Sharing saved queries or any server component.** Everything stays on the user's computer (**My call**).
- **An audit log** (**My call**). It's a single-user tool; Recent runs is the history.
- **Auto-update** in v1 (**My call**). Releases are downloads from GitHub releases.
- **Brief widgets, dashboards and scheduled queries.** These were deferred in the portal version and stay out here.
- **Graph's advanced query mode** (`ConsistencyLevel: eventual`, `$count`, `$search`). The portal excluded it, and the pushdown
  rules below depend on that.

## 4. Anti-goals

These would make Kustodian a failure even if every feature worked:

- A query that silently returns fewer rows than KQL alone would have. A pushed-down `$filter` must never drop a row the KQL keeps
  (section 7.4).
- A runaway query that freezes or crashes the window, or eats the machine's memory. The engine runs in a separate process that is
  killed on timeout or memory limit.
- Tokens on disk in plain text, or sent anywhere but Microsoft.
- Any RightSecurity Insights or Sopra Steria name, look or branding (**Owner**). Kustodian has its own look (the mockups'
  `studio.css`).
- A platform that is second class: a feature that works on Windows but not on Linux doesn't ship.

## 5. Stack (all **My call**; the owner left it to me)

| Part | Choice | Why |
| --- | --- | --- |
| Host | .NET 10, a single executable per platform | The Graph planner, reader and engine already exist in .NET and get ported. |
| Window | Photino.NET (WebView2 on Windows, WKWebView on macOS, WebKitGTK on Linux) | A native web view, with no bundled Chromium. Small download. |
| UI | React + TypeScript + Vite, Tailwind, shadcn/ui-style components, Recharts | Same toolkit as the portal version, without its design. |
| Editor | Monaco with `@kusto/monaco-kusto` | KQL completion and diagnostics like Microsoft's own tools. |
| KQL parsing and planning | `Microsoft.Azure.Kusto.Language` | Typed schema (GlobalState) and completion. |
| Local engine | KustoLoco (MIT), in-memory KQL | Runs the Graph source's KQL. |
| Sign-in | MSAL.NET public client + `Microsoft.Identity.Client.Extensions.Msal` token cache | System browser with loopback redirect; device code as fallback. |
| Grid | TanStack Table + TanStack Virtual | Virtualized rows. |

The UI talks to the host through Photino's message channel: JSON requests and responses with an id, and streamed progress events.
There is no HTTP server and no open port (**My call**: nothing on the machine can call into the app).

**Builder to verify early:** that `@kusto/monaco-kusto` runs in all three web views, particularly WebKitGTK. Its language service
runs in a web worker. If it doesn't run, the fallback is completion from the host's `Kusto.Language` over the message channel,
which the portal already does for nested fields.

## 6. Features

### 6.1 Window and tabs

- One window with a tab per open query, as in Defender advanced hunting (**Owner**). Each tab has a source badge: GR (Graph), AH
  (advanced hunting) or ARG (Azure Resource Graph). An unsaved tab shows a dot.
- The `+` menu opens a new tab for each source, or a raw Graph request (mockup: Main).
- Each tab has its own editor, results, parameters and, for Azure Resource Graph, its own scope.
- Open tabs, unsaved text, each tab's source and scope, and the active tab come back after a restart. They are written to disk
  about a second after each change.
- The left side panel follows the active tab's source: Schema, Saved, Recent and Snippets.

### 6.2 Editor and running

- KQL completion and errors from the active source's schema, including nested fields (`onPremisesPublishing.▮`) and fields of
  collection elements after `mv-expand`.
- Run (Ctrl/Cmd+Enter) runs the block under the cursor: the lines between blank lines, as in Kusto Explorer. With a selection it
  runs only the selection. Shift+Enter runs the whole tab.
- Cancel stops a run. On the Graph source that kills the engine worker if it is running.
- Format, Save (Ctrl/Cmd+S), Save as, Open `.kql`, and dropping a `.kql` file on the window.
- A command palette (Ctrl/Cmd+K, also Ctrl/Cmd+Shift+P) for every command, saved query and snippet (mockup: Palette).

### 6.3 Parameters

`{name}` placeholders in a query become fields in a parameters form (mockup: Parameters). The types are text, number, timespan
(`7d`), datetime, and list (one value per line, emitted as a KQL `dynamic([...])` or `("a","b")` depending on context). Values
are substituted as properly escaped KQL literals before the query is parsed. Parameters and their last values are saved with the
query. A run with an empty required parameter is refused with a message pointing at the field.

### 6.4 Snippets

Snippets come from a built-in starter library per source, plus the user's own. Graph examples: expired app credentials, passthru
apps, stale guests, risky service principals, apps with owners outside the tenant. Hunting examples: TOR sign-ins, rare process
launches. Azure Resource Graph examples: public storage accounts, VMs without disk encryption, role assignments at subscription
scope. A snippet inserts at the cursor or opens in a new tab. The user's own snippets are saved like queries.

### 6.5 Results

- Result tabs: Rows, Chart, JSON and Diagnostics (mockups: Main, Light, Diagnostics).
- Grid: virtualized; sort; filter; hide and reorder columns; group by a column; show a cell as formatted JSON; copy cells or rows
  as CSV, Markdown or JSON.
- Row details: a side sheet with every column of a row, dynamic values expanded (mockup: Palette).
- Chart: chosen from the result's shape. The types are column, bar, line, area, pie and time chart, and `render` in the KQL picks
  the type.
- Export: CSV, Excel-friendly CSV (UTF-8 BOM, `;` separator when the locale uses decimal commas), JSON, and Markdown. Export writes
  every row of the result, not only the visible rows.
- Compare: pin a run, then run again and view the two side by side, or as a diff of rows by a chosen key column (mockup: Light).
- Run statistics in the result's status line: rows, duration, requests sent, and what came from cache.

### 6.6 Saved and Recent

- Saved queries live in a local library. Each one stores its name, source, text, parameters, ARG scope, and created and modified
  times. Folders are a single level deep (**My call**).
- Recent keeps the last 100 runs (**My call**; the portal kept 50). Each run stores its source, text, parameter values, start
  time, duration, row count and outcome, but no rows.
- Nothing is shared, and there is no server.

### 6.7 Sign-in and accounts (mockup: SignIn)

- **Default client:** the Azure CLI public client `04b07795-8ddb-461a-bbee-02f9e1bf7b46`, delegated (**Owner**). Tenant
  `organizations` unless the user types one.
- **Bring your own client ID:** a public client app registration with `http://localhost` as a mobile/desktop redirect URI. The
  user can set a tenant ID for single-tenant apps.
- **Interactive flow:** sign-in opens in the system browser with a loopback redirect. Device code is the fallback (for Linux
  without a desktop browser, or locked-down machines).
- **Tokens per audience:** Graph uses `https://graph.microsoft.com/.default` and ARM uses `https://management.azure.com/.default`.
  Both come from the same account and client, one token each. The ARM token is requested the first time an ARG tab runs, so a user
  who never uses ARG never sees an ARM consent prompt.
- **Token cache:** the OS keychain through MSAL's cache extension: DPAPI on Windows, Keychain on macOS, libsecret on Linux. If
  libsecret isn't available, there is no persistent cache: the user signs in each time the app starts, and a notice explains why.
  Tokens are never cached in plain text (**My call**).
- **Accounts:** several accounts are remembered. One is active at a time (**Owner**: one tenant). Switching accounts closes no
  tabs. Each run uses the account that is active when it starts.
- **"What this sign-in can read":** the token's `scp` claim, shown as chips.
- **Always `.default`, no incremental consent in v1** (**My call**). One token per audience per account. With the Azure CLI
  client the user can't add permissions anyway. With their own client, they add the permission to their app registration and
  sign in again; the No permission error says so. A "Grant access" button that asks for one missing scope can come later.

### 6.8 Explain (Graph only; mockup: Explain)

Explain shows what a Graph query would send, without sending it. For each table it shows the Graph URL with `$select` and
`$filter`, which parts of the `where` were pushed to Graph and which run locally (with the reason for each), which columns need
per-object reads, and the budgets that apply. It uses the same planner as Run.

### 6.9 Raw request tab (mockup: RawRequest)

Like Graph Explorer: a method, a URL relative to `https://graph.microsoft.com/{beta|v1.0}`, headers, and a response with status,
headers and formatted JSON. The URL bar uses the schema to complete entity sets and properties. Paging follows `@odata.nextLink`
on request. GET only (**My call**). A JSON array in a response can be opened as a KQL tab: the user picks the array, it becomes a
`datatable`, and the tab runs on the local engine.

### 6.10 Diagnostics (mockup: Diagnostics)

A per-run log of every request made: URL, status, duration, bytes, and retries with `Retry-After`. It also shows throttling, probe
steps (which columns were dropped and why), per-object batch reads, cache hits, and engine worker events (start, memory peak,
kill). It is copyable as text for bug reports. Tokens and `Authorization` headers are never logged.

### 6.11 Comfort

- Light and dark themes, plus "follow the OS". Dark is the default (mockups).
- Fonts: Inter for the UI and JetBrains Mono for code, bundled with the app, never fetched from the network (**My call**).
- Every action works from the keyboard, and the shortcuts are listed in the command palette.
- Settings cover limits (section 9), theme, the raw request tab's default Graph version, and client ID and tenant.
- Graph KQL tabs are always beta, with one beta schema (**My call**). The version setting affects only the raw request tab.

## 7. Microsoft Graph source

This is ported from RightSecurity Insights' `src/Insights.Graph`, `src/Insights.GraphEngine` and `tools/graph-schema`. It is
copied and adapted, not referenced: Kustodian must build without the Insights tree (section 10). Everything that tree learned
against live tenants comes along. The rules below come from bugs found there, so keep them unless a test proves one wrong.

### 7.1 Schema

- Built at build time from Microsoft's described beta CSDL, `microsoftgraph/msgraph-metadata`
  `clean_beta_metadata/cleanMetadataWithDescriptionsAndAnnotationsbeta.xml`, by the bundled schema tool. The output is embedded in
  the app, and the tool can be re-run to pick up changes (the owner asked for this in the portal version).
- **Tables:** every entity set and listable navigation collection, with descriptions. Each column carries flags:
  - its `$filter` operators;
  - `selectOnly`: only returned for a single object, so it is read per object;
  - collection, with its element type;
  - whether it is listable;
  - whether its table is a directory object.
- **Excluded:** `me_*` tables. They work with a delegated token, but they duplicate `users` for one row, and the portal dropped
  them (**My call**: keep them out for v1).
- **Not listable:** `Edm.Stream` columns, such as an application's `logo`. Selecting one makes IIS return an HTML 404 through
  Graph.
- **Permissions per table** (**My call**): the schema tool reads a second input, Microsoft's permissions data in the same
  `msgraph-metadata` repository (permissions by API path). It records the least-privileged delegated permissions for listing each
  table. Explain's "Permissions this uses", the No permission error and the sign-in chips name these.
- **Columns have no permission data.** Microsoft doesn't publish column-level rules. A denied column shows "Graph refused this
  column (403); it may need a higher permission or role" and links to the table's docs. A small hand-kept list in the schema
  tool names the few that are known, starting with `application.onPremisesPublishing` → `Directory.ReadWrite.All`, which is what
  the Diagnostics mockup shows.

### 7.2 Planning

- KQL is parsed with Kusto.Language against the schema. The planner works out, for each table, the `$select` (only the columns the
  query uses) and the `$filter` it can push down.
- Parsing runs with the invariant culture: Kusto.Language reads real and timespan literals in the current culture, which broke
  under the Norwegian culture in the portal.
- These are rejected with a clear message: `cluster()`; `database()` with any name but `graph`; queries that produce more than one
  result; external data operators. The engine's external-data resolver always refuses.

### 7.3 Fetching

- `GET https://graph.microsoft.com/beta/{set}?$select=…&$filter=…&$top=999`, following `@odata.nextLink` only when its host is
  Graph's.
- **Budgets** (defaults, editable in Settings):
  - 50,000 objects per table;
  - a fetch budget for each run;
  - raw bytes counted ×3 as an estimate of memory once parsed.
- **Throttling:** honour `Retry-After` on 429 and 503, with a bounded wait.
- **A 400 caused by the filter:** refetch the table without `$filter`, and let KQL filter locally.
- **Probing columns** when the first page fails with a 4xx (other than 429) and the `$select` names more than `id`:
  - halve the `$select` and fetch `$top=1` to find which columns Graph refuses, up to 16 probes;
  - 401 or 403 on a column marks it **Denied**: its values are empty, with "needs a permission you don't have";
  - any other client error marks it **not listable**: it is read per object if it is `selectOnly`, otherwise left empty with
    Graph's reason;
  - the run continues with the rest.
- **Graph's error text** can be backend IIS HTML passed through as the JSON message. Show the status and a short summary, not the
  HTML.

### 7.4 `$filter` pushdown rules

A pushed filter must keep at least every row the KQL keeps. KQL re-applies every condition locally anyway.

- Only operators the column's annotations allow.
- Never push an empty string.
- Case-insensitive operators (`=~`, `in~`, `startswith`) only on directory-object tables. Elsewhere Graph may compare
  case-sensitively.
- datetime `>` and `<` are pushed as `ge` and `le`.
- No `ne` or null pushdown on directory objects, because those need advanced query mode.
- `isnotnull` on text columns is never pushed.
- `or` is pushed only if both sides can be pushed. `not` is never pushed.

### 7.5 Per-object reads

For `selectOnly` columns the query uses, the reader runs `GET /{set}/{id}?$select=…` through `$batch`: 20 requests per batch, 4
batches in flight, at most 2,000 objects per table. Past the cap, the remaining rows get empty values and a warning chip. Results
are cached for 30 minutes per account, entity set, id and column set. "Clear cache" is in Settings and in the command palette.

### 7.6 Engine

- KQL over the fetched rows runs in KustoLoco in a **separate process**: the same Kustodian executable started with `--engine`, so
  there is one binary to ship (**My call**).
- **Protocol:** length-prefixed JSON frames over stdin and stdout.
- **Limits:** each worker gets a hard heap limit (`DOTNET_GCHeapHardLimit`). A watcher kills the worker if its memory passes the
  limit or the run passes the timeout, and the run reports which limit was hit.
- **Pool:** workers start on demand, a pool of 2 by default (**My call**). A crash guard pauses the pool only after repeated
  crashes it can't explain; timeouts, memory kills and cancels don't count.
- Cells longer than 1,000 characters are cut in the grid, except numeric and date series. Export and JSON get the full value.

## 8. The two server-side sources

Both run KQL on Microsoft's side, so the planner, reader, engine, Explain, probing and per-object reads don't apply.

### 8.1 Defender advanced hunting

- **Endpoint:** `POST https://graph.microsoft.com/v1.0/security/runHuntingQuery` with `{ "Query": "…", "Timespan": "P30D" }`. The
  older Defender advanced hunting endpoints (`api.security.microsoft.com/api/advancedhunting/run`, `…/advancedqueries/run`) are
  retired and stop returning data on 2027-02-01. Kustodian never uses them (**Owner**).
- **Timespan:** a picker in the tab toolbar (1, 7 or 30 days, or custom), saved with the query.
- **Schema:** `GET https://graph.microsoft.com/beta/security/getHuntingSchema` (**My call**, over the portal's
  `getHuntingSchemaTables`, because it also returns functions). It returns the tables, columns and functions this user may query.
  It is cached per account for 24 hours and refreshed on demand. Tables the user can't see aren't offered. The mockup's footer
  text changes to match.
- **Fallback schema:** a bundled hunting schema and built-in function list ship in v1, used when the beta endpoint refuses or
  fails (**My call**). Both are copied from the portal's `src/Insights.Defender/Hunting` (`hunting-schema.json` and its function
  list), which the owner allows (section 15).
- **Permission and role:** `ThreatHunting.Read.All` (delegated), plus a Defender XDR RBAC role or an Entra role such as Security
  Reader. A 403 shows exactly that.
- **Microsoft's limits:** 30 days of data, 100,000 rows, 50 MB results, 3 minutes per request, about 45 calls a minute, and a CPU
  quota per tenant on a 15-minute cycle. A 429 shows the body's explanation of which limit was hit.

### 8.2 Azure Resource Graph

- **Endpoint:** `POST https://management.azure.com/providers/Microsoft.ResourceGraph/resources?api-version=2024-04-01` (or newer)
  with `query`, `subscriptions` or `managementGroups`, and `options` (`$top` 1,000, `$skipToken` paging, `resultFormat:
  objectArray`).
- **Scope picker:** subscriptions (multi-select), a management group, or "all I can see" (mockup: ResourceGraph). The scope is
  saved with the query. Subscriptions are listed from ARM `GET /subscriptions`, and management groups from `GET
  /providers/Microsoft.Management/managementGroups`.
- **Schema for completion:** a bundled table list (`Resources`, `ResourceContainers`, `AuthorizationResources`,
  `SecurityResources`, `PolicyResources`, `AdvisorResources` and the others Microsoft documents), each with its common columns.
  `properties` is dynamic. Resource types for the side panel come from a `Resources | distinct type` query, cached for 24 hours.
- **Limits:** ARG supports a subset of KQL. Errors from ARG are shown verbatim with the position they point at. Paging is followed
  up to the row limit in Settings (default 50,000; **My call**). Throttling headers are honoured.

## 9. Limits and settings

| Setting | Default | Notes |
| --- | --- | --- |
| Graph objects per table | 50,000 | As in the portal. |
| Graph fetch budget per run | 512 MB estimated | **My call**: more than the portal's 384 MB, since a desktop has more memory than a container. |
| Engine timeout | 120 s | **My call**: the portal used 30 s. A desktop user is waiting for their own query. |
| Engine heap limit per worker | 1 GB | **My call**. |
| Engine workers | 2 | **My call**. |
| Per-object reads per table | 2,000 | As in the portal. |
| Per-object cache | 30 min | As in the portal. |
| ARG rows per run | 50,000 | **My call**. |
| Rows shown in the grid | everything returned | The grid is virtualized. |

## 10. Repository layout and build

Everything lives under `kustodian/` at the root of this repository until it moves (**Owner**). Nothing in it references anything
outside it, and nothing outside it references it.

```
kustodian/
  README.md, LICENSE (MIT), .editorconfig, .gitignore
  global.json, Directory.Build.props, Directory.Packages.props, Kustodian.slnx
  src/Kustodian/                 host: Photino window, message channel, sign-in, storage, settings, --engine entry point
  src/Kustodian.Graph/           schema, planner, filter translator, reader, batch reader, cache
  src/Kustodian.Engine/          KustoLoco worker logic
  src/Kustodian.Sources/         hunting and Resource Graph clients
  web/                           React UI (package.json, vite, oxlint, tsc)
  tools/schema/                  schema generator
  tests/…                        xUnit per project; Vitest for web
  docs/                          this design, the plan, user docs
  .github/workflows/ci.yml       build and test on windows-latest, macos-latest, ubuntu-latest
```

- **Warnings are errors**: `dotnet build -warnaserror`, oxlint, and `tsc`. No suppressions (this repository's rule, carried over).
- **The web UI** is built by Vite and embedded in the host as resources, so the app is one file plus the platform's web view.
- **Publish** is self-contained per runtime identifier: `win-x64`, `win-arm64`, `osx-arm64`, `osx-x64`, `linux-x64`.
  - Windows: a zip, plus an MSIX or installer later.
  - macOS: an `.app` in a zip or dmg.
  - Linux: a tarball and an AppImage.
  - Linux needs WebKitGTK 4.1 and libsecret from the distribution; the README lists the packages.
- **The CI workflow** lives in `kustodian/.github/workflows/`. GitHub only runs workflows at a repository's root, so it starts
  running once the directory is its own repository. Until then, the builder runs the same commands locally and on the owner's
  Windows VM.

## 11. Local storage

Storage lives in the per-user app data folder: `%APPDATA%\Kustodian` on Windows, `~/Library/Application Support/Kustodian` on
macOS, and `$XDG_CONFIG_HOME/kustodian` (default `~/.config/kustodian`) on Linux. The files are JSON, each with a `version` field
for later migration:

- `settings.json`
- `saved/` with one file per saved query (so a sync tool can merge them)
- `snippets/` for the user's own snippets
- `recent.json`
- `session.json` for open tabs and unsaved text
- `accounts.json` for account metadata only; tokens live in the keychain

Writes are atomic: write a temporary file, then rename it. A corrupt file is moved aside as `*.corrupt` and the app starts with
defaults, saying so.

## 12. Errors

Every failure lands on the tab, never in a modal and never as a crash:

- **No permission** (table or column): which permission or role is missing, and a docs link.
- **Throttled:** which limit, and when to retry.
- **Too large:** which budget was hit, and a suggestion to add a filter or `project`.
- **Engine killed:** timeout or memory, with the limit that applied.
- **Sign-in needed:** a button to sign in again. The query text is kept.
- **Graph or ARM error text**, cleaned of HTML.

## 13. Testing and verification

- **Unit tests** for everything ported: planner, pushdown rules (one test per rule in 7.4), reader (paging, probing, 4xx
  handling, budgets), batch reader, cache, engine protocol and kill paths. The portal's tests come across with their scenarios.
- **Sources:** an `HttpMessageHandler` stub replays recorded Graph, hunting and ARG responses, scrubbed of tenant data.
- **Web:** Vitest and Testing Library for the UI, parameters, grid, export and session restore.
- **Manual checks on all three platforms** before v1, against a real tenant, with a checklist in `docs/`: sign in with the Azure
  CLI client and with your own client; the expired-or-passthru Graph query; a hunting query; an ARG query across two
  subscriptions; cancel during a long run; killing the engine by memory; restarting with unsaved tabs; a missing keychain on Linux.

## 14. Risks to check early

1. **Azure CLI client and hunting.** The Azure CLI client is pre-authorized for many Graph scopes, but `ThreatHunting.Read.All`
   may not be among them in every tenant. If `.default` doesn't include it, the hunting tab must say so plainly and suggest your
   own client ID. Verify against a tenant in week one.
2. **monaco-kusto in WebKitGTK** (section 5).
3. **Photino on Linux:** dependencies differ across distributions. Test on Ubuntu LTS and Fedora at least.
4. **Unsigned builds** (section 15): Gatekeeper blocks an unsigned macOS app by default, and SmartScreen warns on Windows. The
   README must walk through opening it anyway, and the manual checks include a fresh download on each platform.

## 15. Owner's answers (2026-10-21)

1. **Ported code:** the owner owns the RightSecurity Insights Graph code and the hunting fallback schema. They may be copied into
   Kustodian and relicensed (**Owner**).
2. **License:** MIT (**Owner**).
3. **Signing:** v1 ships unsigned builds. The README explains the Gatekeeper and SmartScreen steps. Signing comes later
   (**Owner**).

## 16. What is left to the builder

- **Internal structure:** names of types, the message-channel contract, and the component breakdown in the UI.
- **Details in section 6 that don't change behaviour**, such as exact shortcuts beyond those listed, chart styling, and snippet
  wording.
- **Library versions**, as long as each is current and its licence permits redistribution.
