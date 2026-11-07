import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExternalTool, RunResult, SavedQuery } from '../wire';
import type { ToolButton, Widget, WidgetType, WorkbookDoc, WorkbookParameter } from './model';
import { newWidget, newWorkbook } from './model';
import { WidgetEditor } from './widget-editor';
import { useWorkbooks } from './workbook-store';

const call = vi.hoisted(() => vi.fn());
vi.mock('../bridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../bridge')>()),
  call,
  on: () => () => undefined,
}));

// Monaco doesn't run in jsdom: a text box in its place, editing the draft the widget editor gives it.
vi.mock('../editor/kql-editor', () => ({
  default: ({ draft }: { draft: { text: string; onChange: (text: string) => void } }) => (
    <textarea aria-label="KQL query" value={draft.text} onChange={(e) => draft.onChange(e.target.value)} />
  ),
}));
// Recharts can't lay out in jsdom; the chart's own tests cover it.
vi.mock('../results/chart-view', () => ({
  default: ({ picked, controls = true }: { picked: { type?: string }; controls?: boolean }) => (
    <p>
      Chart {picked.type ?? 'auto'}, {controls ? 'with pickers' : 'alone'}
    </p>
  ),
}));

const risky: SavedQuery = {
  version: 1,
  id: 's1',
  name: 'Risky sign-ins',
  folder: null,
  source: 'graph',
  text: 'riskyUsers | take {Top}',
  parameters: [],
  createdAt: '2026-11-01T10:00:00Z',
  modifiedAt: '2026-11-02T10:00:00Z',
  options: null,
};

const timeRange: WorkbookParameter = {
  name: 'TimeRange',
  type: 'timespan',
  value: '7d',
  required: false,
  choices: null,
  label: null,
  multi: false,
  all: false,
  remember: false,
  huntingTimespan: false,
};

function widget(id: string, type: WidgetType, extra: Partial<Widget> = {}): Widget {
  const w = newWidget(type, { x: 0, y: 0, w: 4, h: 12 });
  return { ...w, id, title: 'Sign-ins', ...extra };
}

let doc: WorkbookDoc;
const runWidget = vi.fn(() => Promise.resolve());
const onClose = vi.fn();

const stopVm: ExternalTool = { name: 'Stop VM', command: 'az', args: ['vm', 'stop', '--ids', '{id}'], mode: 'each' };
const vms: RunResult = {
  outcome: 'ok',
  message: null,
  error: null,
  columns: [
    { name: 'name', type: 'string' },
    { name: 'id', type: 'string' },
  ],
  rows: [['vm1', '/subscriptions/s/vm1']],
  total: 1,
  tables: [],
  durationMs: 1,
  droppedValues: 0,
  runId: 'r',
  diagnostics: [],
  permissions: [],
};

function open(widgetId: string, lastResult?: RunResult) {
  const runs = lastResult ? { [widgetId]: { state: 'done' as const, result: lastResult, finishedAt: 1 } } : {};
  useWorkbooks.setState({
    byTab: { t: { doc, values: { workbook: { TimeRange: '1d' }, widgets: {} }, runs, editing: true, undo: [], redo: [], dirty: false, selections: {} } },
    runWidget,
  });
  render(<WidgetEditor tabId="t" widgetId={widgetId} onClose={onClose} />);
}

const state = () => useWorkbooks.getState().byTab.t!;
const applied = (id = 'a') => state().doc.widgets.find((w) => w.id === id)!;
const apply = () => fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
const tab = (name: string) => fireEvent.click(screen.getByRole('tab', { name }));

beforeEach(() => {
  call.mockReset();
  call.mockImplementation((method: string) =>
    method === 'library.list'
      ? Promise.resolve({ queries: [risky], folders: [], skipped: 0 })
      : method === 'tools.list'
        ? Promise.resolve({ tools: [stopVm], problem: null, path: '/tools.json', missing: [] })
        : new Promise(() => undefined),
  );
  runWidget.mockClear();
  onClose.mockReset();
  const a = widget('a', 'table');
  a.query = { ...a.query!, text: 'signIns | where createdDateTime > ago({TimeRange})' };
  doc = { ...newWorkbook('Review'), parameters: [timeRange], widgets: [a, widget('m', 'markdown', { title: 'Notes', markdown: '# Hello' })] };
});

describe('WidgetEditor', () => {
  it('choosing a saved query links it and offers Copy into widget', async () => {
    open('a');
    fireEvent.click(screen.getByRole('radio', { name: 'Use a saved query' }));
    const picker = screen.getByRole('combobox', { name: 'Saved query' });
    await screen.findByRole('option', { name: 'Risky sign-ins' });
    fireEvent.change(picker, { target: { value: 's1' } });

    expect(screen.getByRole('button', { name: 'Copy into widget' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open in tab' })).toBeTruthy();
    expect(screen.getByText(/^Linked: changes to the saved query show up here\. Saved /)).toBeTruthy();
    expect(screen.getByText('riskyUsers | take {Top}')).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: 'KQL query' })).toBeNull();

    apply();
    expect(applied().query).toMatchObject({ saved: { id: 's1', name: 'Risky sign-ins' }, text: 'riskyUsers | take {Top}' });
  });

  it('Copy into widget clears the link and keeps the text', async () => {
    const a = doc.widgets[0]!;
    doc.widgets[0] = { ...a, query: { ...a.query!, text: 'old copy', saved: { id: 's1', name: 'Risky sign-ins' } } };
    open('a');
    await screen.findByText('riskyUsers | take {Top}');
    fireEvent.click(screen.getByRole('button', { name: 'Copy into widget' }));

    expect(((await screen.findByRole('textbox', { name: 'KQL query' })) as HTMLTextAreaElement).value).toBe('riskyUsers | take {Top}');
    expect(screen.getByRole('radio', { name: 'Write a query here' })).toHaveProperty('checked', true);
    apply();
    expect(applied().query).toMatchObject({ saved: null, text: 'riskyUsers | take {Top}' });
  });

  it('a placeholder typed in the query appears in Parameters as Widget · shown; Workbook only for workbook parameters', async () => {
    open('a');
    const editor = await screen.findByRole('textbox', { name: 'KQL query' });
    fireEvent.change(editor, { target: { value: 'signIns | where createdDateTime > ago({TimeRange}) | take {Top}' } });
    tab('Parameters');

    const top = screen.getByRole('combobox', { name: 'Top: value comes from' }) as HTMLSelectElement;
    expect(top.value).toBe('widget');
    expect(within(top).queryByRole('option', { name: 'Workbook' })).toBeNull();
    expect(within(top).getByRole('option', { name: 'Widget · shown' })).toBeTruthy();
    const range = screen.getByRole('combobox', { name: 'TimeRange: value comes from' }) as HTMLSelectElement;
    expect(range.value).toBe('workbook');
    expect(screen.getByText('Workbook: follows the global value. Widget · shown: a control in the widget header. Fixed: a set value, no control.')).toBeTruthy();
  });

  it('Fixed and a value store {from: fixed, value}', () => {
    open('a');
    tab('Parameters');
    fireEvent.change(screen.getByRole('combobox', { name: 'TimeRange: value comes from' }), { target: { value: 'fixed' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'TimeRange: value' }), { target: { value: '30d' } });
    apply();
    expect(applied().parameters.TimeRange).toEqual({ from: 'fixed', value: '30d' });
  });

  it('Cancel leaves the doc unchanged', () => {
    open('a');
    fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(state().doc).toBe(doc);
    expect(state().undo).toEqual([]);
    expect(onClose).toHaveBeenCalled();
  });

  it('Apply is one undo step and reruns the widget', async () => {
    open('a');
    fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), { target: { value: 'Renamed' } });
    fireEvent.change(await screen.findByRole('textbox', { name: 'KQL query' }), { target: { value: 'users' } });
    apply();
    expect(applied()).toMatchObject({ title: 'Renamed', query: { text: 'users' } });
    expect(state().undo).toEqual([doc]);
    await vi.waitFor(() => expect(runWidget).toHaveBeenCalledWith('t', 'a'));
    expect(onClose).toHaveBeenCalled();
    useWorkbooks.getState().undoEdit('t');
    expect(state().doc).toBe(doc);
  });

  it('Run preview runs the draft through the store as the preview', async () => {
    open('a');
    fireEvent.change(await screen.findByRole('textbox', { name: 'KQL query' }), { target: { value: 'users | take {TimeRange}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run preview' }));
    await vi.waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        'query.run',
        expect.objectContaining({ tabId: 't/preview', kql: 'users | take {TimeRange}', parameters: [expect.objectContaining({ name: 'TimeRange', value: '1d' })] }),
        expect.anything(),
      ),
    );
  });

  it('a chart widget’s type buttons write widget.chart', () => {
    doc.widgets[0] = { ...doc.widgets[0]!, type: 'chart' };
    open('a');
    tab('Visualization');
    fireEvent.click(screen.getByRole('button', { name: 'Line' }));
    apply();
    expect(applied().chart).toMatchObject({ type: 'line' });
  });

  it('the preview draws the chart alone, as the Visualization tab sets it', async () => {
    const result = { outcome: 'ok', message: null, error: null, columns: [{ name: 'n', type: 'long' }], rows: [[1]], total: 1, tables: [], durationMs: 1, droppedValues: 0, runId: 'r', diagnostics: [], permissions: [] };
    call.mockImplementation((method: string) =>
      method === 'library.list' ? Promise.resolve({ queries: [], folders: [], skipped: 0 }) : method === 'query.run' ? Promise.resolve(result) : new Promise(() => undefined),
    );
    doc.widgets[0] = { ...doc.widgets[0]!, type: 'chart' };
    open('a');
    tab('Visualization');
    fireEvent.click(screen.getByRole('button', { name: 'Bar' }));
    fireEvent.click(screen.getByRole('button', { name: 'Run preview' }));
    expect(await screen.findByText('Chart bar, alone')).toBeTruthy();
  });

  it('a Markdown widget has a text area and a rendered preview, no tabs', () => {
    open('m');
    expect(screen.queryByRole('tab')).toBeNull();
    fireEvent.change(screen.getByRole('textbox', { name: 'Markdown' }), { target: { value: '## Range {TimeRange}' } });
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Range 1d');
    apply();
    expect(applied('m').markdown).toBe('## Range {TimeRange}');
  });

  describe('Tool buttons', () => {
    const button = (extra: Partial<ToolButton> = {}): ToolButton => ({
      label: 'Gone tool',
      tool: 'Gone tool',
      mapping: {},
      runsOn: 'selected',
      after: 'refreshWidget',
      placement: 'header',
      ...extra,
    });

    it('a table widget has a Tool buttons tab; a chart widget doesn’t', () => {
      open('a');
      expect(screen.getByRole('tab', { name: 'Tool buttons' })).toBeTruthy();
      cleanup();
      doc.widgets[0] = { ...doc.widgets[0]!, type: 'chart' };
      open('a');
      expect(screen.queryByRole('tab', { name: 'Tool buttons' })).toBeNull();
    });

    it('adding a button and choosing a tool names it, shows the command and maps from the last result, in one undo step', async () => {
      open('a', vms);
      tab('Tool buttons');
      fireEvent.click(screen.getByRole('button', { name: '+ Add tool button' }));
      const tool = screen.getByRole('combobox', { name: 'Tool' });
      await screen.findByRole('option', { name: 'Stop VM · once per row' });
      fireEvent.change(tool, { target: { value: 'Stop VM' } });

      expect((screen.getByRole('textbox', { name: 'Button label' }) as HTMLInputElement).value).toBe('Stop VM');
      expect(screen.getByText("az vm stop --ids '{id}'")).toBeTruthy();
      expect((screen.getByRole('combobox', { name: '{id}' }) as HTMLSelectElement).value).toBe('id');
      apply();
      expect(applied().tools).toEqual([
        { label: 'Stop VM', tool: 'Stop VM', mapping: { id: 'id' }, runsOn: 'selectedOrAll', after: 'refreshWidget', placement: 'header' },
      ]);
      expect(state().undo).toEqual([doc]);
    });

    it('a tool that isn’t in tools.json stays chosen, and Apply keeps it', async () => {
      doc.widgets[0] = { ...doc.widgets[0]!, tools: [button()] };
      open('a');
      tab('Tool buttons');
      const option = (await screen.findByRole('option', { name: 'Gone tool (not in your tools.json)' })) as HTMLOptionElement;
      expect(option.selected).toBe(true);
      fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), { target: { value: 'Renamed' } });
      apply();
      expect(applied().tools).toEqual([button()]);
    });

    it('unticking Rows can be selected turns selection off, disables Only selected rows and resets the buttons', () => {
      doc.widgets[0] = { ...doc.widgets[0]!, selection: 'multi', tools: [button()] };
      open('a');
      tab('Tool buttons');
      const only = () => screen.getByRole('radio', { name: /^Only selected rows/ }) as HTMLInputElement;
      expect(only().checked).toBe(true);
      fireEvent.click(screen.getByRole('checkbox', { name: 'Rows can be selected' }));

      expect(only().disabled).toBe(true);
      expect(screen.getByRole('checkbox', { name: 'Several rows at once' })).toHaveProperty('disabled', true);
      apply();
      expect(applied().selection).toBe('none');
      expect(applied().tools?.[0]?.runsOn).toBe('selectedOrAll');
    });

    it('a button with no tool keeps Apply off with a hint; Cancel writes nothing', () => {
      open('a');
      tab('Tool buttons');
      fireEvent.click(screen.getByRole('button', { name: '+ Add tool button' }));
      expect(screen.getByRole('button', { name: 'Apply' })).toHaveProperty('disabled', true);
      expect(screen.getByText('Choose a tool for each button.')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(state().doc).toBe(doc);
    });
  });
});
