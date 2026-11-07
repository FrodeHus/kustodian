import type { StoreApi, UseBoundStore } from 'zustand';
import { create } from 'zustand';
import { call } from '../bridge';
import { useRevisions } from '../library/saving';
import { useTabs } from '../tabs/tab-store';
import type { FileFilter, OpenedFile, SavedFile, SavedQuery, ToolList, WorkbookList, WorkbookSummary } from '../wire';
import { applyImport, importFolder, linkedQueries, readWorkbookFile } from './import';
import type { WorkbookDoc } from './model';
import { useWorkbooks, withLinkedCopies } from './workbook-store';

export const WORKBOOK_FILTERS: FileFilter[] = [{ name: 'Kustodian workbook', extensions: ['json'] }];

/** The suggested file name: the workbook name with \ / : * ? " < > | replaced by '-', then '.kustodian-workbook.json'. */
export const exportFileName = (name: string): string => `${name.replace(/[\\/:*?"<>|]/g, '-')}.kustodian-workbook.json`;

/** Writes the tab's document, as it is now (unsaved edits too), to a file the user picks. False: the dialog was cancelled. */
export async function exportWorkbook(tabId: string): Promise<boolean> {
  const base = useWorkbooks.getState().byTab[tabId]?.doc;
  if (!base) {
    throw new Error('The workbook is no longer open.');
  }
  // The file holds the author's defaults: no results, remembered values or save time.
  const { modifiedAt: _modifiedAt, ...doc } = await withLinkedCopies(base);
  const file = await call<SavedFile | null>('file.saveAs', {
    suggestedName: exportFileName(base.name),
    filters: WORKBOOK_FILTERS,
    content: `${JSON.stringify(doc, null, 2)}\n`,
  });
  return file !== null;
}

export interface PendingImport {
  fileName: string;
  /** What is shown under "The file": the parsed document, so nothing the import drops (a button's command) is ever shown. */
  text: string;
  doc: WorkbookDoc;
  /** null: tools.list failed. */
  tools: ToolList | null;
  /** My workbook with doc.id. */
  existing: WorkbookSummary | null;
  /** A tab holding a workbook with doc.id. */
  openTabId: string | null;
}

export const useImportReview: UseBoundStore<StoreApi<{ pending: PendingImport | null; show(p: PendingImport): void; close(): void }>> =
  create<{ pending: PendingImport | null; show(p: PendingImport): void; close(): void }>()((set) => ({
    pending: null,
    show: (pending) => set({ pending }),
    close: () => set({ pending: null }),
  }));

/** file.open → readWorkbookFile → workbook.check → tools.list and workbook.list → the review. Resolves without showing anything
 * when the dialog is cancelled. Rejects with the reason the file can't be imported. */
export async function importWorkbook(): Promise<void> {
  const file = await call<OpenedFile | null>('file.open', { filters: WORKBOOK_FILTERS });
  if (!file) {
    return;
  }
  const doc = readWorkbookFile(file.text);
  if (typeof doc === 'string') {
    throw new Error(doc);
  }
  // The file is untrusted: the host checks it as it would a save, before anything is shown.
  await call('workbook.check', { workbook: doc });
  const [tools, list] = await Promise.all([
    call<ToolList>('tools.list').catch(() => null),
    call<WorkbookList>('workbook.list'),
  ]);
  useImportReview.getState().show({
    fileName: file.name,
    text: JSON.stringify(doc, null, 2),
    doc,
    tools,
    existing: list.workbooks.find((w) => w.id === doc.id) ?? null,
    openTabId: useTabs.getState().tabs.find((t) => t.workbook?.id === doc.id)?.id ?? null,
  });
}

export interface ReviewChoices {
  addQueries: boolean;
  tools: Record<string, string | null>;
  replace: boolean;
}

/** Replace keeps the file's id; on a collision Keep both takes a new one; with no collision the file's id is kept. */
const importId = (p: PendingImport, c: ReviewChoices) =>
  !c.replace && (p.existing || p.openTabId) ? crypto.randomUUID() : p.doc.id;

/** No library or workbook write: linked queries are copied in. Opens a dirty tab without a savedId. */
export function openImported(p: PendingImport, c: ReviewChoices): void {
  useTabs.getState().openWorkbook(applyImport(p.doc, { added: null, tools: c.tools, id: importId(p, c) }), { dirty: true });
}

/** library.save each linked query (new id, folder importFolder(doc.name)) when addQueries, then workbook.save, then opens the
 * saved workbook and bumps the library revision. Rejects with the first refusal; queries added before it stay in the library. */
export async function saveImported(p: PendingImport, c: ReviewChoices): Promise<void> {
  const added: Record<string, { id: string; name: string }> = {};
  try {
    if (c.addQueries) {
      const folder = importFolder(p.doc.name);
      for (const q of linkedQueries(p.doc)) {
        const saved = await call<SavedQuery>('library.save', {
          query: { id: null, name: q.name, folder, source: q.source, text: q.text, parameters: q.parameters, options: q.options },
        });
        added[q.savedId] = { id: saved.id, name: saved.name };
      }
    }
    const doc = applyImport(p.doc, { added: c.addQueries ? added : null, tools: c.tools, id: importId(p, c) });
    const { workbook } = await call<{ workbook: WorkbookDoc }>('workbook.save', { workbook: doc });
    useTabs.getState().openWorkbook(workbook, { savedId: workbook.id });
  } finally {
    useRevisions.getState().bump('library');
  }
}
