import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTabs } from '../tabs/tab-store';
import type { RunResult } from '../wire';
import type { Widget, WidgetType, WorkbookDoc, WorkbookParameter } from './model';
import { newWidget, newWorkbook } from './model';
import type { WidgetRun, WorkbookState } from './workbook-store';
import { useWorkbooks } from './workbook-store';
import { WorkbookView } from './workbook-view';

const call = vi.hoisted(() => vi.fn());
vi.mock('../bridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../bridge')>()),
  call,
  on: () => () => undefined,
}));

// Recharts can't lay out in jsdom; the chart's own tests cover it.
vi.mock('../results/chart-view', () => ({
  default: ({ picked, setPicked }: { picked: { type?: string }; setPicked: (p: { type?: string }) => void }) => (
    <button type="button" onClick={() => setPicked({ type: 'pie' })}>
      Chart type: {picked.type ?? 'auto'}
    </button>
  ),
}));

const result = (columns: RunResult['columns'], rows: unknown[][]): RunResult => ({
  outcome: 'ok',
  message: null,
  error: null,
  columns,
  rows,
  total: rows.length,
  tables: [],
  durationMs: 120,
  droppedValues: 0,
  runId: 'r',
  diagnostics: [],
  permissions: [],
});

const env: WorkbookParameter = {
  name: 'Env',
  type: 'list',
  value: 'prod',
  required: false,
  choices: ['prod', 'test'],
  label: 'Environment',
  multi: false,
  all: false,
  remember: false,
  huntingTimespan: false,
};

function widget(id: string, type: WidgetType, title: string, text = 'Users | take 5', extra: Partial<Widget> = {}): Widget {
  const w = newWidget(type, { x: 0, y: 0, w: 4, h: 12 });
  return { ...w, id, title, ...(w.query ? { query: { ...w.query, text } } : {}), ...extra };
}

let doc: WorkbookDoc;
const setWorkbookValue = vi.fn();

function show(runs: Record<string, WidgetRun>, editing = false) {
  const state: WorkbookState = {
    doc,
    values: { workbook: { Env: 'prod' }, widgets: {} },
    runs,
    editing,
    undo: [],
    redo: [],
    dirty: false,
    viewCharts: {},
  };
  useWorkbooks.setState({ byTab: { t: state }, setWorkbookValue });
  return render(<WorkbookView tabId="t" />);
}

const frame = (title: string) => screen.getByRole('region', { name: title });

beforeEach(() => {
  setWorkbookValue.mockReset();
  call.mockReset();
  useTabs.setState({ tabs: [], activeId: null });
  doc = {
    ...newWorkbook('Sign-in review'),
    folder: 'Security',
    parameters: [env],
    widgets: [
      widget('m', 'markdown', 'Notes', undefined, { markdown: '# Read me' }),
      widget('c', 'chart', 'Sign-ins by day', 'SignIns | where Env == {Env}'),
      widget('tb', 'table', 'Users'),
      widget('s', 'stat', 'Total', 'Users | count', { stat: { value: 'value', compare: 'previous' } }),
    ],
  };
});

describe('WorkbookView', () => {
  it('shows each widget by its title, and the parameter bar', () => {
    show({});
    expect(screen.getByRole('heading', { name: 'Sign-in review' })).toBeTruthy();
    for (const title of ['Notes', 'Sign-ins by day', 'Users', 'Total']) {
      expect(frame(title)).toBeTruthy();
    }
    expect(screen.getByRole('combobox', { name: 'Environment' })).toBeTruthy();
    // The chart widget names the workbook parameter it uses.
    expect(within(frame('Sign-ins by day')).getByText('Env')).toBeTruthy();
  });

  it('sets a workbook value from the bar', () => {
    show({});
    fireEvent.change(screen.getByRole('combobox', { name: 'Environment' }), { target: { value: 'test' } });
    expect(setWorkbookValue).toHaveBeenCalledWith('t', 'Env', 'test', { now: true });
  });

  it('says why a blocked widget did not run', () => {
    show({ tb: { state: 'blocked', reason: 'Needs a value before the widget runs.' } });
    expect(within(frame('Users')).getByText('Needs a value before the widget runs.')).toBeTruthy();
  });

  it('offers to copy the last text into a widget whose saved query is gone', () => {
    const copySavedIntoWidget = vi.fn();
    useWorkbooks.setState({ copySavedIntoWidget });
    show({ tb: { state: 'gone' } });
    const users = frame('Users');
    expect(within(users).getByText('This saved query is gone.')).toBeTruthy();
    fireEvent.click(within(users).getByRole('button', { name: 'Copy the last text into the widget' }));
    expect(copySavedIntoWidget).toHaveBeenCalledWith('t', 'tb');
  });

  it('shows a stat with its change against the comparison', () => {
    const columns = [
      { name: 'value', type: 'long' },
      { name: 'previous', type: 'long' },
    ];
    show({ s: { state: 'done', result: result(columns, [[1284, 1088]]) } });
    const total = frame('Total');
    expect(within(total).getByText('1,284')).toBeTruthy();
    expect(within(total).getByText('▲ 196 (18%)')).toBeTruthy();
  });

  it('keeps a chart pick made in view mode as view state', async () => {
    const setViewChart = vi.fn();
    const edit = vi.fn();
    useWorkbooks.setState({ setViewChart, edit });
    show({ c: { state: 'done', result: result([{ name: 'n', type: 'long' }], [[1]]) } });
    fireEvent.click(await within(frame('Sign-ins by day')).findByRole('button', { name: 'Chart type: auto' }));
    expect(setViewChart).toHaveBeenCalledWith('t', 'c', { type: 'pie' });
    expect(edit).not.toHaveBeenCalled();
  });

  it('opens a widget in a query tab with the current values as its parameters', () => {
    show({});
    const chart = frame('Sign-ins by day');
    fireEvent.click(within(chart).getByRole('button', { name: 'Sign-ins by day menu' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open in query tab' }));
    const opened = useTabs.getState().tabs.at(-1);
    expect(opened?.text).toBe('SignIns | where Env == {Env}');
    expect(opened?.source).toBe('graph');
    expect(opened?.parameters).toEqual([{ name: 'Env', type: 'list', value: 'prod', required: false, choices: ['prod', 'test'] }]);
  });
});
