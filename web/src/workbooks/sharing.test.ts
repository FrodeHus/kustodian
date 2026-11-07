import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SavedQuery } from '../wire';
import { newWidget, newWorkbook, parseWorkbook } from './model';
import type { WorkbookDoc } from './model';
import { exportFileName, exportWorkbook, WORKBOOK_FILTERS } from './sharing';
import { useWorkbooks } from './workbook-store';

const bridge = vi.hoisted(() => ({ call: vi.fn() }));

vi.mock('../bridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../bridge')>()),
  call: bridge.call,
}));

const linked: SavedQuery = {
  version: 1,
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Fresh name',
  folder: null,
  source: 'graph',
  text: 'fresh text',
  parameters: [],
  createdAt: '',
  modifiedAt: '',
  options: null,
};

let doc: WorkbookDoc;
let answer: unknown;

beforeEach(() => {
  const w = newWidget('table', { x: 0, y: 0, w: 3, h: 8 });
  doc = {
    ...newWorkbook('Hygiene'),
    parameters: [{ name: 'Who', type: 'text', value: 'default', required: false, choices: null, label: null, multi: false, all: false, remember: true, huntingTimespan: false }],
    widgets: [{ ...w, query: { ...w.query!, text: 'stale text', saved: { id: linked.id, name: 'Old' } } }],
  };
  answer = { path: '/x/h.json', name: 'h.json' };
  bridge.call.mockReset();
  bridge.call.mockImplementation((method: string) => {
    switch (method) {
      case 'library.list':
        return Promise.resolve({ queries: [linked], folders: [], skipped: 0 });
      case 'workbook.values.get':
        return Promise.resolve({ values: {} });
      case 'workbook.values.save':
        return Promise.resolve(null);
      case 'file.saveAs':
        return Promise.resolve(answer);
      default:
        return Promise.reject(new Error(method));
    }
  });
  useWorkbooks.setState({ byTab: {} });
});

afterEach(() => useWorkbooks.getState().unload('t'));

const open = async () => {
  await useWorkbooks.getState().load('t', doc, { dirty: true });
};
const saveAsCalls = () => bridge.call.mock.calls.filter((c) => c[0] === 'file.saveAs');

describe('exportFileName', () => {
  it('replaces characters a file name cannot hold', () => {
    expect(exportFileName('VM / hygiene: "prod"')).toBe('VM - hygiene- -prod-.kustodian-workbook.json');
  });
});

describe('exportWorkbook', () => {
  it('writes the unsaved document with linked copies refreshed, no modifiedAt, and leaves the tab dirty', async () => {
    await open();
    expect(await exportWorkbook('t')).toBe(true);

    expect(saveAsCalls()).toHaveLength(1);
    const params = saveAsCalls()[0]![1] as { suggestedName: string; filters: unknown; content: string; path?: string };
    expect(params.path).toBeUndefined();
    expect(params.suggestedName).toBe('Hygiene.kustodian-workbook.json');
    expect(params.filters).toEqual(WORKBOOK_FILTERS);
    expect(params.content.endsWith('\n')).toBe(true);
    const written = JSON.parse(params.content) as Record<string, unknown>;
    expect('modifiedAt' in written).toBe(false);
    const parsed = parseWorkbook(written);
    expect(typeof parsed).toBe('object');
    const { widgets, ...rest } = parsed as WorkbookDoc;
    const { modifiedAt: _m, widgets: _w, ...expected } = doc;
    expect(rest).toMatchObject(expected);
    expect(widgets[0]!.query!.text).toBe('fresh text');
    expect(widgets[0]!.query!.saved).toEqual({ id: linked.id, name: 'Fresh name' });
    expect(useWorkbooks.getState().byTab.t!.dirty).toBe(true);
  });

  it('leaves remembered values out; the parameter keeps its default', async () => {
    await open();
    useWorkbooks.getState().setWorkbookValue('t', 'Who', 'remembered-me');
    await exportWorkbook('t');
    const content = (saveAsCalls()[0]![1] as { content: string }).content;
    expect(content).not.toContain('remembered-me');
    expect((JSON.parse(content) as WorkbookDoc).parameters[0]!.value).toBe('default');
  });

  it('resolves false when the dialog is cancelled', async () => {
    answer = null;
    await open();
    expect(await exportWorkbook('t')).toBe(false);
  });
});
