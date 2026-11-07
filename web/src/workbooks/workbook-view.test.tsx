import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTabs } from '../tabs/tab-store';
import type { RunResult } from '../wire';
import type { Widget, WidgetType, WorkbookDoc, WorkbookParameter } from './model';
import { newWidget, newWorkbook, parseWorkbook } from './model';
import type { WidgetRun, WorkbookState } from './workbook-store';
import { useWorkbooks } from './workbook-store';
import { WorkbookView } from './workbook-view';

// By glob: the test runner hands a plain `?raw` import of a stylesheet back empty.
const styles = Object.values(import.meta.glob<string>('../styles.css', { query: '?raw', import: 'default', eager: true }))[0] ?? '';

const call = vi.hoisted(() => vi.fn());
vi.mock('../bridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../bridge')>()),
  call,
  on: () => () => undefined,
}));

// Recharts can't lay out in jsdom; the chart's own tests cover it.
vi.mock('../results/chart-view', () => ({
  default: ({ picked, controls = true }: { picked: { type?: string }; controls?: boolean }) => (
    <p>
      Chart {picked.type ?? 'auto'}, {controls ? 'with pickers' : 'alone'}
    </p>
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
const setWidgetValue = vi.fn();

function show(runs: Record<string, WidgetRun>, editing = false) {
  const state: WorkbookState = {
    doc,
    values: { workbook: { Env: 'prod', Days: '7' }, widgets: {} },
    runs,
    editing,
    undo: [],
    redo: [],
    dirty: false,
    selections: {}, history: {}, since: {}, activeTabs: {}, stale: {},
  };
  useWorkbooks.setState({ byTab: { t: state }, setWorkbookValue, setWidgetValue });
  return render(<WorkbookView tabId="t" />);
}

const frame = (title: string) => screen.getByRole('region', { name: title });

beforeEach(() => {
  setWorkbookValue.mockReset();
  setWidgetValue.mockReset();
  call.mockReset();
  useTabs.setState({ tabs: [], activeId: null });
  doc = {
    ...newWorkbook('Sign-in review'),
    folder: 'Security',
    parameters: [env, { ...env, name: 'Days', type: 'number', value: '7', choices: null, label: null }],
    widgets: [
      widget('m', 'markdown', 'Notes', undefined, { markdown: '# Read me' }),
      widget('c', 'chart', 'Sign-ins by day', 'SignIns | where Env == {Env}'),
      widget('tb', 'table', 'Users', 'Users | take {Top}', { parameters: { Top: { from: 'widget', value: '5' } } }),
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

  it('Print marks this workbook for the print styles, and prints in the page unless the host printed it', async () => {
    const print = vi.spyOn(window, 'print').mockImplementation(() => undefined);
    call.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const { container } = show({});
    const open = () => {
      fireEvent.click(screen.getByRole('button', { name: 'Workbook menu' }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Print or save as PDF…' }));
    };
    open();
    await vi.waitFor(() => expect(print).toHaveBeenCalledTimes(1));
    expect(call).toHaveBeenCalledWith('app.print');
    expect(container.querySelectorAll('.wb-printing')).toHaveLength(1);
    open();
    await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(2));
    await Promise.resolve();
    expect(print).toHaveBeenCalledTimes(1);
    expect(styles).toContain('.wb-printing');
    print.mockRestore();
  });

  it('offers a text parameter with choices as a select, and fills Markdown with a parameter added since opening', () => {
    // Region isn't in the view values (it was added after the workbook opened): its default stands in.
    doc.parameters = [...doc.parameters, { ...env, name: 'Region', type: 'text', value: 'eu', choices: ['eu', 'us'], label: null }];
    doc.widgets = [widget('m', 'markdown', 'Notes', undefined, { markdown: 'Region {Region}' })];
    show({});
    expect(screen.getByRole('combobox', { name: 'Region' })).toBeTruthy();
    expect(within(frame('Notes')).getByText('Region eu')).toBeTruthy();
  });

  it('Full screen fixes the widget to the window, and the stylesheet frees it from the boxes that would hold it', () => {
    show({});
    fireEvent.click(within(frame('Notes')).getByRole('button', { name: 'Notes menu' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Full screen' }));
    const notes = frame('Notes');
    expect(notes.classList.contains('wb-full')).toBe(true);
    expect(notes.classList.contains('fixed')).toBe(true);
    // `relative` would win over `fixed` and keep it in its grid cell.
    expect(notes.classList.contains('relative')).toBe(false);
    // A container query container, or the glass workspace's backdrop filter, would be the box `fixed` resolves against.
    expect(styles).toContain('.wb-canvas:has(.wb-full) { container-type: normal; }');
    expect(styles).toContain('.theme-glass .workspace:has(.wb-full) { backdrop-filter: none; }');
  });

  it('Full screen on a widget inside a tab: the tabs widget around it neither holds it nor covers it', () => {
    doc.widgets = [
      { ...widget('tw', 'tabs', ''), tabs: [{ id: 't1', name: 'One' }] },
      widget('in', 'markdown', 'Inside', undefined, { markdown: 'x', in: { tabs: 'tw', tab: 't1' } }),
    ];
    show({});
    fireEvent.click(within(frame('Inside')).getByRole('button', { name: 'Inside menu' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Full screen' }));
    expect(frame('Inside').classList.contains('wb-full')).toBe(true);
    // The glass themes' .card backdrop filter would make the outer tabs widget the box `fixed` resolves against.
    expect(styles).toContain('.theme-glass .wb-widget:has(.wb-full) { backdrop-filter: none; }');
    expect(styles).toContain('.wb-widget:has(.wb-full) { z-index: 20; }');
  });

  it('in the glass themes, nothing in the widget editor has a backdrop filter, which would misplace Monaco’s suggest and hover', () => {
    expect(styles).toContain('.theme-glass .wb-editor, .theme-glass .wb-editor .card { backdrop-filter: none;');
  });

  it('says on the parameter itself when the hunting timespan can’t be sent', () => {
    doc.parameters = [{ ...env, name: 'Range', type: 'timespan', value: '90d', choices: null, label: null, huntingTimespan: true }];
    doc.widgets = [];
    show({});
    expect(screen.getByRole('alert').textContent).toBe('Range: at most 30 days for Defender hunting.');
  });

  it('shows a damaged workbook, as parsed, without failing', () => {
    const parsed = parseWorkbook({
      ...doc,
      parameters: [{ name: 'Env', type: 'list', value: 7, required: true, choices: 'x' }],
      widgets: [
        { id: 'm', type: 'markdown', title: 'Notes', markdown: 5, layout: { x: 0, y: 0, w: 4, h: 4 } },
        {
          id: 'm',
          type: 'stat',
          title: 'Total',
          layout: { x: 4, y: 0, w: 4, h: 8 },
          parameters: { Top: { from: 'bogus', value: 1 } },
          query: { source: 'graph', text: 'Users | take {Top} {Q}', parameters: [{ name: 'Q', type: 'text', value: 7, required: true }] },
          stat: 'value',
        },
      ],
    });
    if (typeof parsed === 'string') {
      throw new Error(parsed);
    }
    doc = parsed;
    show({});
    expect(frame('Notes')).toBeTruthy();
    expect(frame('Total')).toBeTruthy();
  });

  it('sets a workbook value from the bar', () => {
    show({});
    fireEvent.change(screen.getByRole('combobox', { name: 'Environment' }), { target: { value: 'test' } });
    expect(setWorkbookValue).toHaveBeenCalledWith('t', 'Env', 'test', { now: true });
  });

  it('a typed value waits for typing to stop, Enter sends it at once', () => {
    show({});
    const days = screen.getByRole('textbox', { name: 'Days' });
    fireEvent.change(days, { target: { value: '14' } });
    expect(setWorkbookValue).toHaveBeenLastCalledWith('t', 'Days', '14', { now: false });
    fireEvent.keyDown(days, { key: 'Enter' });
    expect(setWorkbookValue).toHaveBeenLastCalledWith('t', 'Days', '7', { now: true });

    const top = within(frame('Users')).getByRole('textbox', { name: 'Top' });
    fireEvent.change(top, { target: { value: '10' } });
    expect(setWidgetValue).toHaveBeenLastCalledWith('t', 'tb', 'Top', '10', { now: false });
    fireEvent.keyDown(top, { key: 'Enter' });
    expect(setWidgetValue).toHaveBeenLastCalledWith('t', 'tb', 'Top', '5', { now: true });
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

  it('a stat with a null or empty cell has no number, and a null comparison no change line', () => {
    const columns = [
      { name: 'value', type: 'long' },
      { name: 'previous', type: 'long' },
    ];
    for (const cell of [null, '', 'n/a']) {
      const { unmount } = show({ s: { state: 'done', result: result(columns, [[cell, 5]]) } });
      expect(within(frame('Total')).getByText('No number to show.')).toBeTruthy();
      unmount();
    }
    show({ s: { state: 'done', result: result(columns, [[7, null]]) } });
    expect(within(frame('Total')).getByText('7')).toBeTruthy();
    expect(within(frame('Total')).queryByText(/▲|▼/)).toBeNull();
  });

  it('draws a chart widget alone, as its own settings say, in view mode, edit mode and full screen', async () => {
    doc.widgets = doc.widgets.map((w) => (w.id === 'c' ? { ...w, chart: { type: 'bar' } } : w));
    const shown = { c: { state: 'done', result: result([{ name: 'n', type: 'long' }], [[1]]) } } as const;
    const view = show(shown);
    expect(await within(frame('Sign-ins by day')).findByText('Chart bar, alone')).toBeTruthy();
    fireEvent.click(within(frame('Sign-ins by day')).getByRole('button', { name: 'Sign-ins by day menu' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Full screen' }));
    expect(within(frame('Sign-ins by day')).getByText('Chart bar, alone')).toBeTruthy();
    view.unmount();
    show(shown, true);
    expect(await within(frame('Sign-ins by day')).findByText('Chart bar, alone')).toBeTruthy();
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

  it('narrow: the tab’s grid stacks full width like the top level', () => {
    doc.widgets = [
      { ...widget('tw', 'tabs', ''), tabs: [{ id: 't1', name: 'One' }] },
      widget('in', 'markdown', 'Inside', undefined, { markdown: 'x', in: { tabs: 'tw', tab: 't1' } }),
    ];
    show({});
    const inner = document.querySelector('[data-wb-place="tw/t1"]')!;
    expect(inner.classList.contains('wb-grid')).toBe(true);
    expect(document.querySelector('[data-wb-place=""]')?.classList.contains('wb-grid')).toBe(true);
    expect(within(inner as HTMLElement).getByRole('region', { name: 'Inside' }).classList.contains('wb-widget')).toBe(true);
    // The container rule is on .wb-widget wherever it sits, under the one .wb-canvas container.
    expect(styles).toMatch(/@container \(max-width: 899px\) \{ \.wb-widget \{ grid-column: 1 \/ -1;/);
  });
});
