import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExternalTool, RunResult, ToolList } from '../wire';
import { newToolButton, newWidget, newWorkbook, type ToolButton, type Widget, type WorkbookDoc } from './model';
import { useWorkbooks } from './workbook-store';
import { WorkbookView } from './workbook-view';

const call = vi.hoisted(() => vi.fn());
vi.mock('../bridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../bridge')>()),
  call,
  on: () => () => undefined,
}));

const result = (rows: unknown[][]): RunResult => ({
  outcome: 'ok',
  message: null,
  error: null,
  columns: [
    { name: 'name', type: 'string' },
    { name: 'id', type: 'string' },
  ],
  rows,
  total: rows.length,
  tables: [],
  durationMs: 120,
  droppedValues: 0,
  runId: 'r',
  diagnostics: [],
  permissions: [],
});
const vms = result([
  ['web', 'vm-1'],
  ['db', 'vm-2'],
  ['cache', 'vm-3'],
]);

const stopVm: ExternalTool = { name: 'Stop VM', command: '/usr/bin/az', args: ['vm', 'stop', '--ids', '{id}'], mode: 'each' };
const dump: ExternalTool = { name: 'Dump', command: '/bin/cat', args: [], mode: 'batch' };
let list: ToolList;
/** What `query.run` got, in order. */
let queries: { tabId: string; refresh: boolean }[];

function table(id: string, title: string, tools: ToolButton[]): Widget {
  const w = newWidget('table', { x: 0, y: 0, w: 6, h: 12 });
  return { ...w, id, title, query: { ...w.query!, text: 'VMs' }, tools };
}

const button = (extra: Partial<ToolButton> = {}): ToolButton => ({ ...newToolButton(), label: 'Stop VM', tool: 'Stop VM', mapping: { id: 'id' }, ...extra });

function show(tools: ToolButton[], more: Widget[] = []) {
  const doc: WorkbookDoc = { ...newWorkbook('Fleet'), widgets: [table('tb', 'VMs', tools), ...more] };
  useWorkbooks.setState({
    byTab: {
      t: {
        doc,
        values: { workbook: {}, widgets: {} },
        runs: Object.fromEntries(doc.widgets.map((w) => [w.id, { state: 'done', result: vms, finishedAt: 1 }])),
        editing: false,
        undo: [],
        redo: [],
        dirty: false,
        selections: {}, history: {}, since: {}, activeTabs: {}, stale: {},
      },
    },
  });
  return render(<WorkbookView tabId="t" />);
}

const frame = () => screen.getByRole('region', { name: 'VMs' });
const tick = (n: number) => fireEvent.click(within(frame()).getByRole('checkbox', { name: `Select row ${n}` }));

beforeEach(() => {
  list = { tools: [stopVm, dump], problem: null, path: '/tools.json', missing: [] };
  queries = [];
  call.mockReset();
  call.mockImplementation((method: string, params?: unknown) => {
    switch (method) {
      case 'tools.list':
        return Promise.resolve(list);
      case 'tools.run':
        return Promise.resolve({ outcomes: [{ args: ['vm', 'stop'], output: 'stopped\n', error: '', exitCode: 0 }] });
      case 'library.list':
        return Promise.resolve({ queries: [] });
      case 'query.run': {
        const p = params as { tabId: string; refresh: boolean };
        queries.push({ tabId: p.tabId, refresh: p.refresh });
        return Promise.resolve(vms);
      }
      default:
        return Promise.resolve(null);
    }
  });
});

afterEach(() => {
  useWorkbooks.getState().unload('t');
});

describe('tool buttons on a table widget', () => {
  it('counts every row until rows are ticked, then the ticked ones', () => {
    show([button()]);
    expect(within(frame()).getByRole('button', { name: 'Stop VM · all 3' })).toBeTruthy();
    expect(within(frame()).queryByText(/selected$/)).toBeNull();
    tick(2);
    tick(3);
    expect(within(frame()).getByText('2 of 3 selected')).toBeTruthy();
    expect(within(frame()).getByRole('button', { name: 'Stop VM · 2' })).toBeTruthy();
  });

  it('opens the run on the selected rows, and runs only on Run', async () => {
    show([button()]);
    tick(2);
    tick(3);
    fireEvent.click(within(frame()).getByRole('button', { name: 'Stop VM · 2' }));
    const dialog = await screen.findByRole('dialog', { name: 'Stop VM on 2 selected rows' });
    expect(within(dialog).getByText('/usr/bin/az vm stop --ids vm-2')).toBeTruthy();
    expect(call.mock.calls.some(([m]) => m === 'tools.run')).toBe(false);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Run' }));
    await within(dialog).findByLabelText('Output');
    const sent = call.mock.calls.find(([m]) => m === 'tools.run')?.[1] as { rows: unknown[][]; mapping: Record<string, string> };
    expect(sent.rows).toEqual([
      ['db', 'vm-2'],
      ['cache', 'vm-3'],
    ]);
    expect(sent.mapping).toEqual({ id: 'id' });
  });

  it('names a button with a blank label by its tool', () => {
    show([button({ label: '  ' })]);
    expect(within(frame()).getByRole('button', { name: 'Stop VM · all 3' })).toBeTruthy();
  });

  it('ignores the stored selection once the widget turns selection off', () => {
    show([button()]);
    tick(2);
    tick(3);
    const s = useWorkbooks.getState().byTab['t']!;
    act(() => useWorkbooks.setState({ byTab: { t: { ...s, doc: { ...s.doc, widgets: s.doc.widgets.map((w) => ({ ...w, selection: 'none' as const })) } } } }));
    expect(within(frame()).queryByText(/selected$/)).toBeNull();
    expect(within(frame()).getByRole('button', { name: 'Stop VM · all 3' })).toBeTruthy();
  });

  it('is off when it runs on the selected rows and none are', () => {
    show([button({ runsOn: 'selected' })]);
    expect(within(frame()).getByRole('button', { name: 'Stop VM · 0' })).toHaveProperty('disabled', true);
  });

  it('runs a batch tool once with every row on stdin', async () => {
    show([button({ label: 'Dump', tool: 'Dump', mapping: {} })]);
    fireEvent.click(within(frame()).getByRole('button', { name: 'Dump · all 3' }));
    const dialog = await screen.findByRole('dialog', { name: 'Dump on all 3 rows' });
    expect(within(dialog).getByText('Runs once, with 3 rows on stdin as JSON:')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Run' }));
    await within(dialog).findByLabelText('Output');
    const sent = call.mock.calls.find(([m]) => m === 'tools.run')?.[1] as { rows: unknown[][] };
    expect(sent.rows).toHaveLength(3);
  });

  it('puts a menu button in ⋯, not the header', () => {
    show([button({ placement: 'menu' })]);
    expect(within(frame()).queryByRole('button', { name: 'Stop VM · all 3' })).toBeNull();
    fireEvent.click(within(frame()).getByRole('button', { name: 'VMs menu' }));
    expect(screen.getByRole('menuitem', { name: 'Stop VM · all 3' })).toBeTruthy();
  });

  it('says so when tools.json has no tool by that name, and opens no dialog (Review Focus 1)', async () => {
    list = { ...list, tools: [dump] };
    show([button()]);
    fireEvent.click(within(frame()).getByRole('button', { name: 'Stop VM · all 3' }));
    expect((await within(frame()).findByRole('alert')).textContent).toContain("There's no tool named Stop VM in your tools.json.");
    expect(within(frame()).getByRole('button', { name: 'Edit tools…' })).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows what is wrong with tools.json', async () => {
    list = { ...list, tools: [], problem: 'tools.json line 3: expected a comma' };
    show([button()]);
    fireEvent.click(within(frame()).getByRole('button', { name: 'Stop VM · all 3' }));
    expect((await within(frame()).findByRole('alert')).textContent).toContain('tools.json line 3: expected a comma');
    fireEvent.click(within(frame()).getByRole('button', { name: 'Edit tools…' }));
    expect(call).toHaveBeenCalledWith('tools.edit');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('refreshes the widget once after the run, and keeps the dialog open until Close (Review Focus 5)', async () => {
    show([button()]);
    fireEvent.click(within(frame()).getByRole('button', { name: 'Stop VM · all 3' }));
    const dialog = await screen.findByRole('dialog', { name: 'Stop VM on all 3 rows' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Run' }));
    await within(dialog).findByLabelText('Output');
    await waitFor(() => expect(queries).toEqual([{ tabId: 't/tb', refresh: true }]));
    await waitFor(() => expect(useWorkbooks.getState().byTab.t?.runs.tb?.state).toBe('done'));
    expect(screen.getByRole('dialog', { name: 'Stop VM on all 3 rows' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(queries).toHaveLength(1);
  });

  it('Cancel runs nothing and refreshes nothing', async () => {
    show([button()]);
    fireEvent.click(within(frame()).getByRole('button', { name: 'Stop VM · all 3' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(queries).toEqual([]);
  });

  it('refreshes every data widget after a run when it says to', async () => {
    show([button({ after: 'refreshWorkbook' })], [table('tb2', 'More VMs', [])]);
    fireEvent.click(within(frame()).getByRole('button', { name: 'Stop VM · all 3' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(queries.map((q) => q.tabId).sort()).toEqual(['t/tb', 't/tb2']));
    expect(queries.every((q) => q.refresh)).toBe(true);
  });
});
