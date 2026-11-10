import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BridgeError } from '../bridge';
import { useRevisions } from '../library/saving';
import { useTabs } from '../tabs/tab-store';
import type { SavedQuery } from '../wire';
import { ImportReview } from './import-review';
import { parseWorkbook, type WorkbookDoc } from './model';
import { importWorkbook, saveImported, useImportReview } from './sharing';

const bridge = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../bridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../bridge')>()),
  call: bridge.call,
  on: () => () => undefined,
}));

const WB_ID = '5b0c9a6e-1f7d-4c2a-9e3b-8d4f6a2c1e07';
const SAVED_ID = '7c1e4b2a-3d5f-4e6a-8b9c-0d1e2f3a4b5c';
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const button = (label: string, extra: object = {}) => ({
  label,
  tool: label,
  mapping: { id: 'id' },
  runsOn: 'selectedOrAll',
  after: 'refreshWidget',
  placement: 'header',
  ...extra,
});
// Spec §9.2's example, with a markdown widget, a second button and a command a crafted file might carry.
const FILE = JSON.stringify(
  {
    kind: 'kustodian.workbook',
    version: 1,
    id: WB_ID,
    name: 'VM hygiene',
    folder: 'Azure',
    command: '/bin/sh -c top',
    parameters: [{ name: 'Subscriptions', type: 'list', value: '', required: false, multi: true, all: true }],
    widgets: [
      {
        id: 'vms',
        type: 'table',
        title: 'Virtual machines',
        layout: { x: 0, y: 0, w: 12, h: 20 },
        query: {
          saved: { id: SAVED_ID, name: 'Azure / VMs by power state' },
          source: 'arg',
          text: 'resources | take 10',
          options: null,
          command: '/bin/sh -c query',
        },
        parameters: { PowerState: { from: 'widget', value: 'any' } },
        selection: 'multi',
        command: '/bin/sh -c widget',
        tools: [button('Start VM'), button('Stop VM', { command: '/bin/sh -c evil' }), { ...button('Refresh'), tool: 'Delete VM' }],
      },
      { id: 'notes', type: 'markdown', title: 'Notes', layout: { x: 0, y: 20, w: 12, h: 4 }, markdown: 'Check weekly.', parameters: {} },
    ],
  },
  null,
  2,
);

const mine: SavedQuery = {
  version: 1,
  id: SAVED_ID,
  name: 'My own query',
  folder: null,
  source: 'graph',
  text: 'users',
  parameters: [],
  createdAt: '',
  modifiedAt: '',
  options: null,
};
let library: Map<string, SavedQuery>;
let workbooks: Map<string, WorkbookDoc>;
let refuseSave: boolean;
let fileText: string;

const sent = (method: string) => bridge.call.mock.calls.filter((c) => c[0] === method).map((c) => c[1] as Record<string, unknown>);
const savedWorkbook = () => sent('workbook.save')[0]!.workbook as WorkbookDoc;
const myWorkbook = (): WorkbookDoc => ({ ...(parseWorkbook(JSON.parse(FILE)) as WorkbookDoc), name: 'Mine', widgets: [] });

beforeEach(() => {
  library = new Map([[SAVED_ID, mine]]);
  workbooks = new Map();
  refuseSave = false;
  fileText = FILE;
  let n = 0;
  bridge.call.mockReset();
  bridge.call.mockImplementation((method: string, params?: Record<string, unknown>) => {
    switch (method) {
      case 'file.open':
        return Promise.resolve({
          path: '/x/VM hygiene.kustodian-workbook.json',
          name: 'VM hygiene.kustodian-workbook.json',
          text: fileText,
        });
      case 'workbook.check':
        return Promise.resolve(null);
      case 'tools.list':
        return Promise.resolve({
          tools: ['Start VM', 'Deallocate VM'].map((name) => ({ name, command: '/usr/bin/az', args: [], mode: 'each' })),
          problem: null,
          path: '/x/tools.json',
          missing: [],
        });
      case 'workbook.list':
        return Promise.resolve({
          workbooks: [...workbooks.values()].map((w) => ({
            id: w.id,
            name: w.name,
            folder: w.folder,
            modifiedAt: '',
            widgets: w.widgets.length,
          })),
          folders: [],
          skipped: 0,
        });
      case 'library.save': {
        const q = params!.query as SavedQuery;
        const saved = { ...q, id: q.id ?? `00000000-0000-4000-8000-00000000000${++n}`, version: 1 as const, createdAt: '', modifiedAt: '' };
        library.set(saved.id, saved);
        return Promise.resolve(saved);
      }
      case 'workbook.save': {
        if (refuseSave) {
          return Promise.reject(new BridgeError('bad_request', 'The workbooks folder is read-only.'));
        }
        const workbook = { ...(params!.workbook as WorkbookDoc), modifiedAt: '2026-11-07T00:00:00Z' };
        workbooks.set(workbook.id, workbook);
        return Promise.resolve({ workbook });
      }
      default:
        return Promise.reject(new Error(`unexpected ${method}`));
    }
  });
  useTabs.setState({ tabs: [], activeId: null, cursors: {} });
  useImportReview.setState({ pending: null });
});

const review = async () => {
  await importWorkbook();
  render(<ImportReview />);
  return screen.getByRole('dialog', { name: 'Open a shared workbook' });
};
const closed = () => waitFor(() => expect(useImportReview.getState().pending).toBeNull());
const neverSent = (...methods: string[]) => methods.forEach((m) => expect(sent(m)).toHaveLength(0));

describe('ImportReview', () => {
  it('renders nothing without a pending import', () => {
    const { container } = render(<ImportReview />);
    expect(container.innerHTML).toBe('');
  });

  it('shows what is in the file, its saved queries, tool matches, parameters and text', async () => {
    const dialog = await review();
    expect(dialog.textContent).toContain('VM hygiene.kustodian-workbook.json');
    expect(dialog.textContent).toContain('2 widgets · 1 workbook parameter');
    expect(dialog.textContent).toContain('Queries, layout, parameters and button settings only.');
    expect(screen.getByRole('checkbox', { name: /under VM hygiene, and keep the widgets linked/ })).toHaveProperty('checked', true);
    expect(dialog.textContent).toContain('matches your “Start VM”');
    const stop = screen.getByLabelText<HTMLSelectElement>('Tool for Stop VM');
    expect(stop.value).toBe('');
    expect(stop.selectedOptions[0]?.textContent).toBe('Leave this button off');
    expect([...stop.options].map((o) => o.textContent)).toEqual(['Leave this button off', 'Start VM', 'Deallocate VM']);
    expect(dialog.textContent).toContain('Subscriptions: no default');
    expect(dialog.querySelector('pre.codeblock')?.textContent).toContain('"name": "VM hygiene"');
    expect(screen.queryByText('Already in my workbooks')).toBeNull();
  });

  it('never shows or saves the file’s command and never touches tools.json', async () => {
    const dialog = await review();
    expect(dialog.textContent).not.toContain('/bin/sh');
    expect(dialog.querySelector('pre.codeblock')?.textContent).not.toContain('"command"');
    fireEvent.click(screen.getByRole('button', { name: 'Save to my workbooks' }));
    await closed();
    expect(JSON.stringify(savedWorkbook())).not.toContain('/bin/sh');
    expect(JSON.stringify(savedWorkbook())).not.toContain('"command"');
    neverSent('tools.save', 'tools.edit');
  });

  it('shows a button whose label is not its tool', async () => {
    const dialog = await review();
    expect(dialog.textContent).toContain('Refresh → Delete VM');
    expect(dialog.textContent).not.toContain('Start VM → Start VM');
  });

  it('says what is in a markdown-only file without a dangling separator', async () => {
    fileText = JSON.stringify({
      ...(JSON.parse(FILE) as { widgets: unknown[] }),
      parameters: [],
      widgets: [(JSON.parse(FILE) as { widgets: unknown[] }).widgets[1]],
    });
    const dialog = await review();
    const line = within(dialog).getByText(/1 widget/);
    expect(line.textContent?.trim()).toBe('1 widget · 0 workbook parameters');
  });

  it('a new pending import starts with fresh choices', async () => {
    await review();
    fireEvent.click(screen.getByRole('checkbox', { name: /Add them to my saved queries/ }));
    expect(screen.getByRole('checkbox', { name: /Add them to my saved queries/ })).toHaveProperty('checked', false);
    await act(() => importWorkbook());
    expect(screen.getByRole('checkbox', { name: /Add them to my saved queries/ })).toHaveProperty('checked', true);
  });

  it('a retried Save adds the linked queries once', async () => {
    refuseSave = true;
    await review();
    fireEvent.click(screen.getByRole('button', { name: 'Save to my workbooks' }));
    await screen.findByRole('alert');
    refuseSave = false;
    fireEvent.click(screen.getByRole('button', { name: 'Save to my workbooks' }));
    await closed();
    expect(sent('library.save')).toHaveLength(1);
    expect(library.size).toBe(2);
    const [first, second] = sent('workbook.save').map((s) => (s.workbook as WorkbookDoc).widgets[0]!.query?.saved?.id);
    expect(second).toBe(first);
  });

  it('Save relinks a saved id named "__proto__"', async () => {
    fileText = FILE.replace(SAVED_ID, '__proto__');
    await review();
    fireEvent.click(screen.getByRole('button', { name: 'Save to my workbooks' }));
    await closed();
    const newId = [...library.keys()].find((k) => k !== SAVED_ID)!;
    expect(savedWorkbook().widgets[0]!.query?.saved).toEqual({ id: newId, name: 'Azure / VMs by power state' });
  });

  it('Open without saving writes nothing and opens a dirty, unsaved tab with the queries copied in', async () => {
    await review();
    neverSent('library.save', 'workbook.save', 'query.run');
    fireEvent.click(screen.getByRole('button', { name: 'Open without saving' }));
    await closed();
    neverSent('library.save', 'workbook.save', 'query.run');
    const { tabs } = useTabs.getState();
    expect(tabs).toHaveLength(1);
    expect(tabs[0]).toMatchObject({ dirty: true, savedId: undefined });
    const vms = tabs[0]!.workbook!.widgets[0]!;
    expect(vms.query?.saved).toBeNull();
    expect(vms.query?.text).toBe('resources | take 10');
    expect(vms.tools?.map((b) => b.tool)).toEqual(['Start VM']);
  });

  it('Save adds the linked query under a new id, links it, maps the button, and leaves my query alone', async () => {
    const revision = useRevisions.getState().library;
    await review();
    fireEvent.change(screen.getByLabelText('Tool for Stop VM'), { target: { value: 'Deallocate VM' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save to my workbooks' }));
    await closed();

    const added = sent('library.save');
    expect(added).toHaveLength(1);
    expect(added[0]!.query).toMatchObject({
      id: null,
      folder: 'VM hygiene',
      name: 'Azure / VMs by power state',
      source: 'arg',
      text: 'resources | take 10',
    });
    const newId = [...library.keys()].find((k) => k !== SAVED_ID)!;
    const wb = savedWorkbook();
    expect(wb.id).toBe(WB_ID);
    expect(wb.widgets[0]!.query?.saved).toEqual({ id: newId, name: 'Azure / VMs by power state' });
    expect(wb.widgets[0]!.tools?.[1]?.tool).toBe('Deallocate VM');
    expect(library.get(SAVED_ID)).toBe(mine);
    expect(useTabs.getState().tabs[0]).toMatchObject({ savedId: WB_ID, dirty: false });
    expect(useRevisions.getState().library).toBeGreaterThan(revision);
  });

  it('Save with the queries box off copies them into the widgets', async () => {
    await review();
    fireEvent.click(screen.getByRole('checkbox', { name: /Add them to my saved queries/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save to my workbooks' }));
    await closed();
    neverSent('library.save');
    expect(savedWorkbook().widgets[0]!.query?.saved).toBeNull();
  });

  describe('a workbook with the file’s id', () => {
    beforeEach(() => workbooks.set(WB_ID, myWorkbook()));

    it('Keep both saves under a new id and leaves mine', async () => {
      const before = workbooks.get(WB_ID);
      const dialog = await review();
      expect(dialog.textContent).toContain('You already have “Mine” with this id.');
      expect(screen.getByRole('radio', { name: 'Keep both: the import gets a new id' })).toHaveProperty('checked', true);
      fireEvent.click(screen.getByRole('button', { name: 'Save to my workbooks' }));
      await closed();
      expect(savedWorkbook().id).not.toBe(WB_ID);
      expect(savedWorkbook().id).toMatch(GUID);
      expect(workbooks.get(WB_ID)).toBe(before);
    });

    it('Replace with Open without saving opens under a new id', async () => {
      await review();
      fireEvent.click(screen.getByRole('radio', { name: 'Replace it' }));
      fireEvent.click(screen.getByRole('button', { name: 'Open without saving' }));
      await closed();
      expect(useTabs.getState().tabs[0]!.workbook!.id).not.toBe(WB_ID);
      expect(useTabs.getState().tabs[0]!.workbook!.id).toMatch(GUID);
    });

    it('Replace saves under the file’s id', async () => {
      await review();
      fireEvent.click(screen.getByRole('radio', { name: 'Replace it' }));
      fireEvent.click(screen.getByRole('button', { name: 'Save to my workbooks' }));
      await closed();
      expect(savedWorkbook().id).toBe(WB_ID);
    });
  });

  it('with a tab holding the id, Replace is off and Open without saving opens a second tab', async () => {
    act(() => void useTabs.getState().openWorkbook(myWorkbook(), { savedId: WB_ID }));
    const dialog = await review();
    expect(dialog.textContent).toContain('It’s already open in a tab.');
    expect(dialog.textContent).toContain('It’s open in a tab. Close it to replace it.');
    expect(screen.getByRole('radio', { name: 'Replace it' })).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('button', { name: 'Open without saving' }));
    await closed();
    const { tabs } = useTabs.getState();
    expect(tabs).toHaveLength(2);
    expect(tabs[1]!.workbook!.id).not.toBe(WB_ID);
    expect(tabs[1]!.workbook!.id).toMatch(GUID);
  });

  it('Save with Replace while a tab holds the id still takes a new id', async () => {
    act(() => void useTabs.getState().openWorkbook(myWorkbook(), { savedId: WB_ID }));
    await importWorkbook();
    await saveImported(useImportReview.getState().pending!, { addQueries: false, tools: {}, replace: true });
    expect(savedWorkbook().id).not.toBe(WB_ID);
    expect(savedWorkbook().id).toMatch(GUID);
  });

  it('shows a refused save in the dialog, which stays open; Cancel then closes it', async () => {
    refuseSave = true;
    await review();
    fireEvent.click(screen.getByRole('button', { name: 'Save to my workbooks' }));
    expect((await screen.findByRole('alert')).textContent).toContain('The workbooks folder is read-only.');
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveProperty('disabled', false);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await closed();
    expect(useTabs.getState().tabs).toHaveLength(0);
  });

  it('Escape is Cancel', async () => {
    const dialog = await review();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await closed();
    neverSent('library.save', 'workbook.save');
  });
});
