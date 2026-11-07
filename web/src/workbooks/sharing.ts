import { call } from '../bridge';
import type { FileFilter, SavedFile } from '../wire';
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
