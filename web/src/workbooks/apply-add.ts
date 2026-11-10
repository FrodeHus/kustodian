import { call } from '../bridge';
import { useTabs } from '../tabs/tab-store';
import type { ParameterDef } from '../wire';
import { addWidget, isFull } from './add-to-workbook';
import type { Widget, WorkbookDoc } from './model';
import { newWorkbook, parseWorkbook, withFileVersion } from './model';
import { saveWorkbook, useWorkbooks } from './workbook-store';

export type AddTarget = { kind: 'existing'; id: string; name: string } | { kind: 'new'; name: string; folder: string | null };

const openTabOf = (id: string) =>
  useTabs.getState().tabs.find((t) => t.source === 'workbook' && (t.workbook?.id === id || t.savedId === id));

/** Writes `doc` to its file and opens it in a tab; nothing opens when the save fails. */
async function saveAndOpen(doc: WorkbookDoc, widgetId: string): Promise<{ notice?: string }> {
  const { workbook } = await call<{ workbook: WorkbookDoc }>('workbook.save', { workbook: withFileVersion(doc) });
  const tabId = useTabs.getState().openWorkbook(workbook, { savedId: workbook.id });
  useWorkbooks.getState().reveal(tabId, widgetId);
  return {};
}

/**
 * Adds `widget` to a workbook and brings that workbook's tab to the front with the widget revealed. An open workbook takes it
 * through the store: saved when it had no unsaved edits, else left in the draft (with a notice). One not open is read, added
 * to and saved, then opened. Throws the reason, for the user, when it can't; on failure nothing is written or opened.
 */
export async function applyAdd(target: AddTarget, widget: Widget, tabParameters: ParameterDef[]): Promise<{ notice?: string }> {
  if (target.kind === 'new') {
    return saveAndOpen(addWidget({ ...newWorkbook(target.name), folder: target.folder }, widget, tabParameters), widget.id);
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
      return saveAndOpen(addWidget(doc, widget, tabParameters), widget.id);
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
