import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTabs } from '../tabs/tab-store';
import type { ParameterDef } from '../wire';
import { applyAdd } from './apply-add';
import type { Widget, WorkbookDoc } from './model';
import { newWidget, newWorkbook } from './model';
import { useWorkbooks } from './workbook-store';

const bridge = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../bridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../bridge')>()),
  call: bridge.call,
  on: () => () => undefined,
}));

let files: Map<string, WorkbookDoc>;
const saves = () => bridge.call.mock.calls.filter(([m]) => m === 'workbook.save').map(([, p]) => (p as { workbook: WorkbookDoc }).workbook);

const who: ParameterDef = { name: 'who', type: 'text', value: 'ada', required: false, choices: null };
const widget = (): Widget => {
  const w = newWidget('table', { x: 0, y: 0, w: 12, h: 8 });
  return { ...w, id: 'new-w', title: 'Users', query: { ...w.query!, text: 'Users | where name == {who}' } };
};

beforeEach(() => {
  files = new Map();
  bridge.call.mockReset();
  bridge.call.mockImplementation((method: string, params?: { id?: string; workbook?: WorkbookDoc }) => {
    switch (method) {
      case 'workbook.get':
        return Promise.resolve({ workbook: files.get(params!.id!) ?? null });
      case 'workbook.save':
        files.set(params!.workbook!.id, params!.workbook!);
        return Promise.resolve({ workbook: params!.workbook });
      case 'library.list':
        return Promise.resolve({ queries: [], folders: [], skipped: 0 });
      case 'workbook.values.get':
        return Promise.resolve({ values: {} });
      default:
        return Promise.resolve(null);
    }
  });
  useTabs.setState({ tabs: [], activeId: null, cursors: {} });
  useWorkbooks.setState({ byTab: {}, revealing: null });
});

/** A workbook open in a tab, loaded into the store, with `dirty` as given; another tab is active. */
async function openTab(doc: WorkbookDoc, dirty: boolean): Promise<string> {
  const id = useTabs.getState().openWorkbook(doc, { savedId: doc.id, dirty });
  await useWorkbooks.getState().load(id, doc, { dirty });
  useTabs.getState().openWith({ source: 'graph', title: 'Query', text: '' });
  return id;
}

describe('applyAdd', () => {
  it('adds to a workbook that isn’t open, saves it and opens it with the widget revealed', async () => {
    files.set('wb', { ...newWorkbook('Ops'), id: 'wb' });
    await expect(applyAdd({ kind: 'existing', id: 'wb', name: 'Ops' }, widget(), [who])).resolves.toEqual({});
    const [saved] = saves();
    expect(saved!.widgets.map((w) => w.id)).toEqual(['new-w']);
    expect(saved!.parameters).toMatchObject([{ name: 'who', value: 'ada' }]);
    const tab = useTabs.getState().tabs.find((t) => t.workbook?.id === 'wb')!;
    expect(useTabs.getState().activeId).toBe(tab.id);
    expect(tab.savedId).toBe('wb');
    expect(useWorkbooks.getState().revealing).toEqual({ tabId: tab.id, widgetId: 'new-w' });
  });

  it('adds to an open workbook with no unsaved edits through the store, and saves it', async () => {
    const doc = { ...newWorkbook('Ops'), id: 'wb' };
    const id = await openTab(doc, false);
    await expect(applyAdd({ kind: 'existing', id: 'wb', name: 'Ops' }, widget(), [who])).resolves.toEqual({});
    expect(useWorkbooks.getState().byTab[id]!.doc.widgets.map((w) => w.id)).toEqual(['new-w']);
    expect(useWorkbooks.getState().byTab[id]!.dirty).toBe(false);
    expect(saves()[0]!.widgets.map((w) => w.id)).toEqual(['new-w']);
    expect(useTabs.getState().activeId).toBe(id);
    expect(useWorkbooks.getState().revealing).toEqual({ tabId: id, widgetId: 'new-w' });
  });

  it('adds to the unsaved changes of an open workbook without saving', async () => {
    const id = await openTab({ ...newWorkbook('Ops'), id: 'wb' }, true);
    await expect(applyAdd({ kind: 'existing', id: 'wb', name: 'Ops' }, widget(), [who])).resolves.toEqual({
      notice: 'Added to your unsaved changes in Ops.',
    });
    expect(useWorkbooks.getState().byTab[id]!.doc.widgets.map((w) => w.id)).toEqual(['new-w']);
    expect(saves()).toEqual([]);
    expect(useTabs.getState().activeId).toBe(id);
  });

  it('finds an open tab by its saved id too', async () => {
    const id = useTabs.getState().openWorkbook({ ...newWorkbook('Ops'), id: 'other' }, { savedId: 'wb' });
    await useWorkbooks.getState().load(id, useTabs.getState().tabs[0]!.workbook!, { dirty: true });
    await applyAdd({ kind: 'existing', id: 'wb', name: 'Ops' }, widget(), []);
    expect(useWorkbooks.getState().byTab[id]!.doc.widgets).toHaveLength(1);
    expect(bridge.call).not.toHaveBeenCalledWith('workbook.get', expect.anything());
  });

  it('puts back the draft when saving an open workbook fails', async () => {
    const doc = { ...newWorkbook('Ops'), id: 'wb' };
    const id = await openTab(doc, false);
    bridge.call.mockImplementation((method: string) =>
      method === 'workbook.save' ? Promise.reject(new Error('Disk full.')) : Promise.resolve({ queries: [] }),
    );
    await expect(applyAdd({ kind: 'existing', id: 'wb', name: 'Ops' }, widget(), [])).rejects.toThrow('Disk full.');
    expect(useWorkbooks.getState().byTab[id]!.doc).toBe(doc);
    expect(useWorkbooks.getState().byTab[id]!.dirty).toBe(false);
    expect(useWorkbooks.getState().revealing).toBeNull();
  });

  it.each([false, true])('gives the widget to a tab that opened the workbook during the save (dirty: %s)', async (dirty) => {
    const doc = { ...newWorkbook('Ops'), id: 'wb' };
    files.set('wb', doc);
    let id = '';
    const save = bridge.call.getMockImplementation()!;
    bridge.call.mockImplementation(async (method: string, params?: unknown) => {
      if (method === 'workbook.save') {
        id = await openTab(doc, dirty);
      }
      return save(method, params);
    });
    const answer = await applyAdd({ kind: 'existing', id: 'wb', name: 'Ops' }, widget(), [who]);
    expect(useTabs.getState().tabs.filter((t) => t.source === 'workbook')).toHaveLength(1);
    expect(useWorkbooks.getState().byTab[id]!.doc.widgets.map((w) => w.id)).toEqual(['new-w']);
    expect(useWorkbooks.getState().byTab[id]!.dirty).toBe(dirty);
    expect(answer).toEqual(dirty ? { notice: 'Added to your unsaved changes in Ops.' } : {});
    expect(useTabs.getState().activeId).toBe(id);
    expect(useWorkbooks.getState().revealing).toEqual({ tabId: id, widgetId: 'new-w' });
  });

  it('saves a new workbook with the name, folder and widget, and opens it', async () => {
    await applyAdd({ kind: 'new', name: 'Fresh', folder: 'Team' }, widget(), [who]);
    const [saved] = saves();
    expect(saved).toMatchObject({ name: 'Fresh', folder: 'Team' });
    expect(saved!.widgets).toHaveLength(1);
    const tab = useTabs.getState().tabs.find((t) => t.workbook?.id === saved!.id)!;
    expect(useTabs.getState().activeId).toBe(tab.id);
    expect(tab.savedId).toBe(saved!.id);
  });

  it('says a workbook that no longer exists, and saves and opens nothing', async () => {
    await expect(applyAdd({ kind: 'existing', id: 'gone', name: 'Ops' }, widget(), [])).rejects.toThrow('Ops no longer exists.');
    expect(saves()).toEqual([]);
    expect(useTabs.getState().tabs).toEqual([]);
  });

  it('opens nothing when the save fails', async () => {
    files.set('wb', { ...newWorkbook('Ops'), id: 'wb' });
    bridge.call.mockImplementation((method: string, params?: { id: string }) =>
      method === 'workbook.save' ? Promise.reject(new Error('Disk full.')) : Promise.resolve({ workbook: files.get(params!.id) }),
    );
    await expect(applyAdd({ kind: 'existing', id: 'wb', name: 'Ops' }, widget(), [])).rejects.toThrow('Disk full.');
    expect(useTabs.getState().tabs).toEqual([]);
  });
});
