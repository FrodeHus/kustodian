# Workbooks, plan 3: export and import — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A workbook can be exported to one `.kustodian-workbook.json` file and imported from one. Import shows a review
first: what is in the file, its saved queries (added to my library with new ids, or copied into the widgets), its tool
buttons matched by name to my own `tools.json`, its parameter defaults, and an id collision. Nothing is saved or run until
the user picks **Open without saving** or **Save to my workbooks**.

**Architecture:**

- **Files go through the existing `file.open` and `file.saveAs`.** They already show the native dialogs, cap the size,
  require UTF-8 and write atomically. Export writes the workbook JSON the library stores. No new dialog code.
- **One new host method, `workbook.check`,** runs `WorkbookService`'s existing checks (kind, version, GUID id, name,
  folder, widget count) and the 2 MB cap on an imported document, so an untrusted file is refused by the host before the
  review opens. The web side parses it with `parseWorkbook` first, which already rebuilds tool buttons from their six
  known fields (plan 2), so a `command` in the file never reaches the review.
- **The decisions are pure functions** in `web/src/workbooks/import.ts` (summary, folder name, tool matching, the
  rewritten document). `sharing.ts` does the bridge calls. `import-review.tsx` is the dialog (screen 7), mounted once in
  `app.tsx` and opened from the Saved panel's Workbooks group and the command palette.
- **The review opens before any tab exists.** A workbook tab's `load` is what runs widgets, so nothing runs until the
  review closes with Open or Save and `openWorkbook` is called.
- **Not in this plan:** checking parameter values against the tenant (v2), opening a file from the OS, a sender or app
  version in the file (the mockup's header shows one; the file format has no such field, so the header shows the file
  name only).

**Tech Stack:** .NET 10 (`System.Text.Json.Nodes`, xUnit), React 19 + TypeScript, zustand, Vitest + Testing Library,
oxlint. No new dependencies.

**Spec:** `docs/design/specs/2026-11-06-workbooks-design.md` §9.2–§9.3, §4's first two anti-goals and §13's "import
matching of saved queries and tools" and "import never touches `tools.json`". Mockup: screen 7 (`Share`) on the canvas
linked from the spec. Plans 1 and 2 (`docs/design/plans/2026-11-06-workbooks-plan-1-core.md`,
`docs/design/plans/2026-11-07-workbooks-plan-2-tool-buttons.md`) built what this plan extends.

## Global Constraints

- No warning suppressions: `dotnet build -warnaserror`, `oxlint` and `tsc` pass clean (`CLAUDE.md`). The two known open
  warnings stay as they are.
- Work only in a worktree; run each git command on its own. Commit after each task.
- No new npm or NuGet dependency.
- **A shared file never carries a command and can never bring one in** (spec §4, **Owner**). Import never calls
  `tools.save` or `tools.edit`, never shows or keeps a field of the file's buttons beyond the six `parseToolButton` keeps,
  and a button whose tool I don't have is left off unless I choose one of mine.
- **The file holds the author's defaults, never results or runtime values** (**Owner**). Export writes the tab's
  document with linked copies refreshed and without `modifiedAt`. Remembered values (`workbook-values/`), selections and
  results are not in the document and stay out.
- **The imported file is untrusted.** Parse with `parseWorkbook`, then `workbook.check`, before the review. A refusal shows
  its message and nothing else happens.
- Added saved queries get **new ids** (`library.save` with `id: null`) and go in the folder `importFolder(doc.name)`:
  folders are one level, 1–80 characters, no `/`.
- **Open without saving** writes nothing: no `library.save`, no `workbook.save`. Its linked widgets are copied into the
  widgets, because the sender's saved ids mean nothing in my library (or, worse, could match one of mine).
- Copy, from the spec and screen 7: dialog "Open a shared workbook"; buttons "Cancel", "Open without saving", "Save to my
  workbooks"; section headings "What's in it", "Saved queries", "Tool buttons", "Parameter values", "The file"; "Queries,
  layout, parameters and button settings only. A workbook file never holds results or tokens."; "A shared workbook never
  carries commands. Each button runs one of the tools in your own tools.json, matched by name."; `matches your “Stop VM”`;
  "Choose one of my tools…", "Leave this button off". Menu item "Export…"; command "Import workbook…"; Saved panel button
  "Import…".
- Match the surrounding code: `call()` from `web/src/bridge.ts`, `errorText`/`reportIdOf` for errors, `useRevisions` to
  refresh the library, `MenuButton` items with `role="menuitem" tabIndex={-1}`, the `Rejected` wrapper in
  `WorkbookHandler`.

## Review Focus

1. **A crafted or broken file** (not JSON, another `kind`, `version: 2`, an id that isn't a GUID, 101 widgets, over
   2 MB, a 300-character name, a folder with `/`): the import stops with the message, no review opens, and nothing is
   saved. Tested in Tasks 1 and 4.
2. **A file's button names a tool I don't have, or names mine but carries `command`/`args`:** nothing is written to
   `tools.json` (no `tools.save`/`tools.edit` call), the review never shows the file's command, an unmatched button is
   left off by default, and the saved document's buttons hold only the six known fields. Tested in Tasks 3 and 4.
3. **A widget's `saved.id` is the id of a query already in my library:** that query is never run, renamed or overwritten.
   Save adds a new one with a new id and rewrites the widget; Open without saving copies the text into the widget. Tested
   in Tasks 3 and 4.
4. **The same file imported twice, or while the first import is open in a tab:** the review offers Keep both (the
   default, a new workbook id) or Replace, and Replace is off while a tab holds that id, because `openWorkbook` would only
   switch to that tab. Tested in Task 4.
5. **Two widgets link the same saved query; a saved name is empty or over 200 characters; the workbook name has `/` or
   is over 80 characters:** one library entry, both widgets rewritten to it; the name is shortened or falls back to the
   widget's title; the folder is shortened with `/` replaced. Tested in Task 3.

---

## File structure

| File | Responsibility |
| --- | --- |
| `src/Kustodian/Workbooks/WorkbookService.cs` | `Check(JsonObject)`: the existing `Problem` checks and the size cap, public. |
| `src/Kustodian/Bridge/Handlers/WorkbookHandler.cs` | `workbook.check`. |
| `web/src/workbooks/workbook-store.ts` | `withLinkedCopies`, taken out of `saveWorkbook`. |
| `web/src/workbooks/import.ts` | pure: `readWorkbookFile`, `importSummary`, `importFolder`, `linkedQueries`, `matchTools`, `applyImport`. |
| `web/src/workbooks/sharing.ts` | bridge side: `exportWorkbook`, `importWorkbook`, `openImported`, `saveImported`, `useImportReview`. |
| `web/src/workbooks/import-review.tsx` | the review dialog (screen 7). |
| `web/src/workbooks/workbook-view.tsx` | "Export…" in the workbook ⋯ menu. |
| `web/src/side/saved-panel.tsx`, `web/src/app.tsx` | "Import…" in the Workbooks group, the palette command, the mounted review. |
| `web/src/bridge.mock.ts`, `web/src/wire.ts` | `workbook.check` in the mock; the wire comment. |
| `docs/workbooks.md`, `CHANGELOG.md` | docs. |

---

### Task 1: `workbook.check` on the host

**Files:**
- Modify: `src/Kustodian/Workbooks/WorkbookService.cs`, `src/Kustodian/Bridge/Handlers/WorkbookHandler.cs`,
  `web/src/bridge.mock.ts`
- Test: `tests/Kustodian.Tests/Workbooks/WorkbookServiceTests.cs`, `tests/Kustodian.Tests/Bridge/WorkbookHandlerTests.cs`

**Interfaces:**
- Produces:

```csharp
// WorkbookService: what is wrong with an imported workbook, or null. Reads and writes nothing.
public static string? Check(JsonObject workbook); // Problem(workbook) ?? (UTF-8 size of ToJsonString() > MaxBytes ? "The workbook can be at most 2 MB." : null)
```

  Bridge: `workbook.check` takes `{ workbook }` and answers `null`, or a `bad_request` with `Check`'s message. A request
  without an object `workbook` is the existing "The request has no workbook." The mock answers `null` unless the
  workbook's `kind` isn't `kustodian.workbook`, then rejects with "This isn't a Kustodian workbook."

- [ ] **Step 1: Write the failing tests:**
  - `Check_accepts_a_valid_workbook_and_writes_nothing`: `Check` of a valid doc is null, and `workbooks/` doesn't exist
    afterwards.
  - `Check_refuses_what_save_refuses` (theory): `kind` `"x"`, `version` 2, id `"abc"`, empty name, a 201-character name,
    folder `"a/b"`, 101 widgets → the same messages `SaveAsync` gives today.
  - `Check_refuses_a_workbook_over_2_MB`: a markdown widget with 2 MB of text → "The workbook can be at most 2 MB."
  - `Workbook_check_over_the_bridge`: a valid doc answers `null`; `version: 2` is a `bad_request` with "This workbook
    needs a newer Kustodian."; no `workbook` is "The request has no workbook."
- [ ] **Step 2: Run** `dotnet test --filter "FullyQualifiedName~Workbook"`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement.** `SaveAsync` keeps its own size check after `modifiedAt` is set; `Check` doesn't replace it.
- [ ] **Step 4: Run** the same filter and `dotnet build -warnaserror`. Expected: PASS, no warnings.
- [ ] **Step 5: Commit**: `feat: workbook.check validates an imported workbook on the host`

### Task 2: Export

**Files:**
- Create: `web/src/workbooks/sharing.ts`, `web/src/workbooks/sharing.test.ts`
- Modify: `web/src/workbooks/workbook-store.ts`, `web/src/workbooks/workbook-view.tsx`

**Interfaces:**
- Produces:

```ts
// workbook-store.ts. Linked widgets take their saved query's current source, text, options, parameters and name; a link
// the library no longer has (or an unreadable library) keeps its last copy. saveWorkbook uses it in place of its own loop.
export async function withLinkedCopies(doc: WorkbookDoc): Promise<WorkbookDoc>;

// sharing.ts
export const WORKBOOK_FILTERS: FileFilter[]; // [{ name: 'Kustodian workbook', extensions: ['json'] }]
/** The suggested file name: the workbook name with \ / : * ? " < > | replaced by '-', then '.kustodian-workbook.json'. */
export const exportFileName: (name: string) => string;
/** Writes the tab's document, as it is now (unsaved edits too), to a file the user picks. False: the dialog was cancelled. */
export async function exportWorkbook(tabId: string): Promise<boolean>;
```

  `exportWorkbook` sends `file.saveAs` with `suggestedName`, `filters: WORKBOOK_FILTERS` and `content` =
  `JSON.stringify(docWithoutModifiedAt, null, 2) + '\n'`. It never passes `path`, so every export shows the dialog. It
  doesn't change the tab: not saved, not dirty.
  The workbook ⋯ menu gets **Export…** after "Save current values as defaults". A rejection shows on the workbook as
  other menu actions' problems do: `The workbook couldn’t be exported: ${errorText(e)}`.

- [ ] **Step 1: Write the failing tests** (`sharing.test.ts`, mock bridge, one open workbook tab):
  - `exportFileName('VM / hygiene: "prod"')` is `'VM - hygiene- -prod-.kustodian-workbook.json'`.
  - `exportWorkbook` on a dirty tab sends `file.saveAs` once with no `path`; its `content` parses back with
    `parseWorkbook` to the tab's doc (minus `modifiedAt`), has no `modifiedAt`, and has the linked widget's text as the
    library has it now. The tab is still dirty afterwards.
  - A remembered value set with `setWorkbookValue` is not in `content`; the parameter's `value` is still its default.
  - A cancelled dialog (`null`) resolves `false`.
  - The existing `saveWorkbook` tests pass unchanged.
- [ ] **Step 2: Run** `npx vitest run src/workbooks/sharing.test.ts src/workbooks/workbook-store.test.ts` in `web/`.
  Expected: the new tests FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit**: `feat: export a workbook to a .kustodian-workbook.json file`

### Task 3: What an import does, as pure functions

**Files:**
- Create: `web/src/workbooks/import.ts`, `web/src/workbooks/import.test.ts`

**Interfaces:**
- Consumes: `parseWorkbook`, `WorkbookDoc`, `Widget`; `ToolList`, `ParameterDef`, `QueryOptions`, `Source` from `wire.ts`;
  `MAX_NAME_LENGTH`, `MAX_FOLDER_LENGTH` from `library/saving.ts`.
- Produces:

```ts
/** JSON.parse then parseWorkbook. A string is what is wrong: "This file isn't JSON." or parseWorkbook's message. */
export function readWorkbookFile(text: string): WorkbookDoc | string;

export interface ImportSummary { widgets: number; parameters: number; sources: Source[]; linked: number } // sources distinct, in graph, hunting, arg order; linked: widgets with saved
export function importSummary(doc: WorkbookDoc): ImportSummary;

/** The library folder for the workbook's queries: trimmed, '/' replaced by '-', cut to MAX_FOLDER_LENGTH and trimmed
 * again; 'Imported workbook' when nothing is left. */
export function importFolder(workbookName: string): string;

export interface LinkedQuery { savedId: string; name: string; source: Exclude<Source, 'raw'>; text: string; parameters: ParameterDef[]; options: QueryOptions | null }
/** One per distinct saved.id, from the first widget that links it. name: saved.name trimmed and cut to MAX_NAME_LENGTH;
 * the widget's title when that is empty; 'Imported query' when both are. */
export function linkedQueries(doc: WorkbookDoc): LinkedQuery[];

export interface ToolMatch { tool: string; mine: boolean } // one per distinct button tool name, in widget then button order
export function matchTools(doc: WorkbookDoc, list: ToolList | null): ToolMatch[]; // mine: list?.tools has that exact name (ordinal, as ExternalToolService looks up)

export interface ImportChoices {
  /** sender's saved id → the new library entry. null: copy every linked query into its widget (saved: null). */
  added: Record<string, { id: string; name: string }> | null;
  /** the file's tool name → one of my tool names, or null to leave the button off (removed). */
  tools: Record<string, string | null>;
  id: string; // the workbook id to use: the file's (replace) or a new one (keep both)
}
/** The document to open or save: id set, modifiedAt removed, queries relinked or copied, buttons renamed or removed. A
 * saved id missing from `added` is copied in. A tool name missing from `tools` is left off. */
export function applyImport(doc: WorkbookDoc, choices: ImportChoices): WorkbookDoc;
```

- [ ] **Step 1: Write the failing tests** (`import.test.ts`, built from the spec §9.2 example plus a hunting widget):
  - `readWorkbookFile('{')` → "This file isn't JSON."; `'{"kind":"x"}'` → "This isn't a Kustodian workbook."
  - `importSummary` of a 2-widget, 1-parameter file with an `arg` and a `hunting` widget, one linked →
    `{ widgets: 2, parameters: 1, sources: ['hunting', 'arg'], linked: 1 }`.
  - `importFolder`: `'Azure / VMs'` → `'Azure - VMs'`; 100 × `'a'` → 80 × `'a'`; `'  '` → `'Imported workbook'`.
  - **Review Focus 5:** two widgets linking `7c1e…` give one `LinkedQuery`, from the first widget. A saved name of 250
    characters is cut to 200; an empty one takes the widget title.
  - `matchTools` with my tools `Start VM` and `stop vm`, and buttons `Start VM`, `Stop VM`, `Start VM` →
    `[{ tool: 'Start VM', mine: true }, { tool: 'Stop VM', mine: false }]`. `list` null or with a `problem` and no tools →
    every `mine: false`.
  - **Review Focus 3:** `applyImport` with `added: { '7c1e…': { id: 'n1', name: 'VMs' } }` rewrites both linked widgets to
    `saved: { id: 'n1', name: 'VMs' }` and keeps their text; with `added: null` both have `saved: null` and the same
    text, source, options and parameters.
  - **Review Focus 2:** `tools: { 'Start VM': 'Start VM', 'Stop VM': 'Deallocate VM' }` keeps the first button and renames
    the second's `tool` to `Deallocate VM` (label and mapping unchanged); `'Stop VM': null` removes it; a tool name missing
    from `tools` removes it. A file whose button had `command: '/bin/sh'` gives a doc whose `JSON.stringify` has no
    `"command"`.
  - `applyImport` sets `id` to `choices.id`, removes `modifiedAt`, and leaves `doc` unchanged (a new object).
- [ ] **Step 2: Run** `npx vitest run src/workbooks/import.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit**: `feat: what importing a workbook does, as pure functions`

### Task 4: The review

**Files:**
- Create: `web/src/workbooks/import-review.tsx`, `web/src/workbooks/import-review.test.tsx`
- Modify: `web/src/workbooks/sharing.ts`, `web/src/workbooks/sharing.test.ts`

**Interfaces:**
- Consumes: Task 1's `workbook.check`, Task 3's functions, `WORKBOOK_FILTERS`, `useTabs().openWorkbook`, `useRevisions`.
- Produces, in `sharing.ts`:

```ts
export interface PendingImport {
  fileName: string;
  text: string;                      // the file as read, shown under "The file"
  doc: WorkbookDoc;                  // parsed
  tools: ToolList | null;            // null: tools.list failed
  existing: WorkbookSummary | null;  // my workbook with doc.id, from workbook.list
  openTabId: string | null;          // a tab holding a workbook with doc.id
}
/** file.open → readWorkbookFile → workbook.check → tools.list and workbook.list → useImportReview.show. Resolves without
 * showing anything when the dialog is cancelled. Rejects with the reason the file can't be imported. */
export async function importWorkbook(): Promise<void>;
export interface ReviewChoices { addQueries: boolean; tools: Record<string, string | null>; replace: boolean }
/** No library or workbook write: linked queries are copied in. Opens a dirty tab without a savedId. */
export function openImported(p: PendingImport, c: ReviewChoices): void;
/** library.save each linkedQueries entry (id null, folder importFolder(doc.name)) when addQueries, then workbook.save, then
 * opens the saved workbook with its savedId and bumps the library revision. Rejects with the first refusal; queries added
 * before it stay in the library. */
export async function saveImported(p: PendingImport, c: ReviewChoices): Promise<void>;
export const useImportReview: UseBoundStore<StoreApi<{ pending: PendingImport | null; show(p: PendingImport): void; close(): void }>>;
```

  The id: `replace` keeps `doc.id`; otherwise, when `existing` or `openTabId` is set, a new `crypto.randomUUID()`. With
  neither, the file's id is kept and the collision section isn't shown.

Behaviour (screen 7): `ImportReview` renders nothing while `pending` is null, else a modal `role="dialog"`
`aria-label="Open a shared workbook"`:
- Header: the heading, `fileName` under it, then **Cancel**, **Open without saving**, **Save to my workbooks** (primary).
  Escape is Cancel. While `saveImported` is out every button is off; a rejection shows in the dialog with
  `ErrorReportActions` and the dialog stays open.
- Left column, sections in this order:
  - **What's in it:** `6 widgets · 2 workbook parameters ·` and a `SourceBadge` per source, then the line from the copy
    list.
  - **Saved queries** (only when `linked > 0`): `✓ 2 widgets use saved queries from the sender's library. The file carries
    their text.`, a checkbox (on) `Add them to my saved queries, under <folder>, and keep the widgets linked`, and the hint
    "Turned off, the queries are copied into the widgets instead. Open without saving always copies them."
  - **Tool buttons** (only when any widget has one): the copy line, then a row per `matchTools` entry. Mine: `✓ Stop VM
    matches your “Stop VM”`. Not mine: `! Stop VM` and a select `aria-label="Tool for Stop VM"` with "Leave this button
    off" (chosen), then each of my tools by name. With `tools` null or a `problem`, the problem text (or "Your tools
    couldn’t be read.") shows above the rows.
  - **Parameter values** (only when the workbook has parameters): a row per parameter, `${label ?? name}: ${value}`
    with a list's lines joined by `, `, and `no default` when empty.
  - **Already in my workbooks** (only on a collision): `You already have “${existing.name}” with this id.` (or `It’s
    already open in a tab.` with no `existing`), radios **Keep both: the import gets a new id** (chosen) and **Replace
    it**. Replace is off while `openTabId` is set, with the hint "It’s open in a tab. Close it to replace it."
- Right column: **The file**, `text` read-only in a scrolling `pre.codeblock`.

- [ ] **Step 1: Write the failing tests** (mock bridge. The file: the spec §9.2 example with a GUID id, a markdown widget
  added, a second button `Start VM` on the table, `"command": "/bin/sh -c evil"` on the `Stop VM` button, and `saved.id`
  set to the GUID of a query already in the mock library. My tools: `Start VM`, `Deallocate VM`, so `Stop VM` is
  unmatched):
  - **Review Focus 1:** `importWorkbook` with `file.open` answering `'{'`, then a `version: 2` file, then one the mock's
    `workbook.check` refuses: each rejects with its message, `useImportReview` stays empty, and no `library.save`,
    `workbook.save` or `query.run` is sent.
  - The dialog shows `2 widgets · 1 workbook parameter`, the folder name, `matches your “Start VM”`, a `Tool for Stop VM`
    select on "Leave this button off", and the file text.
  - **Review Focus 2:** across the whole import (open, review, Save), no `tools.save` or `tools.edit` is sent, and the
    file's `command` value never appears in the dialog's text.
  - **Open without saving:** sends no `library.save`, `workbook.save` or `query.run` before the click; afterwards one
    workbook tab is open, dirty, without a `savedId`, its linked widget has `saved: null`, and `Stop VM` is gone.
  - **Review Focus 3, Save to my workbooks** with Stop VM set to `Deallocate VM`: one `library.save` with `id: null` and
    `folder: 'VM hygiene'`, then `workbook.save` whose widgets link the id the mock answered, and whose second button's
    `tool` is `Deallocate VM`. My existing query with the file's saved id is unchanged in the mock library.
  - Save with the queries box off: no `library.save`; the widget has `saved: null`.
  - **Review Focus 4:** with a workbook of that id in `workbook.list`, Keep both saves under a new id and my workbook is
    unchanged; Replace saves under the file's id. With a tab open holding that id, Replace is disabled and Open without
    saving opens a second tab with a new id.
  - A `workbook.save` refusal shows in the dialog, which stays open; Cancel then closes it and nothing opened.
- [ ] **Step 2: Run** `npx vitest run src/workbooks/import-review.test.tsx src/workbooks/sharing.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** The dialog keeps its choices in local state, starting from `matchTools` (mine → same name,
  else null), `addQueries: true`, `replace: false`.
- [ ] **Step 4: Run** `npx vitest run src/workbooks` and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit**: `feat: review a shared workbook before it is opened or saved`

### Task 5: Entry points, docs and full check

**Files:**
- Modify: `web/src/side/saved-panel.tsx`, `web/src/app.tsx`, `web/src/wire.ts` (comment), `docs/workbooks.md` (a "Sharing"
  section), `CHANGELOG.md` (Unreleased, Added)
- Test: `web/src/side/saved-panel.test.tsx`, `web/src/app.test.tsx` (or the file the palette's tests live in)

- [ ] **Step 1: Write the failing tests:** the Saved panel's Workbooks group has an **Import…** button that sends
  `file.open` with `WORKBOOK_FILTERS`, and a rejection shows in the panel's problem line as `The workbook couldn’t be
  imported: …`. The palette lists **Import workbook…** (group Tabs) and running it opens the review.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.** `app.tsx` mounts `<ImportReview />` once and adds the command, failing through `fail('The
  workbook couldn’t be imported')`. The Workbooks group shows even with no workbooks, so Import is reachable.
- [ ] **Step 4: Write the docs** in the spec's wording: what Export writes (and that it holds no results, tokens or
  remembered values), what the review offers, that tool buttons only ever run a tool of the same name in your own
  `tools.json` and import never changes it, and that parameter values aren't checked against your tenant yet.
- [ ] **Step 5: Run the full check:** `dotnet build -warnaserror` and `dotnet test`, then in `web/`: `npm run lint`,
  `npm run typecheck`, `npm test`, `npm run build`. Expected: all pass; the only warnings are the two known ones.
- [ ] **Step 6: Run the app** (the `run` skill) with the mock bridge. Export a workbook with a linked widget and a tool
  button, then import that file: see the review, choose Save to my workbooks, and see the queries under the workbook's
  folder and the workbook open and running. Import it again: see Keep both / Replace. Import a file with an unknown tool:
  see it left off.
- [ ] **Step 7: Commit**: `docs: sharing workbooks`
