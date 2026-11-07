# Workbooks

A workbook is a page of widgets, each backed by a query, that share a few parameters. Use one for a review you repeat
(risky users this week, VMs that should be off), where one query tab answers only one question. Open **+ ▸ New workbook** in
the tab strip. It opens as a workbook tab next to your query tabs. Save it with Ctrl/⌘+S. For ready-made workbooks, see [Community Solutions](solutions.md).

## Widgets

Widgets sit on a 12-column grid, at most 100 in a workbook. Each has a header with its title, the source, the parameters it shows, which workbook
parameters it uses, and how long its last run took. The ⋯ menu has Refresh, Open in query tab, Export (CSV, JSON or
Markdown) and Full screen. **Hide the title bar outside edit mode** in Edit widget hides the header, ⋯ menu included, until
you edit the workbook.

- **Markdown**: headings, text and links. `{name}` shows the current value of a parameter. Raw HTML and images are dropped.
- **Chart**: the Chart tab's chart types, with X, Y and series chosen in the widget editor.
- **Table**: the result grid, with sorting and its row filter.
- **Stat**: one number from the first row, with an optional value to compare it with.

Markdown links open in your own browser, but only for the sites Kustodian already opens: Microsoft sign-in and Entra
pages (`login.microsoftonline.com`, `entra.microsoft.com`), Kustodian's own site (`frodehus.github.io`) and its GitHub release
pages. Only `https` links are links; any other address shows as plain text, and a link to another site says in the widget
that Kustodian can't open it.

Widgets run in parallel, at most three at a time per source; the rest say "waiting". One that fails shows its own error and
the others carry on. Widget runs are not added to Recent, and results are never saved with the workbook.

## Queries

A Chart, Table or Stat widget gets its query one of two ways, picked in the widget editor:

- **Written in the widget**: a source (Graph, Defender hunting or Azure Resource Graph) and KQL, edited with the usual
  completion for that source. Raw Graph requests can't be a widget's query.
- **A saved query**: the widget is *linked* to a query in your library and always runs the library's current version, so
  editing the saved query changes every widget that uses it. **Open in tab** opens it; **Copy into widget** turns the widget
  into the first kind. The workbook keeps a copy of a linked query's last text, so a deleted saved query leaves the widget
  with an error and that copy to copy in.

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
choices, default and required. The dialog shows which widgets use each parameter and flags unused ones. A list with choices
can allow several values, and can offer **All**, which sends every choice. **Remember my last value** keeps your pick on this
computer, outside the workbook. A timespan can be marked as the Defender hunting timespan: hunting widgets then use it
(converted to the form the API takes, at most 30 days) unless they set it themselves.

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
- **Saved queries**: they are added to your library with new ids, in a folder named after the workbook, or copied into the
  widgets. **Open without saving** always copies them and saves nothing.
- **Tool buttons**: each is matched by name to a tool in your own `tools.json`. Import never changes `tools.json`. A button
  with no match is left off, unless you choose one of your tools for it.
- **Parameter values**: the defaults are listed. They aren't checked against your tenant yet.
- **The file**: shown as Kustodian read it.

If you already have a workbook with the same id, the review asks: **Keep both** (the default, with a new id) or **Replace**.
Replace is off while that workbook is open in a tab.
