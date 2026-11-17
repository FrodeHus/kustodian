# Workbook workspace parameter

Status: approved 2026-11-16. Closes the open question in `2026-11-10-workspaces-design.md` ("a workbook parameter that picks
the workspace").

## Why

Each hunting and Log Analytics widget stores its own workspace. A solution workbook installs with none (workspaces are
stripped), so a user must pick one on every Log Analytics widget. The log-cost workbook would have about eight. One picker
for the whole workbook removes that chore and lets a user point a workbook at another workspace in one step.

## Goals

- A workbook parameter of type `workspace`, at most one per workbook. Its bar control is the existing workspace picker.
- Every Log Analytics and hunting widget sends that workspace, unless the widget sets the parameter itself (shown or fixed),
  exactly as the huntingTimespan parameter overrides a widget's own timespan.
- Choice queries (parameter choices from a query) follow it too, as widgets do.

## Non-goals

- Several workspaces per query.
- A workspace parameter on query tabs.
- Resource Graph scope from a parameter.

## Anti-goals

- Never send a query to a workspace the user didn't pick: no default to the first workspace. With no value, Log Analytics
  widgets say "Pick a workspace." and send nothing; hunting widgets use the primary workspace, as without a workspace today.
- A workspace in a file is never queried unconfirmed: the import review lists it; a solution install removes it.

## Approaches

1. **Parameter type `workspace`, applied like the hunting timespan** (picked): one rule users already know, reuses the
   picker and the host's own workspace check.
2. A list parameter with choices from a Resource Graph query of workspaces: rejected, the value would need the customer id,
   name and resource id packed into text, and the picker already lists the account's workspaces.

## Design

### Value and file format

`type: "workspace"`; `value` is the workspace's customer id (GUID, "D" format) or `''`. No other new field; no file version
change. `{Name}` in query text substitutes the customer id as text (sent to the host as type `text`).

### Running

- The resolved workspace for a Log Analytics or hunting widget (and a choice query) is, in order: the widget's own entry for
  the parameter when shown or fixed; else the parameter's current value; else none. When the workbook has a workspace
  parameter, the widget's own `options.workspaces` is not used.
- The run sends `workspaces: [{ customerId: value, name: <account list name or ''>, resourceId: '' }]`. The host checks the
  id against the account's own list (`WorkspaceCheck`) and uses its own entry; a workspace the account can't see fails with
  the host's "… isn't available to this account. Pick a workspace."
- No value: Log Analytics → "Pick a workspace." (nothing sent, as today); hunting → primary workspace.
- The timespan cap follows the resolved workspace (730 days with one, 30 without, Log Analytics always 730).
- A change to the parameter reruns the widgets and choice queries that use it (the `widgetsUsing`/`choicesUsing` rules).

### Parameter bar

The control is `WorkspacePicker` with the account's workspaces; picking sets the value, and a "None" entry clears it. A value
not in the account's list shows its short id and "not available to this account". Remember my last value works as for other
types.

### Parameters dialog

Type gains `workspace` (workbook parameters only). A second workspace parameter is an error: "A workbook can have only one
workspace parameter." and Save is off. A workspace parameter has no Choices, Several values or Offer All; its Default is the
picker. The widget editor, for a Log Analytics or hunting widget in a workbook with a workspace parameter, shows "The workspace
comes from the <label> parameter." instead of its own picker.

### Import, sharing and solutions

- The import review lists a workspace parameter's default with the widgets' workspaces ("parameter <label>"); `applyImport`
  names it from the account list like the others.
- Solution install sets a workspace parameter's `value` to `''` (before the origin hash).
- Repo solution CI fails a workbook whose workspace parameter has a non-empty value.

### Docs

`docs/workbooks.md` Parameters; `Solutions/README.md` CI checks; CHANGELOG under Unreleased.

## Left to the builder

- Where the account workspace list is read for names (`useAccountWorkspaces`), and the picker's None entry.
- Test split across `resolve.test.ts`, `workbook-store.test.ts`, `workbook-view.test.tsx`, `parameters-dialog.test.tsx`,
  `widget-editor.test.tsx`, `import.test.ts` and the C# solution tests.
