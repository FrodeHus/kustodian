import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Widget, WorkbookDoc, WorkbookParameter } from './model';
import { newWidget, newWorkbook } from './model';
import { ParametersDialog } from './parameters-dialog';
import { useWorkbooks } from './workbook-store';

vi.mock('../bridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../bridge')>()),
  call: vi.fn(() => new Promise(() => undefined)),
  on: () => () => undefined,
}));

const param = (name: string, extra: Partial<WorkbookParameter> = {}): WorkbookParameter => ({
  name,
  type: 'text',
  value: '',
  required: false,
  choices: null,
  label: null,
  multi: false,
  all: false,
  remember: false,
  huntingTimespan: false,
  ...extra,
});

function widget(id: string, title: string, text: string, extra: Partial<Widget> = {}): Widget {
  const w = newWidget('table', { x: 0, y: 0, w: 4, h: 12 });
  return { ...w, id, title, query: { ...w.query!, text }, ...extra };
}

let doc: WorkbookDoc;
const runAll = vi.fn(() => Promise.resolve());
const onClose = vi.fn();

function open() {
  useWorkbooks.setState({
    byTab: {
      t: {
        doc,
        values: { workbook: {}, widgets: {} },
        runs: {},
        editing: true,
        undo: [],
        redo: [],
        dirty: false,
        selections: {},
        history: {},
        since: {},
        activeTabs: {},
        choices: {},
        stale: {},
      },
    },
    runAll,
  });
  render(<ParametersDialog tabId="t" onClose={onClose} />);
}

const state = () => useWorkbooks.getState().byTab.t!;
const names = () =>
  within(screen.getByRole('list', { name: 'Parameters' }))
    .getAllByRole('button')
    .map((b) => b.querySelector('.mono')?.textContent);
const item = (name: string) =>
  within(screen.getByRole('list', { name: 'Parameters' })).getByRole('button', { name: new RegExp(`^${name}`) });
const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const save = () => fireEvent.click(screen.getByRole('button', { name: 'Save' }));

beforeEach(() => {
  runAll.mockClear();
  onClose.mockReset();
  doc = {
    ...newWorkbook('Review'),
    parameters: [
      param('Window', { type: 'timespan', value: '7d', huntingTimespan: true }),
      param('Top', { type: 'number', value: '10' }),
      param('Unused'),
    ],
    widgets: [
      widget('a', 'Sign-ins', 'signIns | take {Top}'),
      widget('b', 'Hunt', 'DeviceEvents | where Timestamp > ago({Window})'),
      widget('c', 'Own top', 'signIns | take {Top}', { parameters: { Top: { from: 'fixed', value: '5' } } }),
    ],
  };
});

describe('ParametersDialog', () => {
  it('marking a new timespan as the hunting timespan clears the mark on another', () => {
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Add parameter' }));
    type('Name', 'TimeRange');
    type('Type', 'timespan');
    fireEvent.click(screen.getByLabelText('Use as the Defender hunting timespan'));
    save();

    const ps = state().doc.parameters;
    expect(ps.find((p) => p.name === 'TimeRange')?.huntingTimespan).toBe(true);
    expect(ps.find((p) => p.name === 'Window')?.huntingTimespan).toBe(false);
    expect(onClose).toHaveBeenCalled();
    expect(runAll).toHaveBeenCalledWith('t');
  });

  it('a duplicate or invalid name cannot be saved and says why', () => {
    open();
    fireEvent.click(item('Top'));
    type('Name', 'Window');
    expect(screen.getByText('Another parameter is already named Window.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);

    type('Name', '1 bad');
    expect(screen.getByText('Use letters, digits and _, not starting with a digit.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('Alt+Down moves the parameter down', () => {
    open();
    fireEvent.keyDown(item('Window'), { key: 'ArrowDown', altKey: true });
    expect(names()).toEqual(['Top', 'Window', 'Unused']);
    save();
    expect(state().doc.parameters.map((p) => p.name)).toEqual(['Top', 'Window', 'Unused']);
  });

  it('lists the widgets that take the parameter from the workbook under Used by', () => {
    open();
    fireEvent.click(item('Top'));
    const used = screen.getByRole('list', { name: 'Used by' });
    expect(
      within(used)
        .getAllByRole('listitem')
        .map((l) => l.textContent),
    ).toEqual(['Sign-ins']);
    expect(item('Top').textContent).toContain('1 widget');
  });

  it('flags a parameter no widget uses as Not used', () => {
    open();
    expect(item('Unused').textContent).toContain('Not used');
    fireEvent.click(item('Unused'));
    expect(screen.getByText('Not used')).toBeTruthy();
  });

  it('renaming renames the widgets’ own entries and leaves query text alone', () => {
    open();
    fireEvent.click(item('Top'));
    type('Name', 'Limit');
    save();

    expect(state().doc.widgets.find((w) => w.id === 'c')?.parameters).toEqual({ Limit: { from: 'fixed', value: '5' } });
    expect(state().doc.widgets.find((w) => w.id === 'a')?.query?.text).toBe('signIns | take {Top}');
    expect(state().undo).toHaveLength(1);
  });

  it('Save without a change writes nothing and reruns nothing', () => {
    open();
    save();
    expect(state().undo).toHaveLength(0);
    expect(runAll).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('Cancel writes nothing', () => {
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Add parameter' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(state().doc.parameters).toHaveLength(3);
    expect(onClose).toHaveBeenCalled();
  });

  const fromQuery = () => {
    fireEvent.click(item('Top'));
    type('Choices', 'query');
  };

  it('Choices: From a query shows source, KQL and a workspace picker for hunting; saving writes choicesQuery and null choices', () => {
    open();
    fromQuery();
    expect((screen.getByLabelText('Source') as HTMLSelectElement).value).toBe('hunting');
    expect(screen.getByRole('button', { name: /workspace|primary/i })).toBeTruthy();
    type('KQL', 'Users | project Name');
    type('Source', 'graph');
    expect(screen.queryByRole('button', { name: /workspace|primary/i })).toBeNull();
    type('Source', 'arg');
    type('KQL', 'Resources | project name');
    save();
    const top = state().doc.parameters.find((p) => p.name === 'Top')!;
    expect(top.choices).toBeNull();
    expect(top.choicesQuery).toEqual({ source: 'arg', text: 'Resources | project name', options: null });
  });

  it('switching to None or Fixed list drops the query', () => {
    open();
    fromQuery();
    type('KQL', 'x');
    type('Choices', 'fixed');
    save();
    const top = state().doc.parameters.find((p) => p.name === 'Top')!;
    expect('choicesQuery' in top).toBe(false);
    expect(top.choices).toBeNull();
  });

  it('Several values and Offer All show for a list with a query', () => {
    open();
    fireEvent.click(item('Top'));
    type('Type', 'list');
    type('Choices', 'query');
    type('KQL', 'x');
    fireEvent.click(screen.getByLabelText('Several values'));
    fireEvent.click(screen.getByLabelText('Offer “All”'));
    save();
    const top = state().doc.parameters.find((p) => p.name === 'Top')!;
    expect(top.multi).toBe(true);
    expect(top.all).toBe(true);
  });

  it("a query using its own parameter says A parameter's choices can't use itself. and Save is off", () => {
    open();
    fromQuery();
    type('KQL', 'T | take {Top}');
    expect(screen.getByRole('alert').textContent).toBe("A parameter's choices can't use itself.");
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('Preview shows the first choices, or the error', async () => {
    const runDraft = vi.fn();
    useWorkbooks.setState({ runDraft });
    open();
    fromQuery();
    type('KQL', 'x');
    runDraft.mockResolvedValueOnce({
      outcome: 'ok',
      columns: [{ name: 'a', type: 'string' }],
      rows: Array.from({ length: 12 }, (_, i) => [`v${i}`]),
    });
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(await screen.findByText('v0')).toBeTruthy();
    expect(screen.getByText('v9')).toBeTruthy();
    expect(screen.queryByText('v10')).toBeNull();
    expect(screen.getByText('and 2 more')).toBeTruthy();
    runDraft.mockRejectedValueOnce(new Error('Boom'));
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect((await screen.findByText('Boom')).getAttribute('role')).toBe('alert');
  });

  it('Preview shows a failed run message and says when there are no choices', async () => {
    const runDraft = vi.fn();
    useWorkbooks.setState({ runDraft });
    open();
    fromQuery();
    type('KQL', 'x');
    runDraft.mockResolvedValueOnce({ outcome: 'failed', message: 'Bad KQL', columns: [], rows: [] });
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect((await screen.findByText('Bad KQL')).getAttribute('role')).toBe('alert');
    runDraft.mockResolvedValueOnce({ outcome: 'ok', columns: [{ name: 'a', type: 'string' }], rows: [] });
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(await screen.findByText('The query returned no choices.')).toBeTruthy();
  });

  it('drops a Preview answer that arrives after the text changed, and ignores an AbortError', async () => {
    const runDraft = vi.fn();
    useWorkbooks.setState({ runDraft });
    open();
    fromQuery();
    type('KQL', 'x');
    let answer!: (r: unknown) => void;
    runDraft.mockReturnValueOnce(new Promise((r) => (answer = r)));
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    type('KQL', 'xy');
    await act(async () => answer({ outcome: 'ok', columns: [{ name: 'a', type: 'string' }], rows: [['late']] }));
    expect(screen.queryByText('late')).toBeNull();
    runDraft.mockRejectedValueOnce(new DOMException('A newer preview replaced this one.', 'AbortError'));
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await act(async () => undefined);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('Type offers workspace', () => {
    open();
    const opts = within(screen.getByLabelText('Type'))
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(opts).toContain('workspace');
  });

  it('a second workspace parameter says so and Save is off', () => {
    doc = { ...doc, parameters: [param('Ws', { type: 'workspace' }), param('Other')] };
    open();
    fireEvent.click(item('Other'));
    type('Type', 'workspace');
    expect(screen.getByRole('alert').textContent).toBe('A workbook can have only one workspace parameter.');
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
    type('Type', 'text');
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('a workspace parameter hides Choices, Several values and Offer All; its Default is a picker', () => {
    doc = { ...doc, parameters: [param('Ws', { type: 'workspace', multi: true, all: true })] };
    open();
    expect(screen.queryByLabelText('Choices')).toBeNull();
    expect(screen.queryByLabelText('Several values')).toBeNull();
    expect(screen.queryByLabelText('Offer “All”')).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'Default' })).toBeNull();
    expect(screen.getByRole('button', { name: /^Workspace: / })).toBeTruthy();
  });
});
