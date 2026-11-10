import { call } from '../bridge';
import { useRevisions } from '../library/saving';
import { useTabs } from '../tabs/tab-store';
import type { ParameterDef } from '../wire';
import { addWidget, isFull } from './add-to-workbook';
import type { Widget, WorkbookDoc } from './model';
import { newWorkbook, parseWorkbook, withFileVersion } from './model';
import { saveWorkbook, useWorkbooks } from './workbook-store';

export type AddTarget = { kind: 'existing'; id: string; name: string } | { kind: 'new'; name: string; folder: string | null };

const openTabOf = (id: string) =>
  useTabs.getState().tabs.find((t) => t.source === 'workbook' && (t.workbook?.id === id || t.savedId === id));

/**
 * Writes `doc` (which has `widget`) to its file and opens it in a tab; nothing opens when the save fails. A tab that opened the
 * workbook while the save was out has the file as it was: it takes the saved doc, or, with unsaved edits, the widget in its draft.
 */
async function saveAndOpen(doc: WorkbookDoc, widget: Widget, tabParameters: ParameterDef[]): Promise<{ notice?: string }> {
  const { workbook } = await call<{ workbook: WorkbookDoc }>('workbook.save', { workbook: withFileVersion(doc) });
  useRevisions.getState().bump('library');
  const opened = openTabOf(workbook.id);
  let notice: string | undefined;
  if (opened) {
    const store = useWorkbooks.getState();
    const s = store.byTab[opened.id];
    const withIt = (d: WorkbookDoc) => (d.widgets.some((w) => w.id === widget.id) ? d : addWidget(d, widget, tabParameters));
    if (s ? s.dirty : opened.dirty && opened.workbook) {
      // Its unsaved edits stay: the widget goes into the draft, the store's or (still loading) the tab's.
      if (s) {
        store.edit(opened.id, withIt);
      } else {
        useTabs.getState().setWorkbook(opened.id, withIt(opened.workbook!), true);
      }
      notice = `Added to your unsaved changes in ${workbook.name}.`;
    } else if (s) {
      store.markSaved(opened.id, workbook);
    } else {
      useTabs.getState().setWorkbook(opened.id, workbook, false);
    }
  }
  let tabId: string;
  if (opened) {
    useTabs.getState().activate(opened.id);
    tabId = opened.id;
  } else {
    tabId = useTabs.getState().openWorkbook(workbook, { savedId: workbook.id });
  }
  useWorkbooks.getState().reveal(tabId, widget.id);
  return notice ? { notice } : {};
}

/**
 * Adds `widget` to a workbook and brings that workbook's tab to the front with the widget revealed. An open workbook takes it
 * through the store: saved when it had no unsaved edits, else left in the draft (with a notice). One not open is read, added
 * to and saved, then opened. Throws the reason, for the user, when it can't; on failure nothing is written or opened.
 */
export async function applyAdd(target: AddTarget, widget: Widget, tabParameters: ParameterDef[]): Promise<{ notice?: string }> {
  if (target.kind === 'new') {
    return saveAndOpen(addWidget({ ...newWorkbook(target.name), folder: target.folder }, widget, tabParameters), widget, tabParameters);
  }
  let tab = openTabOf(target.id);
  if (!tab) {
    const { workbook } = await call<{ workbook: unknown }>('workbook.get', { id: target.id });
    if (workbook === null) {
      throw new Error(`${target.name} no longer exists.`);
    }
    const doc = parseWorkbook(workbook);
    if (typeof doc === 'string') {
      throw new Error(doc);
    }
    tab = openTabOf(target.id);
    if (!tab) {
      if (isFull(doc)) {
        throw new Error(`${target.name} is full.`);
      }
      return saveAndOpen(addWidget(doc, widget, tabParameters), widget, tabParameters);
    }
    // Opened while it was read: add to that tab instead, so its edits aren't written over.
  }
  const tabId = tab.id;
  const store = useWorkbooks.getState();
  const before = store.byTab[tabId];
  if (!before) {
    throw new Error(`${target.name} is still opening.`);
  }
  if (isFull(before.doc)) {
    throw new Error(`${target.name} is full.`);
  }
  store.edit(tabId, (doc) => addWidget(doc, widget, tabParameters));
  if (!before.dirty) {
    try {
      await saveWorkbook(tabId);
    } catch (e) {
      // Put the workbook back as it was, unless it was edited meanwhile.
      const now = useWorkbooks.getState().byTab[tabId];
      if (now && now.undo.at(-1) === before.doc) {
        useWorkbooks.setState((st) => ({
          byTab: { ...st.byTab, [tabId]: { ...now, doc: before.doc, undo: before.undo, redo: before.redo, dirty: false } },
        }));
      }
      throw e;
    }
  }
  useTabs.getState().activate(tabId);
  useWorkbooks.getState().reveal(tabId, widget.id);
  return before.dirty ? { notice: `Added to your unsaved changes in ${target.name}.` } : {};
}
