import { create } from 'zustand';
import { call } from '../bridge';
import { useTabs, type Tab } from '../tabs/tab-store';
import type { FileFilter, LibraryList, OpenedFile, SavedFile, SavedQuery } from '../wire';

/** The filter for every `.kql` dialog. */
export const KQL_FILTERS: FileFilter[] = [{ name: 'KQL', extensions: ['kql'] }];

/** Files over this size aren't opened (the host's limit for `file.open`). */
export const MAX_OPEN_BYTES = 5 * 1024 * 1024;

/** Counts changes to the library and the snippets, so the panels that list them read them again. */
export const useRevisions = create<{ library: number; snippets: number; bump: (what: 'library' | 'snippets') => void }>()((set) => ({
  library: 0,
  snippets: 0,
  bump: (what) => set((s) => ({ [what]: s[what] + 1 })),
}));

const findTab = (id: string): Tab | undefined => useTabs.getState().tabs.find((t) => t.id === id);

/** The saved query with this id, or undefined when the library has none. */
export async function findSaved(id: string): Promise<SavedQuery | undefined> {
  const list = await call<LibraryList>('library.list');
  return list.queries.find((q) => q.id === id);
}

/** Saves the tab to the library under `name` and `folder` (null: no folder): over the query it came from, or as a new one
 * when it has none or `asNew` says so (Save as). */
export async function saveToLibrary(tabId: string, name: string, folder: string | null, asNew = false): Promise<SavedQuery> {
  const tab = findTab(tabId);
  if (!tab) {
    throw new Error('The tab is no longer open.');
  }
  const saved = await call<SavedQuery>('library.save', {
    query: { id: asNew ? null : (tab.savedId ?? null), name, folder, source: tab.source, text: tab.text, parameters: tab.parameters },
  });
  useTabs.getState().markSaved(tabId, { savedId: saved.id, title: saved.name });
  useRevisions.getState().bump('library');
  return saved;
}

const withExtension = (name: string) => (/\.kql$/i.test(name) ? name : `${name}.kql`);

/**
 * Writes the tab to a `.kql` file; resolves whether it was written (false: the dialog was cancelled). With `toItsFile` the
 * tab's own file is offered to the host, which writes it without a dialog when the user chose that file earlier.
 */
export async function saveToFile(tabId: string, opts: { name?: string; toItsFile?: boolean } = {}): Promise<boolean> {
  const tab = findTab(tabId);
  if (!tab) {
    throw new Error('The tab is no longer open.');
  }
  const params: Record<string, unknown> = { suggestedName: withExtension(opts.name ?? tab.title), filters: KQL_FILTERS, content: tab.text };
  if (opts.toItsFile && tab.filePath) {
    params.path = tab.filePath;
  }
  const file = await call<SavedFile | null>('file.saveAs', params);
  if (!file) {
    return false;
  }
  useTabs.getState().markSaved(tabId, { filePath: file.path, title: file.name });
  return true;
}

/**
 * Save (spec 6.2): a tab from the library updates its saved query, a tab from a file writes the file, and any other tab needs
 * the save dialog. Resolves `dialog` when the caller should show it (also when the tab's saved query was deleted meanwhile).
 */
export async function save(tabId: string): Promise<'saved' | 'cancelled' | 'dialog'> {
  const tab = findTab(tabId);
  if (!tab) {
    return 'cancelled';
  }
  if (tab.savedId) {
    const saved = await findSaved(tab.savedId);
    if (!saved) {
      return 'dialog';
    }
    await saveToLibrary(tabId, saved.name, saved.folder);
    return 'saved';
  }
  if (tab.filePath) {
    return (await saveToFile(tabId, { toItsFile: true })) ? 'saved' : 'cancelled';
  }
  return 'dialog';
}

/** Asks the host for a `.kql` file and opens it in a new Graph tab that saves back to it. */
export async function openKqlFile(): Promise<void> {
  const file = await call<OpenedFile | null>('file.open', { filters: KQL_FILTERS });
  if (file) {
    useTabs.getState().openWith({ source: 'graph', title: file.name, text: file.text, filePath: file.path });
  }
}

/** Opens a `.kql` file dropped on the window in a new Graph tab. The host never approved its path, so the tab has none and
 * its first Save asks where. Rejects with the reason a file can't be opened. */
export function openDroppedFile(file: File): Promise<void> {
  if (!/\.kql$/i.test(file.name)) {
    return Promise.reject(new Error(`Only .kql files can be opened; ${file.name} isn’t one.`));
  }
  if (file.size > MAX_OPEN_BYTES) {
    return Promise.reject(new Error('Files over 5 MB can’t be opened.'));
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      useTabs.getState().openWith({ source: 'graph', title: file.name, text: String(reader.result ?? '') });
      resolve();
    };
    reader.onerror = () => reject(new Error(`${file.name} couldn’t be read.`));
    reader.readAsText(file);
  });
}
