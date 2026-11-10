# Workbooks

A workbook is a page of widgets, each backed by a query, that share a few parameters. Use one for a review you repeat
(risky users this week, VMs that should be off), where one query tab answers only one question. Open **+ ▸ New workbook** in
the tab strip. It opens as a workbook tab next to your query tabs. Save it with Ctrl/⌘+S. For ready-made workbooks, see [Community Solutions](solutions.md).

## Widgets

Widgets sit on a 12-column grid, at most 100 in a workbook. Each has a header with its title, the source, the parameters it shows, which workbook
parameters it uses, and how long its last run took. The ⋯ menu has Refresh, Open in query tab, Export (CSV, JSON or
Markdown) and Full screen. **Hide the title bar outside edit mode** in Edit widget hides the header, ⋯ menu included, until
you edit the workbook.

- **Markdown**: headings, text, links and tables. `{name}` shows the current value of a parameter. Raw HTML and images are dropped.
- **Chart**: the Chart tab's chart types, with X, Y and series chosen in the widget editor.
- **Table**: the result grid, with sorting and its row filter, and the query's highlight rules, which colour rows or cells.
  The widget editor has a Highlight tab to edit them. A widget linked to a saved query follows that query's rules, and its
  Highlight tab is read-only ("Edit the saved query to change these."). Copying a saved query into a widget or linking one
  replaces the widget's own rules. Exporting and importing a workbook carries rules, and solutions can include them.
- **Stat**: one number from the first row, with an optional value to compare it with and an optional unit shown after it
  (`%`, `ms`, `days`; at most 12 characters).

A hunting widget can query a Log Analytics workspace, picked in the widget editor. The default is **Primary
workspace**: no workspace is sent, and Graph uses your primary Sentinel workspace if one is connected. If Defender can't reach
the workspace, it answers from the primary one, and the widget says so. Querying a workspace needs Microsoft Sentinel Reader
on it; see [Entra ID permissions](EntraPermissions.md#hunting-in-a-workspace).

A Log Analytics widget (source **Log Analytics**) always needs a workspace, picked in the widget editor; there is no Primary
workspace. Until one is picked the widget says "Pick a workspace before running." with a button for it in edit mode, and
nothing is sent. Its timespan starts at 1 day and can go up to 730 days. Querying a workspace needs Reader or Log Analytics
Reader on it. The prompt to grant Log Analytics access can appear first when the tables load (schema panel) or on the first
run; see [Entra ID permissions](EntraPermissions.md#log-analytics).

Markdown links open in your own browser, but only for the sites Kustodian already opens: Microsoft sign-in and Entra
pages (`login.microsoftonline.com`, `entra.microsoft.com`), Kustodian's own site (`frodehus.github.io`) and its GitHub release
pages. Only `https` links are links; any other address shows as plain text, and a link to another site says in the widget
that Kustodian can't open it.

Widgets run in parallel, at most three at a time per source; the rest say "waiting". One that fails shows its own error and
the others carry on. Widget runs are not added to Recent, and results are never saved with the workbook.

## Tabs

A **Tabs** widget groups other widgets, so a workbook can hold several views of one subject without one long page. Add one
in edit mode with **Add widget**. It starts with one tab, "Tab 1", and its title bar is hidden. Tabs can't hold another Tabs
widget, and the 100-widget limit counts the widgets inside tabs.

Only the tab you are looking at runs its queries. The others wait until you show them, and a tab you have already run keeps
its results, so going back shows the earlier result without a rerun. Marks on a tab name say what is waiting:

- **not run**: the tab hasn't run yet.
- **out of date**: a workbook parameter changed, or you used Refresh all, while the tab was hidden. It reruns when you show it.

Which tab is shown is not part of the workbook. It isn't saved, doesn't mark the workbook as changed, and can't be undone.

Arrow keys move between tabs, and Enter or Space shows the one that has focus. The Tabs widget's own ⋯ **Refresh** reruns
only the shown tab.

In edit mode:

- **+** adds a tab. Double-click a tab, or press Enter on the shown tab, to rename it. A name is required and at most 40
  characters; two tabs may share a name.
- The shown tab's ⋯ menu has **Rename**, **Move left**, **Move right** and **Delete**. Dragging a tab in the bar reorders it.
- Deleting a tab that has widgets asks first: move them to the neighbouring tab, delete them too, or cancel. Removing the
  last tab removes the Tabs widget and asks the same way.
- Removing a Tabs widget that holds widgets (**Remove**) asks first: **Move widgets to the top level**, **Delete them too**,
  or cancel.
- Move a widget to a tab by dragging its grip onto the tab bar: hold over a tab for about half a second and it is shown, so
  you can drop the widget into it, or drop it on the tab name to put it at the bottom of that tab. Or open the widget's ⋯ menu and choose **Move to…**, then **Top level** or a tab. A
  widget can be dragged out of a tab onto the grid the same way.
- An empty tab says "No widgets on this tab", and in edit mode "Drag a widget here or use Move to…".

A workbook file with tabs is saved as version 2 and needs this version of Kustodian or later; older versions say "This
workbook needs a newer Kustodian." A file without tabs stays version 1. A solution that ships a workbook with tabs should
set `minAppVersion` to the first release that has tabs.

## Queries

A Chart, Table or Stat widget gets its query one of two ways, picked in the widget editor:

- **Written in the widget**: a source (Graph, Defender hunting, Azure Resource Graph or Log Analytics) and KQL,
  edited with the usual completion for that source. Raw Graph requests can't be a widget's query.
- **A saved query**: the widget is *linked* to a query in your library and always runs the library's current version, so
  editing the saved query changes every widget that uses it. **Open in tab** opens it; **Copy into widget** turns the widget
  into the first kind. The workbook keeps a copy of a linked query's last text, so a deleted saved query leaves the widget
  with an error and that copy to copy in.

### Adding a query from a query tab

Once a Microsoft Graph, advanced hunting, Resource Graph or Log Analytics tab has run successfully, **Add to workbook…**
(at the end of the Rows tab's Export menu, and in the command palette) opens a dialog:

- **Workbook**: pick one (search with "Find a workbook"; the list is grouped by folder), or **New workbook** with a Name
  and Folder. A workbook with 100 widgets is disabled and marked "(full)". The first workbook in the list that has room is
  preselected, or New workbook when none has.
- **Widget**: Table, Chart or Stat. Chart is preselected when the Chart tab is showing, Stat for a one-row single-number
  result, otherwise Table.
- **Title**: defaults to the tab's title.

The widget takes the query text that last ran: with several queries in the editor, only the block (or selection) that ran.
A saved query with no unsaved changes, whose run sent the whole text, is linked to the widget. Otherwise the text that ran
is copied in, with the parameters it uses, and the dialog says "Save the query first to link it." The source, options
(timespan, scope, workspace) and highlight rules come along, and a Chart widget takes the Chart tab's settings (type, x axis, values, split, stacking).

The query's `{name}` parameters become workbook parameters when the workbook has none of that name; existing ones are used
as they are. The widget goes below the others: a Table or Chart full width and 16 grid rows high, a Stat at its smallest size.

A closed workbook is saved and opened. An open workbook with no unsaved edits gets the widget and is saved. An open
workbook with unsaved edits gets the widget in its draft, nothing is saved, and a notice says "Added to your unsaved
changes in <name>." A new workbook is created, saved and opened. Its tab comes to the front and scrolls to the new widget.

## Selection and tool buttons

A table widget can have a checkbox column and tool buttons that run one of your external tools (see
[external-tools.md](external-tools.md)) on its rows. In the widget editor, **Rows can be selected** turns the checkboxes on
or off, and with **Several rows at once** off, only one row at a time can be selected. The widget header shows "2 of 14 selected", and select-all ticks
the rows the filter shows.

Tool buttons are set up on the editor's **Tool buttons** tab. Each button has:

- a label, and a placement: the widget header or the ⋯ menu;
- a **tool**, chosen from your `tools.json` by name. The editor shows its command line for reading;
- a **column mapping** for each `{parameter}` in the tool's arguments. It starts with the column of the same name, ignoring
  case. Only result columns can fill an argument;
- **runs on**: the selected rows, or all rows the filter shows when none are selected (the default), or only the selected
  rows, which leaves the button off while none are selected;
- **after it runs**: refresh this widget (the default), refresh the whole workbook, or nothing.

The label carries the count: `Stop VM · 2` with two rows selected, `Stop VM · all 14` when it will run on every row the
filter shows. Clicking it opens the same dialog as the Rows tab's **Run tool**, titled for example "Stop VM on 2 selected
rows": the mapping, the command line for the first row, and the row count, then Run. That confirmation can't be turned off.
`each` and `batch` tools both work; a `batch` tool gets the rows on stdin. If the tool isn't in your `tools.json` the button
says "There's no tool named Stop VM in your tools.json." and offers **Edit tools…**.

A workbook stores only the tool's name and the column mapping, never a command. A workbook from someone else works only
with a tool of the same name in your own `tools.json`, and what that tool does is up to you. Every run asks first.

## History

Graph, Resource Graph and some Defender tables (`DeviceTvmSoftwareVulnerabilities`, `DeviceTvmSoftwareInventory`,
`DeviceTvmSecureConfigurationAssessment`) only hold the current state. A widget can keep its own history to show change over
time. Turn on **Keep history for this widget** on the editor's **History** tab. Where the source already keeps history (most
hunting tables, 30 days), put the comparison in the query instead.

There are two modes. A Stat widget can use either, a Chart only Values over time, and a Table only Row tracking. New Stat
and Chart widgets start with Values over time.

- **Values over time** stores each run's whole result, for small summarised results of at most 500 rows. A Stat shows the
  change since a chosen point, such as "vs yesterday". A Chart plots the snapshots over time, split by a column as usual. For
  example, users with a device-bound passkey per day:
  `userRegistrationDetails | mv-expand m = methodsRegistered | where m startswith "passKeyDeviceBound" | summarize count() by tostring(m)`.
- **Row tracking** follows rows by **key columns**, one or more, for example `DeviceId` and `CveId`. After each run, a new key
  gets *First seen* = now, a key that is missing gets *No longer reported* = now, and a key that comes back starts a new
  *First seen*. Storage grows with distinct keys, not with days. A table can show **Open now**, **New since**,
  **No longer reported since** or **Both**, since the previous snapshot, yesterday, 7 or 30 days ago, or a date. A Stat can
  count either. Rows keep only the key columns and the ones you pick under **Also keep, to show rows that are gone**. Presence
  works for state too: "users with a device-bound passkey", keyed on `id`, shows who added one and who no longer has one.

The label is **No longer reported**, not "Patched" or "Removed": a row also disappears when a device is offboarded or goes
inactive, or a user is deleted.

### When a snapshot is taken

There is no scheduler. A widget with history stores a snapshot when it runs and its last one is older than **Save at most**:
once a day (the default), every run, or once a week. A day is your local calendar day and a week is the ISO week, starting
Monday. In Values mode the latest run in an interval replaces earlier ones. Days nobody opened the workbook show as gaps.

A run is recorded only when the workbook is saved and unchanged, and the run finished and was complete. These are never
recorded, and the widget says why it skipped:

- a run that failed or was cancelled, or was cut off at the row limit, since it would mark rows as gone or store a wrong count;
- a Values result over 500 rows;
- a Row tracking result whose key columns aren't unique;
- a run of a workbook with unsaved changes, or one that was never saved.

If the history file can't be written, the widget says "Not recorded:" and the reason.

Selection and tool buttons apply only to the **Open now** filter.

### What belongs to a history

A history belongs to the workbook, the widget and the resolved query, source, options and parameter values. Each combination of
parameter values has its own history, and so does each Defender hunting timespan: changing the workbook's timespan from 7 to 30
days switches to the 30-day history and keeps the 7-day one. **Forget gone rows after** (Row tracking) and **Keep snapshots
for** (Values) are 30, 90 or 365 days.

Changing the widget's query, source, options, mode or key columns, or turning history off, asks "Clear this widget's history?"
when history exists. Cancel keeps the editor open. Editing a linked saved query in the library doesn't ask: the widget's next
run starts a new history and drops the old one, so an old snapshot is never compared with the new query.

**Clear history…** in the widget's ⋯ menu deletes it by choice, and the widget reruns to take a first snapshot. Deleting a
workbook deletes its history.

### Where it is stored

History is in `history.db` in Kustodian's data folder, on this computer only. It is never in an exported workbook, an error
report or a log. The widget's history *setting* exports with the rest of the widget, but its data does not.

If `history.db` is damaged (corrupt, not a database, or failing its integrity check), Kustodian renames it to `history.db.damaged-<time>` and starts a new one. Widgets then say
"History was reset: its file was damaged." The app and your workbooks load as usual. Other errors, such as a full disk or a
file that is in use, leave the file as it is: the widget says it couldn't read or record history.

## Parameters

Queries use the same `{name}` placeholders as query tabs, and values are quoted for KQL the same way. In the widget editor
each placeholder in a widget's query takes its value from one of three places:

- **Workbook**: the workbook parameter of the same name. This is the default when there is one.
- **Widget, shown**: a control in the widget's header. Changing it reruns only that widget.
- **Fixed**: a set value with no control.

For each widget and parameter the value is, in order: the widget's own value if it is shown or fixed, else the workbook's
value, else the parameter's default. A required parameter with no value stops that widget from running and says so on it;
the other widgets still run.

**Parameters** (in edit mode) opens the workbook's parameters: name, label, type (text, number, timespan, datetime or list),
choices, default and required. The dialog shows which widgets use each parameter and flags unused ones. A list without
choices takes several values, one per line. A list with choices can allow several values, and can offer **All**, which
sends every choice. **Remember my last value** keeps your pick on this computer, outside the workbook. A timespan can be
marked as the Defender hunting timespan: hunting and Log Analytics widgets then use it (converted to the form the API takes)
unless they set it themselves. Hunting without a workspace takes at most 30 days; hunting with a workspace, and Log
Analytics, at most 730. The timespan keeps each widget's workspace, and its cap follows each widget.

Change a workbook parameter in the bar under the toolbar and only the widgets that use it rerun. A text parameter reruns when
you stop typing or press Enter. These changes aren't saved: the file holds the defaults you set in the dialog.

## Editing

**Edit** switches to edit mode, where widgets show a grip and their size and Add widget, Parameters, Undo, Redo, Discard and
Done appear. Dragging, resizing, adding, duplicating and removing widgets don't rerun anything; **Done** reruns once if the
workbook changed, and **Discard** drops every change since Edit.

By keyboard, with a widget's grip focused:

- Arrow keys move the widget, and Shift+arrows resize it.
- Delete or Backspace removes it.
- Ctrl/⌘+Z undoes and Ctrl/⌘+Shift+Z redoes, except in a text field, which keeps its own undo.
- In the parameters dialog, Alt+↑/↓ reorders the parameters.

Changes are announced to screen readers. Widgets snap to the grid and reflow upward when there is room. In a narrow window
they stack full width, in top-to-bottom, left-to-right order.

## Saving and restoring

The first Save asks for a name and a folder. Later saves write straight away. Workbooks are listed under **Workbooks** in the
side panel next to saved queries, in their folders, where a click opens one and its menu deletes it. A dot on the tab means unsaved changes, and
closing such a tab asks first, as a query tab does.

Unsaved workbooks, edits included, come back after a restart like unsaved query tabs do. If the saved copy was deleted in the
meantime, the tab stays open as unsaved.

## Sharing

**Export…** in a workbook's ⋯ menu writes one `.kustodian-workbook.json` file: the workbook's layout, queries, parameters
with their defaults, and tool-button settings. Linked saved queries carry their text. It never holds results, tokens or
remembered values.

**Import…** in the Workbooks group of the Saved panel, or **Import workbook…** in the command palette, opens a file and shows
a review first. Nothing runs, and nothing is saved, until you choose. The review shows:

- **What's in it**: the widgets, parameters and buttons.
- **Workspaces**: the workspaces the file queries, with how many widgets use each. Names come from your own workspace list,
  matched by ID. A name only the file claims shows as "not available to this account", or "not checked" when your list can't be
  read. Saving the import, or opening it without saving, is the confirmation.
- **Saved queries**: they are added to your library with new ids, in a folder named after the workbook, or copied into the
  widgets. **Open without saving** always copies them and saves nothing.
- **Tool buttons**: each is matched by name to a tool in your own `tools.json`. Import never changes `tools.json`. A button
  with no match is left off, unless you choose one of your tools for it.
- **Parameter values**: the defaults are listed. They aren't checked against your tenant yet.
- **The file**: shown as Kustodian read it.

If you already have a workbook with the same id, the review asks: **Keep both** (the default, with a new id) or **Replace**.
Replace is off while that workbook is open in a tab.
