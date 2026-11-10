# Changelog

All notable changes are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions
follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **Highlight rules**: colour the rows or cells that need attention. Right-click a value on the Rows tab and choose Highlight
  rows where the column equals it (or is empty) to open a prefilled popover with a colour, row or cell, and Add. For rules such
  as `days > 90` on one cell, open **Highlight rules…** from the cell menu or a column header's menu; once a tab has rules, a
  **Highlight · n** chip under the result bar opens the list too. A rule is a column, an operator (`==`, `!=`, `>`, `>=`, `<`,
  `<=`, contains, !contains, isempty, isnotempty), a value and a colour (danger, warning, success or info), up to 20 per query.
  The first matching row rule colours the row and the first matching cell rule colours the cell; numbers, dates (UTC ISO 8601),
  timespans, booleans and text (not case-sensitive) compare by their type. The list edits every part of a rule and reorders
  with Move up and Move down or Alt+Up and Alt+Down. A rule on a column a rerun no longer returns is kept and says **Not in
  this result**. Rules stay with the query: on its tab (changing them makes it unsaved), across restarts, and in a saved library
  query, which brings them back when opened. A `.kql` file holds only the query text, so saving to a file doesn't keep them.
  Table widgets apply their query's rules and the widget editor has a Highlight tab; a widget linked to a saved query follows
  that query's rules. Workbook export and import carry rules, and solutions can include them.
- **Grouping by several columns**: group the Rows tab by up to three columns, from a column header's menu (Group by this
  column) or the Group by menu. A **Grouped by** chip clears it, a group row has Filter by and Exclude on the tabs where the
  smart filter is offered, and a tab keeps its grouping across tab switches and reruns while Kustodian runs (it isn't saved,
  and a column a rerun no longer returns is dropped).
- **Column statistics**: a column header's menu shows the column's distinct and empty counts, its top 10 values with their
  share, and min, max and average for numbers or earliest and latest for dates, from the rows shown. Filter by or Exclude a
  top value from there, on the tabs where the smart filter is offered.
- **Smart filter**: right-click a value on the Rows tab, or use Filter… in row details, to add a `| where` line for it, or to
  exclude it. Dates also offer On or after and Before. The line goes into the query so you can keep it (one undo removes it),
  and the query reruns. On Graph tables it is placed so Graph filters it as `$filter` where it can.
- **Log Analytics source**: a fourth source that runs KQL directly against one Log Analytics workspace, in tabs
  and in workbook widgets. Pick a workspace (there is no Primary workspace); completion and the schema panel list that
  workspace's tables.
  The timespan starts at 1 day and goes up to 730. It needs the Log Analytics API `Data.Read` permission and Reader or Log
  Analytics Reader on the workspace; the run offers **Grant Log Analytics access** when consent is needed. Community
  solutions never carry a workspace. See [docs/EntraPermissions.md](docs/EntraPermissions.md#log-analytics).
- **Hunting in a workspace**: a Workspace picker beside the hunting timespan sends the query to a Log Analytics workspace. The
  default, **Primary workspace**, sends none. The workspace is saved with the query, in history and in workbook widgets, and
  with one the timespan goes up to 730 days (a 90-day preset is added; without one it stays at 30). Workspaces are listed
  through Azure Resource Graph, and querying one needs Microsoft Sentinel Reader on it. If Defender can't reach it, it answers
  from your primary workspace; Kustodian says so on every workspace run and warns when the result's `TenantId` shows rows from
  another workspace. Choosing Primary workspace with a timespan over 30 days brings it back to 30 days. A saved workspace this
  account can't see blocks the run, and so does a workspace list that can't be read. The schema panel doesn't list a workspace's
  Sentinel tables yet; queries on them still run. See [docs/EntraPermissions.md](docs/EntraPermissions.md#hunting-in-a-workspace).
- **Workspaces in workbooks**: a widget can have a workspace, and the workbook's timespan parameter keeps each widget's.
  Importing a shared workbook file lists the workspaces it queries, named from your own workspace list by ID, and waits for
  that list before it saves or opens. Community solutions never install a workspace; pick one after installing.
- **Stat unit**: a Stat widget can show a unit after its number, such as `%`, `ms` or `days`. Set it under Visualization
  in the widget editor.
- **Aurora theme**: Kustodian's own dark theme, from the logo and banner: navy ink with cyan, blue, violet and mint, a soft
  glow behind the workspace, and cards and workbook widgets tinted blue to violet. Pick it in Settings.
- **Light themes**: GitHub Light, One Light, Catppuccin Latte and Solarized Light, with the editor in each theme's own light
  colours. Pick one in Settings.
- **Defender for Cloud solution**: secure score, recommendations, compliance, Defender for Servers Plan 2 coverage, attack
  paths and alerts from Azure Resource Graph and advanced hunting, with a posture workbook. See
  [docs/solutions.md](docs/solutions.md#solutions-that-ship-now).
- **Pinned saved items**: pin a saved query or workbook from its row menu to keep it in a Pinned group at the top of the
  Saved panel, in the order you pinned them.
- **Graph schema updates without a release**: at start, Kustodian checks the repository's `GraphSchema/` folder for a newer
  Graph schema, checks it and downloads it, and the footer says to restart to use it. Settings has a **Graph schema** card
  showing the schema in use, with **Refresh now**.
- **Print or save a workbook as PDF** from the workbook's ⋯ menu. It prints as a report in the light theme: no controls, the
  parameters as a table of their values, every tab of a tabs widget under its own heading with its charts and tables (tabs that
  haven't run run first), and Markdown widgets in full rather than cut off at the widget's height. A table widget prints its first 500 rows in full, wrapped to
  the page, and says how many more there were.

### Changed

- **Charts**: smooth curves, areas that fade to transparent, a soft glow on lines, rounded bars and a donut for pie, on a
  lighter grid. Charts animate in as they draw; not with reduced motion turned on, for very large results, or when a workbook
  prints.
- **Group by**: on query tabs the Group by menu now takes several columns (up to three, nested), and groups are sorted by
  size, largest first, at every level, also in workbook tables and the Compare view, which keep a single column.
- **A little colour**: each side panel's icon on the rail has its own colour from the theme, and each query tab has a stripe
  along its top in its source's colour: blue for Graph, amber for advanced hunting, green for Resource Graph.
- **Workbook widget headers** have more room for the title: the source badge is gone (the widget editor still shows the
  source), and a run's time shows only when it took 5 seconds or more, in the corner beside the parameters icon.
- **Workbook editing**: while you drag or resize a widget the others move to where they'll end up, and the drop outline
  shows over them. The column stripes behind the grid are gone. A ✎ button beside ⋯ edits a widget; Edit widget, Duplicate
  and Remove are in ⋯, so small widgets no longer overflow, a widget with no query yet shows **Set up widget**, and the workbook parameters a widget uses are a link icon in
  its corner, named on hover.
- **Workbook parameters**: each parameter's label sits above its control in a grid. A list that takes several values picks
  them from a menu of checks, and a few short choices show as a row of buttons. A dot marks a value changed from its default,
  and Reset puts them back. The panel collapses to one line of values. Fields fill their column and labels stay on one line
  (the whole label shows on hover), so a row of controls lines up.
- Graph queries that run locally use KustoLoco 1.5.1, which fixes constant-only `project` and constant `where` over no
  rows itself. Kustodian no longer rewrites those queries before it runs them.
- **Saved panel**: queries and workbooks are now on separate **Queries** and **Workbooks** tabs, each with its own search.
  Queries named `Prefix / name` fold under a `Prefix` folder when two or more share it. **Import workbook…** is at the
  bottom of the Workbooks tab.

### Fixed

- **Workbook widgets can fix their own access**: a widget refused for want of access showed Grant access and Refresh
  access buttons that could never be clicked, so you had to rerun the query in a query tab. They now work in the widget, and
  while any widget lacks access the workbook toolbar shows **Refresh access** next to Refresh all, which grants or refreshes
  what the failed widgets need and then refreshes the workbook.
- **Failed run messages are readable**: when a query or a workbook widget failed (no permission, say), the message
  was squeezed to one letter per line and its report ID ran over the buttons beside it. The status line now wraps.
- **Vulnerability management tables in advanced hunting**: `DeviceTvmSoftwareVulnerabilities` and the other `DeviceTvm*`
  tables were missing from the schema panel and completion, because Graph's hunting schema doesn't list them. They now come
  from the bundled schema when the tenant's leaves them out.
- **Break-glass workbook**: the tenant checks failed with "Resource not found for segment
  'authenticationMethodsPolicy/authenticationMethodConfigurations'". Graph doesn't list the authentication method
  configurations, so `policies_authenticationMethodsPolicy_authenticationMethodConfigurations` is now read from the
  policy, which returns them all, and its `where`s run locally.

## [1.1.0] - 2026-11-08

### Added

- **Authentication methods and requirements**: `users.authenticationMethods` lists each user's registered sign-in methods
  (FIDO2 keys with their model and AAGUID, phones, passwords, ...), and `users.authenticationRequirements` holds their
  per-user MFA state. Both are read one object at a time like the other relationship columns, with the same 100-object cap
  and notices. See [docs/README.md](docs/README.md#relationships).
- **Nested group membership**: `users.transitiveMemberOf` lists every group a user is in, also through other groups, as
  Conditional Access sees it. It is the only transitive relationship column. The break-glass checks now count exclusions,
  roles and FIDO2 targets through nested groups. See [docs/README.md](docs/README.md#relationships).
- **Derived-type columns**: Graph tables that list objects of several types, such as the authentication method
  configurations or named locations, now have the derived types' properties as columns (empty on other types' rows) and an
  `odataType` column, so `keyRestrictions` and `includeTargets` of the FIDO2 policy can be queried. A query that uses one is
  read without `$select`. See [docs/README.md](docs/README.md#derived-types).
- **Single Graph objects**: Graph paths that hold one object, such as Security Defaults
  (`policies_identitySecurityDefaultsEnforcementPolicy`), the authentication methods policy and the default app management
  policy, are now tables with one row, and so is `me`, the signed-in user. `where`, `take` and `count` on them run locally.
  Columns that hold a secret (a certificate's password or content, an enrollment token) are left out. See
  [docs/README.md](docs/README.md#single-objects). The **Entra ID** solution's break-glass workbook now checks that Security
  Defaults are off (`TNT.SecurityDefaultsOff`).
- **Entra ID solution**: one solution for Entra ID reviews. It adds a **Break-glass account compliance** workbook: the
  accounts' Conditional Access exclusions, hardening, Global Administrator assignment, sign-ins, groups and tenant
  guardrails, one row per check with PASS, FAIL, WARN, INFO or ERROR, for the accounts you list in a workbook parameter.
  It replaces the **Entra risky users** and **MFA and passkey adoption** solutions, whose queries and workbooks it now holds.
  See [Solutions/entra-id/README.md](Solutions/entra-id/README.md).
- **Typed tool values**: an `each` tool's parameter can take **A value I type** instead of a column, the same text for every
  row, so one tool can set, say, the company you type on all the selected users. See [docs/external-tools.md](docs/external-tools.md).
- **Resizable panes**: drag the edge of the side panel, or the line between the query and its results, to resize them.
  Tab to either and use the arrow keys to do the same from the keyboard.
- **Workbook tabs**: workbooks can group widgets in tabs. Only the tab you're looking at runs its queries; the others show
  "not run" or "out of date" until you open them. Widgets move between tabs by drag or **Move to…**. A workbook with tabs
  needs this version or later. See [docs/workbooks.md](docs/workbooks.md#tabs).
- **Community Solutions**: a **Solutions** panel in the rail lists ready-made queries and workbooks from the `Solutions/`
  folder of the Kustodian repository, with **Kustodian** and **Community** badges. Open one to read its README and tick the
  items to install into a library folder named after it, with new ids; nothing runs on install. Uninstall removes what you
  haven't changed and keeps the rest in Saved, offline too and after a solution leaves the catalog. The last catalog is
  kept for offline use, every solution file downloaded is checked against its SHA-256 and size, and the catalog index has a
  4 MB limit. **Entra ID** and **Defender vulnerability patch SLAs** ship first. See
  [docs/solutions.md](docs/solutions.md).
- **Workbooks**: a tab of Markdown, Chart, Table and Stat widgets on a grid, each running a query written in the widget or a
  linked saved one, on any source. Workbook parameters rerun only the widgets that use them, and widgets can show their own.
  Edit mode (mouse or keyboard) arranges widgets, and workbooks save to the library and come back after a restart. A
  workbook tab gets the full width: the side panel stays closed until you open one from the rail. See
  [docs/workbooks.md](docs/workbooks.md).
- **Tool buttons on table widgets**: tick rows in a table widget and run one of your external tools on them with a button
  such as `Stop VM · 2`. The button names a tool in your `tools.json` and maps its parameters to columns; it runs on the
  selected rows, or on all rows the filter shows when none are selected, and always asks first. See
  [docs/workbooks.md](docs/workbooks.md#selection-and-tool-buttons).
- **Share workbooks**: Export… in a workbook's ⋯ menu writes a `.kustodian-workbook.json` file with its layout, queries,
  parameter defaults and tool-button settings, never results or tokens. Import… in the Saved panel, or Import workbook… in the
  palette, shows a review first: saved queries are added to your library or copied into the widgets, tool buttons are matched
  by name to your own `tools.json` (which import never changes), and a workbook you already have can be kept alongside or
  replaced. See [docs/workbooks.md](docs/workbooks.md#sharing).
- **Widget history**: a workbook widget can keep its own history, off by default. Values over time stores small results so a Stat
  shows its change and a Chart plots it. Row tracking follows rows by key columns so a Table shows what is new or no longer
  reported since a date. Local only, in `history.db`, never exported. See [docs/workbooks.md](docs/workbooks.md#history).
- A **Full screen** button on the Chart tab fills the app window with the chart; click it again or press Esc to go back.
- Click a column, bar, pie slice or point in the Chart tab to see the rows behind it on the Rows tab. It filters the
  result you already have, without running the query again; a chip in the result bar shows the filter and clears it.
- Two new themes, **Glass** and **Liquid glass**: frosted panels over a colourful backdrop. Liquid glass adds rounder,
  pill-shaped controls. Pick one in Settings or the command palette.
- Ten themes from the most used editor themes: GitHub Dark, One Dark, Dracula, Material, Monokai, Ayu Dark, Night Owl,
  Tokyo Night, Catppuccin Mocha and Gruvbox Dark. Each colours the window and the KQL editor.
- A **Run tool** menu on the Rows tab runs your own commands on the selected rows: once per row with `{column}` values as
  arguments, or once with the rows as JSON on stdin. Set them up in **Settings › External tools**, one box per argument,
  or by hand in `tools.json`. See [docs/external-tools.md](docs/external-tools.md).
- Error reports, off until you opt in: when Kustodian fails in a way it shouldn't, it sends the error's types, where in
  Kustodian's code it happened, the recent steps before it as codes, the app version and the OS. Never your tenant,
  account, queries, values, results or error messages. See [what is sent](https://frodehus.github.io/kustodian/telemetry.html).
- Every error now shows a report ID and **Send details**, which shows the full report for that one error (query, messages,
  Graph's answer, engine output) and sends it only when you click **Send**, with any parts you untick left out.
- A query refused for permission offers **Refresh access**, which gets a new access token so a role you activated since
  (through PIM, say) counts, then runs the query again. When the token can't be refreshed silently, the browser opens to
  sign in.
- The Chart tab lets you pick the x axis from the result's columns and tick which number columns to draw, for every chart
  type. A result of one row with several number columns charts those columns side by side, one bar each.
- A **Split by** picker on the Chart tab draws a value once per value of another column, as grouped bars or one line
  each. A result with two text columns and a number now charts this way on its own: along the first, split by the second.
- A query's `| render ... with (...)` now sets up its chart: `xcolumn`, `ycolumns` and `series` pick the x axis, the values
  and the split, `title` names the chart, and `kind=stacked` or `kind=stacked100` stacks it. A **Stacking** picker on the
  Chart tab stacks column, bar and area charts, or stacks them to 100%.

### Changed

- The app's interface code now ships as two smaller files (app and libraries) instead of one large one. Nothing changes in
  how it works.
- Settings open as a wide side panel over the queries, which stay in view. In a narrow window they still fill it.
- Row details show dynamic values as a property grid: a key and a value on each row, with nested objects and arrays to
  open and close. JSON text in a string column shows the same way. **Raw** shows the JSON as text.
- The row details sheet takes the full height of the window, beside the editor and results, not only the results
  area.
- The title bar and the tab strip are one bar, so queries get more room. Settings and accounts moved into a menu on the
  account button.
- With many tabs open, the tabs scroll sideways without a scrollbar and the active one stays in view; the account button
  no longer wraps onto two lines.
- The account button shows just the tenant; its menu shows who is signed in.
- The Graph schema is regenerated from the latest beta metadata (msgraph-metadata@690154d).
- The status bar says "Built-in Graph schema" and its date instead of the schema's full source, which no longer squeezes
  the rest of the bar. Hover it for the source.
- The Graph schema is regenerated from the latest beta metadata: the Copilot cost management tables
  `copilot_costManagement_spendingPolicies` and `copilot_costManagement_userBalances` now list their read permissions.
- Sharing Graph compatibility findings now covers where Kustodian falls short too: Graph refusals it can't work around,
  `where` conditions it can't send to Graph, permissions Graph didn't accept although the schema lists them, and limits a
  query hit. Each event holds only the table's schema path and short codes, never your tenant, queries, values or Graph's
  error messages. If you said yes before, Kustodian asks again and shares nothing until you answer.

### Fixed

- Graph queries that run locally: a `project` of only constants (`project x = 'none'`) on no rows returns no rows instead
  of one, and a `where` on a condition that reads no column (`where false`) returns an empty result instead of failing with
  "Sequence contains no elements". `where false | count` now counts 0 instead of returning no row.
- A workbook list parameter without fixed choices now takes several values, one per line, in the parameter bar, the
  Parameters dialog's Default and a widget's own control. Before, its single-line box held only one value.
- Markdown widgets and solution READMEs render pipe tables (`| a | b |`) as tables instead of one line of text.
- Discarding a workbook edit (or undoing back to the start) reruns any widget that ran a draft query while editing, so it no
  longer shows, or runs tool buttons on, rows from a query the workbook doesn't have.
- A raw Graph request's response no longer undoes header or version changes made while it was being sent.
- The Saved, Snippets and Recent panels drop a read error once a later read works.
- Arrow Down on a widget's move grip moves it past the widget right below it; before, it was packed straight back.
- A link Ctrl/Cmd+clicked in the query editor opens in your browser through the same allowlist as workbook links, never inside
  the app window.
- Moving the cursor in the editor no longer re-renders the whole window, and charts are shaped once per result instead of on
  every re-render.
- Markdown widgets show headings, lists, quotes and code as such: `## Test` is a heading again, not plain text. Any widget
  can now hide its title bar outside edit mode (**Hide the title bar outside edit mode** in Edit widget); its ⋯ menu hides
  with it.
- A table widget's inspect button (the magnifier) opens the row in the row details sheet, as on the Rows tab, instead of
  ticking the row's checkbox.
- A table widget's row details sheet opens over the whole workbook, full height on the right as in a query tab, instead of
  inside the widget at its size. A widget in full screen keeps it inside.
- Chart widgets can split by a column and stack again: the widget editor's Visualization tab has **Split by** (formerly
  "Series") and **Stacking** (None, Stacked, Stacked 100%) for column, bar and area charts.
- Workbooks, after a look in the real app: a full-screen widget now fills the window. In the glass themes, completion and
  hover in the widget editor sit at the cursor. Chart widgets show only the chart, and are set up in the widget editor.
  Markdown fills in parameters added since the workbook opened. Widget headers fit in the narrowest widgets. Workbook
  folders show in the Saved panel. A hunting timespan that can't be used says so on the parameter.
- The Chart tab keeps its type, X axis, split, stacking and values when you switch to another result tab and back.
- On the glass themes, row details were see-through, so the rows behind showed through their text.
- A chart with many series, such as bars split by a column with dozens of values, no longer draws its legend over the
  X axis, Split by and Stacking pickers. The legend now takes up to three lines and scrolls.
- A query error naming a long table, such as `reports_authenticationMethods_userRegistrationDetails`, no longer runs over
  the error's report ID. The message wraps instead.
- In the glass themes, the chart's hover tooltip was see-through and hard to read. It now has the same frosted dark
  background as menus, and the band behind the hovered bar no longer glares light grey.
- On macOS, ⌘ Enter runs the block at the cursor, as the shortcut hints say. Before, only Ctrl Enter did, and the
  editor's other ⌘ shortcuts answered to Ctrl too.
- Query parameters such as `{companyName}` are no longer underlined as errors ("Client parameters are not supported or
  enabled"). Real errors elsewhere in the query are still marked.
- On Windows, a query still running when Kustodian closed could end with an unexpected COM error instead of stopping
  cleanly.
- Graph queries that read `roleManagement_directory_roleDefinitions` (for example to name the roles in PIM activations) no
  longer fail with "This resource requires a minimum page size of 20". Kustodian now reads the table 500 rows at a time,
  the only page size Graph accepts for it.

## [1.0.0] - 2026-11-03

### Changed

- The Windows MSIs, and the `Kustodian.exe` they install, are code-signed: Windows names the publisher, "Open Source
  Developer Frode Hus", instead of warning about an unknown one. The portable zips stay unsigned.

## [0.94.0] - 2026-11-02

### Added

- Settings shows the version you are running and has a "Check for update" button. At startup Kustodian asks GitHub for the
  latest release and, when it is newer, offers to open its release page, remind you next start, or skip that version.

## [0.93.0] - 2026-11-02

### Added

- You can choose to share Graph compatibility findings: which Graph tables refuse `$top`, `$count`, `$orderby`, `$select`, a
  filter, or columns in a list. They help build those limits into Kustodian so queries skip the probing. It is off until you
  opt in. Kustodian asks once at first start, and you can change your answer under **Settings → Graph compatibility
  findings**. Only the table path, the finding and the app version are sent. Your tenant, account, queries and data never are.
  The [telemetry page](https://frodehus.github.io/kustodian/telemetry.html) shows exactly what is sent.

### Fixed

- A Graph table that caps its page size, such as `riskyUsers` (at most 500), is now read in pages of that size instead of
  Graph's default of 20, which got throttled on large tenants. When Graph refuses `$top=999`, Kustodian tries 500, then
  100, before leaving `$top` out, and remembers the size Graph takes so later runs send it straight away.

## [0.92.0] - 2026-11-02

### Fixed

- Result columns keep their width while you scroll. Each result sets a fixed width per column from its header and longest
  value, instead of resizing to the rows in view.

## [0.91.0] - 2026-11-01

### Fixed

- Shortcut hints are easier to read: the ⌘ no longer shrinks to a dot on high-resolution screens, and on macOS Shift is shown as
  ⇧, so Run all reads ⇧ Enter next to Run's ⌘ Enter.

## [0.9.10] - 2026-10-29

### Fixed

- A query that makes the engine throw, such as `print x = ago(36500000d)`, now fails on its tab with the engine's message instead
  of ending the worker as a crash.
- The sign-in screen starts on the client the account in use signed in with, so it shows whether that is Azure CLI, Graph
  Command Line Tools or your own app. A default client ID in Settings still comes first.
- After **Grant permission…**, the query runs with the new permission without signing in again. Entra ID can take a few seconds
  to put a new grant in tokens; Kustodian asks again until it does.
- Graph collections that refuse `$select`, such as `reports_appCredentialSignInActivities`, are read with the columns Graph sends
  by default instead of failing.

## [0.9.9] - 2026-10-28

### Added

- Graph collections one single-valued step below a singleton are now tables, such as
  `reports_authenticationMethods_userRegistrationDetails` (MFA and passkey/FIDO2 registration per user),
  `roleManagement_directory_roleAssignments` and `identity_conditionalAccess_policies`: 319 more tables. Paths through a `me`
  segment (`education/me/...`) stay out, like `me` itself. The schema is regenerated from the latest beta metadata.
- Sign in with Microsoft Graph Command Line Tools, the public client Graph PowerShell uses, as a third choice next to the Azure
  CLI and your own app. It reaches what your tenant has granted Graph PowerShell. Azure Resource Graph queries use an Azure CLI
  sign-in for the same user, asked for once with **Grant Azure access**.
- **Grant permission…** on a "No permission" result for Graph tables and advanced hunting, and on relationship columns refused
  in full, when you are signed in with Graph Command Line Tools or your own app. It asks Microsoft for the one narrowest read
  permission listed. If you already hold a listed permission, the result says your account may be missing a role instead.

### Changed

- The Chart tab charts by a true/false, GUID or duration column as well as by text or a date, so
  `summarize count() by accountEnabled` draws a column chart. Text still comes first along the axis.

## [0.9.8] - 2026-10-23

### Added

- An inspect button on every row of the results opens the row in the row details sheet; another row's button switches the
  sheet to that row, and the open row's button closes it. Dynamic values show as a tree to open and close, with Expand all.

### Fixed

- A Graph query with a dynamic value on the left of `in`, `!in`, `in~`, `!in~` or `has_any` says to convert it with
  `tostring()` instead of showing an internal cast error.
- Graph `directoryRoles` and each role's `members` no longer fail: Graph refuses any page size there, and the read now retries
  without `$top`.

## [0.9.7] - 2026-10-22

### Added

- The macOS app and dmgs are signed with a Developer ID and notarized, so they open without a Gatekeeper prompt and macOS no
  longer asks about the keychain item after an update.

## [0.9.6] - 2026-10-22

### Added

- A Save button in the query toolbar. Once the tab is saved to the library or a file, its ▾ menu has Save as.

## [0.9.5] - 2026-10-22

### Added

- Relationship columns on Graph tables: a user's groups (`memberOf`), manager, direct reports, owned objects and devices; a
  group's members and owners; owners of applications and service principals; a device's registered owners and users. Read
  one object at a time when a query names them, for at most 100 objects per relationship and 1,000 entries per object.
- Notices for relationship reads that were cut off, refused, returned without details, capped, or filtered locally, and the
  relationship requests and permissions in Explain.
- Directory relationship snippets: a user's groups, a group's members and an application's owners.

## [0.9.0] - 2026-10-22

### Added

- KQL over Microsoft Graph (beta), Defender advanced hunting and Azure Resource Graph in one desktop app.
- Tabs, parameters, snippets, saved queries and history; grid, chart, JSON and diagnostics results; Explain and raw requests.
- Sign-in with the Azure CLI client or your own app registration, and Create Entra ID application.
- License-aware Graph tables and columns, and the tenant's licenses (with Refresh) in the account view.
- The Kustodian logo in the title bar, as the window and executable icon, and on the product website.
- Release builds for Windows (MSI and portable zip, x64 and Arm), macOS (dmg and zip, Apple Silicon and Intel) and Linux
  (tarball and AppImage), with SHA-256 checksums and an install guide.
- Create Entra ID application from Settings → Sign-in.
- `--version`, and a clear message on Linux when WebKitGTK, libsecret or libnotify is missing.
