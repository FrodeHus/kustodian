import { fireEvent, render, screen, within } from '@testing-library/react';
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
    byTab: { t: { doc, values: { workbook: {}, widgets: {} }, runs: {}, editing: true, undo: [], redo: [], dirty: false, selections: {}, history: {}, since: {}, activeTabs: {}, stale: {} } },
    runAll,
  });
  render(<ParametersDialog tabId="t" onClose={onClose} />);
}

const state = () => useWorkbooks.getState().byTab.t!;
const names = () => within(screen.getByRole('list', { name: 'Parameters' })).getAllByRole('button').map((b) => b.querySelector('.mono')?.textContent);
const item = (name: string) => within(screen.getByRole('list', { name: 'Parameters' })).getByRole('button', { name: new RegExp(`^${name}`) });
const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const save = () => fireEvent.click(screen.getByRole('button', { name: 'Save' }));

beforeEach(() => {
  runAll.mockClear();
  onClose.mockReset();
  doc = {
    ...newWorkbook('Review'),
    parameters: [param('Window', { type: 'timespan', value: '7d', huntingTimespan: true }), param('Top', { type: 'number', value: '10' }), param('Unused')],
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
    expect(within(used).getAllByRole('listitem').map((l) => l.textContent)).toEqual(['Sign-ins']);
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
});
