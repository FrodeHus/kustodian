import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExternalTool, HighlightRule, HistorySeries, RunResult, SavedQuery } from '../wire';
import type { ToolButton, Widget, WidgetType, WorkbookDoc, WorkbookParameter } from './model';
import { defaultHistory, newWidget, newWorkbook } from './model';
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
  default: ({ picked, controls = true }: { picked: { type?: string; split?: string | null; stack?: string }; controls?: boolean }) => (
    <>
      <p>
        Chart {picked.type ?? 'auto'}, {controls ? 'with pickers' : 'alone'}
      </p>
      <p>
        Split {picked.split === undefined ? 'auto' : (picked.split ?? 'none')}, stack {picked.stack ?? 'auto'}
      </p>
    </>
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
    byTab: {
      t: {
        doc,
        values: { workbook: { TimeRange: '1d' }, widgets: {} },
        runs,
        editing: true,
        undo: [],
        redo: [],
        dirty: false,
        selections: {},
        history: {},
        since: {},
        activeTabs: {},
        stale: {},
      },
    },
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
  doc = {
    ...newWorkbook('Review'),
    parameters: [timeRange],
    widgets: [a, widget('m', 'markdown', { title: 'Notes', markdown: '# Hello' })],
  };
});

describe('WidgetEditor', () => {
  it('offers a workspace for a hunting widget only', () => {
    const w = widget('h', 'table');
    w.query = {
      ...w.query!,
      source: 'hunting',
      options: {
        timespan: 'P7D',
        scope: null,
        workspaces: [{ customerId: '11111111-1111-1111-1111-111111111111', name: 'Sentinel', resourceId: '/r' }],
      },
    };
    doc = { ...doc, widgets: [...doc.widgets, w] };
    open('h');
    expect(screen.getByRole('button', { name: /Workspace: Sentinel/ })).toBeTruthy();
    fireEvent.change(screen.getByRole('combobox', { name: 'Source' }), { target: { value: 'graph' } });
    expect(screen.queryByRole('button', { name: /Workspace:/ })).toBeNull();
  });

  it("a logs widget's editor shows the workspace picker without Primary workspace", () => {
    const w = widget('l', 'table');
    w.query = { ...w.query!, source: 'logs', options: { timespan: null, scope: null, workspaces: null } };
    doc = { ...doc, widgets: [...doc.widgets, w] };
    open('l');
    expect(screen.getByRole('button', { name: 'Workspace: Pick a workspace' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Timespan/ })).toBeTruthy();
    expect(screen.queryByText('Primary workspace')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Workspace: Pick a workspace' }));
    expect(screen.queryByText('Primary workspace')).toBeNull();
  });

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
    expect(
      screen.getByText(
        'Workbook: follows the global value. Widget · shown: a control in the widget header. Fixed: a set value, no control.',
      ),
    ).toBeTruthy();
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
        expect.objectContaining({
          tabId: 't/preview',
          kql: 'users | take {TimeRange}',
          parameters: [expect.objectContaining({ name: 'TimeRange', value: '1d' })],
        }),
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

  it('a stat widget’s Unit writes widget.stat.unit and keeps its columns', () => {
    doc.widgets[0] = { ...doc.widgets[0]!, type: 'stat', stat: { value: 'n', compare: 'm' } };
    open('a');
    tab('Visualization');
    fireEvent.change(screen.getByRole('textbox', { name: 'Unit' }), { target: { value: '%' } });
    apply();
    expect(applied().stat).toEqual({ value: 'n', compare: 'm', unit: '%' });
  });

  it('the preview draws the chart alone, as the Visualization tab sets it', async () => {
    const result = {
      outcome: 'ok',
      message: null,
      error: null,
      columns: [{ name: 'n', type: 'long' }],
      rows: [[1]],
      total: 1,
      tables: [],
      durationMs: 1,
      droppedValues: 0,
      runId: 'r',
      diagnostics: [],
      permissions: [],
    };
    call.mockImplementation((method: string) =>
      method === 'library.list'
        ? Promise.resolve({ queries: [], folders: [], skipped: 0 })
        : method === 'query.run'
          ? Promise.resolve(result)
          : new Promise(() => undefined),
    );
    doc.widgets[0] = { ...doc.widgets[0]!, type: 'chart' };
    open('a');
    tab('Visualization');
    fireEvent.click(screen.getByRole('button', { name: 'Bar' }));
    fireEvent.click(screen.getByRole('button', { name: 'Run preview' }));
    expect(await screen.findByText('Chart bar, alone')).toBeTruthy();
  });

  describe('Split by and Stacking', () => {
    const result = {
      outcome: 'ok',
      message: null,
      error: null,
      columns: [
        { name: 'day', type: 'datetime' },
        { name: 'state', type: 'string' },
        { name: 'n', type: 'long' },
      ],
      rows: [['2026-11-01T00:00:00Z', 'open', 1]],
      total: 1,
      tables: [],
      durationMs: 1,
      droppedValues: 0,
      runId: 'r',
      diagnostics: [],
      permissions: [],
    } as unknown as RunResult;
    const select = (name: string) => screen.getByRole('combobox', { name }) as HTMLSelectElement;

    it('Split by offers Automatic, None and the text columns, and writes widget.chart.split', () => {
      doc.widgets[0] = { ...doc.widgets[0]!, type: 'chart', chart: { type: 'column' } };
      open('a', result);
      tab('Visualization');
      expect(screen.queryByRole('combobox', { name: 'Series' })).toBeNull();
      expect([...select('Split by').options].map((o) => o.text)).toEqual(['Automatic', 'None', 'state']);
      fireEvent.change(select('Split by'), { target: { value: 'col:state' } });
      apply();
      expect(applied().chart).toMatchObject({ split: 'state' });
    });

    it('widget_editor_heatmap_fields', () => {
      const wide = {
        ...result,
        columns: [...result.columns, { name: 'blob', type: 'dynamic' }, { name: 'day2', type: 'datetime' }],
      } as unknown as RunResult;
      doc.widgets[0] = {
        ...doc.widgets[0]!,
        type: 'chart',
        chart: { type: 'column', x: 'day', split: 'state', series: ['n'] },
      };
      open('a', wide);
      tab('Visualization');
      fireEvent.click(screen.getByRole('button', { name: 'Heatmap' }));
      expect(screen.queryByRole('combobox', { name: 'X' })).toBeNull();
      expect([...select('Columns').options].map((o) => o.text)).toContain('day');
      expect([...select('Value').options].map((o) => o.text)).toContain('n');
      expect([...select('Rows').options].map((o) => o.text)).toEqual(['Automatic', 'day', 'state', 'n', 'day2']);
      fireEvent.change(select('Columns'), { target: { value: 'day' } });
      fireEvent.change(select('Value'), { target: { value: 'n' } });
      expect([...select('Rows').options].map((o) => o.text)).toEqual(['Automatic', 'state', 'day2']);
      apply();
      expect(applied().chart).toEqual({ type: 'heatmap', x: 'day', series: ['n'] });
    });

    it('widget_editor_gauge_fields', () => {
      doc.widgets[0] = { ...doc.widgets[0]!, type: 'chart', chart: { type: 'column', x: 'day', series: ['n'] } };
      open('a', result);
      tab('Visualization');
      fireEvent.click(screen.getByRole('button', { name: 'Gauge' }));
      for (const name of ['Label', 'Value', 'Desired level', 'Direction', 'Min', 'Max']) {
        expect(screen.getByLabelText(name)).toBeTruthy();
      }
      expect(screen.queryByRole('combobox', { name: 'Split by' })).toBeNull();
      expect(screen.queryByRole('combobox', { name: 'X' })).toBeNull();
      fireEvent.change(screen.getByLabelText('Desired level'), { target: { value: '80' } });
      fireEvent.change(select('Direction'), { target: { value: 'lower' } });
      apply();
      expect(applied().chart).toMatchObject({ type: 'gauge', target: 80, better: 'lower' });
    });

    it('Split by None writes null, so the chart doesn’t split', () => {
      doc.widgets[0] = { ...doc.widgets[0]!, type: 'chart', chart: { type: 'column' } };
      open('a', result);
      tab('Visualization');
      fireEvent.change(select('Split by'), { target: { value: 'none' } });
      apply();
      expect(applied().chart?.split).toBeNull();
    });

    it('Stacking writes widget.chart.stack, and the preview chart gets the split and the stacking', async () => {
      call.mockImplementation((method: string) =>
        method === 'library.list'
          ? Promise.resolve({ queries: [], folders: [], skipped: 0 })
          : method === 'query.run'
            ? Promise.resolve(result)
            : new Promise(() => undefined),
      );
      doc.widgets[0] = { ...doc.widgets[0]!, type: 'chart', chart: { type: 'bar' } };
      open('a', result);
      tab('Visualization');
      expect([...select('Stacking').options].map((o) => o.text)).toEqual(['None', 'Stacked', 'Stacked 100%']);
      fireEvent.change(select('Split by'), { target: { value: 'col:state' } });
      fireEvent.change(select('Stacking'), { target: { value: 'stacked100' } });
      fireEvent.click(screen.getByRole('button', { name: 'Run preview' }));
      expect(await screen.findByText('Split state, stack stacked100')).toBeTruthy();
      apply();
      expect(applied().chart).toMatchObject({ type: 'bar', split: 'state', stack: 'stacked100' });
    });

    it('Stacking is offered for column, bar and area charts only', () => {
      doc.widgets[0] = { ...doc.widgets[0]!, type: 'chart', chart: { type: 'column' } };
      open('a', result);
      tab('Visualization');
      for (const [name, shown] of [
        ['Area', true],
        ['Line', false],
        ['Pie', false],
        ['Time chart', false],
        ['Bar', true],
      ] as const) {
        fireEvent.click(screen.getByRole('button', { name }));
        expect(screen.queryByRole('combobox', { name: 'Stacking' }) !== null).toBe(shown);
      }
    });
  });

  it('a Markdown widget has a text area and a rendered preview, no tabs', () => {
    open('m');
    expect(screen.queryByRole('tab')).toBeNull();
    fireEvent.change(screen.getByRole('textbox', { name: 'Markdown' }), { target: { value: '## Range {TimeRange}' } });
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Range 1d');
    apply();
    expect(applied('m').markdown).toBe('## Range {TimeRange}');
  });

  describe('Highlight', () => {
    const rule: HighlightRule = { id: 'r1', column: 'name', op: '==', value: 'vm1', colour: 'danger', target: 'row' };

    it('a table widget has a Highlight tab; a chart widget doesn’t', () => {
      open('a');
      expect(screen.getByRole('tab', { name: 'Highlight' })).toBeTruthy();
      cleanup();
      doc.widgets.push(widget('c', 'chart'));
      open('c');
      expect(screen.queryByRole('tab', { name: 'Highlight' })).toBeNull();
    });

    it('edits an inline widget’s rules, written on Apply', () => {
      open('a', vms);
      tab('Highlight');
      fireEvent.click(screen.getByRole('button', { name: '+ Add rule' }));
      fireEvent.change(screen.getByRole('textbox', { name: 'Value' }), { target: { value: 'vm1' } });
      apply();
      expect(applied().query?.highlights).toEqual([expect.objectContaining({ column: 'name', op: '==', value: 'vm1', target: 'row' })]);
    });

    it('removing the last rule leaves no highlights key', () => {
      const a = doc.widgets[0]!;
      doc.widgets[0] = { ...a, query: { ...a.query!, highlights: [rule] } };
      open('a', vms);
      tab('Highlight');
      fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
      apply();
      expect('highlights' in applied().query!).toBe(false);
    });

    it('a widget without rules commits with no highlights key', () => {
      open('a');
      fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), { target: { value: 'Renamed' } });
      apply();
      expect(applied().title).toBe('Renamed');
      expect('highlights' in applied().query!).toBe(false);
    });

    it('linking a saved query without rules drops the widget’s own; Copy into widget keeps none', async () => {
      const a = doc.widgets[0]!;
      doc.widgets[0] = { ...a, query: { ...a.query!, highlights: [rule] } };
      open('a', vms);
      fireEvent.click(screen.getByRole('radio', { name: 'Use a saved query' }));
      await screen.findByRole('option', { name: 'Risky sign-ins' });
      fireEvent.change(screen.getByRole('combobox', { name: 'Saved query' }), { target: { value: 's1' } });
      fireEvent.click(screen.getByRole('button', { name: 'Copy into widget' }));
      apply();
      expect(applied().query).toMatchObject({ saved: null, text: 'riskyUsers | take {Top}' });
      expect('highlights' in applied().query!).toBe(false);
    });

    it('a linked widget copies its saved query’s rules and shows them read-only', async () => {
      call.mockImplementation((method: string) =>
        method === 'library.list'
          ? Promise.resolve({ queries: [{ ...risky, highlights: [rule] }], folders: [], skipped: 0 })
          : new Promise(() => undefined),
      );
      open('a', vms);
      fireEvent.click(screen.getByRole('radio', { name: 'Use a saved query' }));
      await screen.findByRole('option', { name: 'Risky sign-ins' });
      fireEvent.change(screen.getByRole('combobox', { name: 'Saved query' }), { target: { value: 's1' } });
      tab('Highlight');
      expect(screen.getByText('Edit the saved query to change these.')).toBeTruthy();
      expect(screen.getByRole('button', { name: '+ Add rule' })).toHaveProperty('disabled', true);
      expect(screen.getByRole('textbox', { name: 'Value' })).toHaveProperty('disabled', true);
      apply();
      expect(applied().query).toMatchObject({ saved: { id: 's1' }, highlights: [rule] });
    });
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

    it('lists a saved mapping column that the result lacks, instead of showing Automatic', async () => {
      doc.widgets[0] = { ...doc.widgets[0]!, tools: [button({ tool: 'Stop VM', label: 'Stop VM', mapping: { id: 'resourceId' } })] };
      open('a');
      tab('Tool buttons');
      await screen.findByRole('option', { name: 'Stop VM · once per row' });
      expect((screen.getByRole('combobox', { name: '{id}' }) as HTMLSelectElement).value).toBe('resourceId');
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

  describe('History tab', () => {
    const seriesOf = (list: HistorySeries[]) => {
      const base = call.getMockImplementation()!;
      call.mockImplementation((method: string, params: unknown) =>
        method === 'history.series' ? Promise.resolve(list) : method === 'history.clear' ? Promise.resolve(null) : base(method, params),
      );
    };
    const one: HistorySeries = { label: 'All values', since: '2026-11-02T12:00:00Z', snapshots: 31, gaps: 3, stored: 120 };
    const grid = (rows: unknown[][]): RunResult => ({
      ...vms,
      columns: [
        { name: 'name', type: 'string' },
        { name: 'id', type: 'string' },
      ],
      rows,
      total: rows.length,
    });
    const pick = (label: string, ...values: string[]) => {
      const select = screen.getByRole('listbox', { name: label }) as HTMLSelectElement;
      for (const o of select.options) {
        o.selected = values.includes(o.value);
      }
      fireEvent.change(select);
    };

    it('the_history_tab_turns_history_on_with_the_defaults_for_the_type', () => {
      open('a', vms);
      tab('History');
      fireEvent.click(screen.getByRole('checkbox', { name: 'Keep history for this widget' }));
      expect(screen.getByRole('button', { name: 'Row tracking' }).getAttribute('aria-pressed')).toBe('true');
      expect(screen.getByText('Choose at least one key column.')).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Apply' })).toHaveProperty('disabled', true);
      pick('Key columns: what makes a row the same row', 'name');
      expect(screen.getByRole('button', { name: 'Apply' })).toHaveProperty('disabled', false);
      expect(screen.queryByRole('option', { name: 'name', selected: false })).toBeNull();
      apply();
      expect(applied().history).toEqual({ ...defaultHistory('table'), keys: ['name'] });
    });

    it('each_type_offers_only_the_modes_it_can_show', () => {
      doc.widgets.push(
        widget('c', 'chart', { history: defaultHistory('chart') }),
        widget('s', 'stat', { history: defaultHistory('stat') }),
      );
      doc.widgets[0] = { ...doc.widgets[0]!, history: defaultHistory('table') };
      open('c');
      tab('History');
      expect(screen.getByRole('button', { name: 'Row tracking' })).toHaveProperty('disabled', true);
      expect(screen.getByText('Charts plot values over time.')).toBeTruthy();
      cleanup();
      open('a');
      tab('History');
      expect(screen.getByRole('button', { name: 'Values over time' })).toHaveProperty('disabled', true);
      expect(screen.getByText('Tables show tracked rows.')).toBeTruthy();
      cleanup();
      open('s');
      tab('History');
      expect(screen.getByRole('button', { name: 'Values over time' })).toHaveProperty('disabled', false);
      expect(screen.getByRole('button', { name: 'Row tracking' })).toHaveProperty('disabled', false);
    });

    it('switching_to_values_drops_the_row_tracking_columns', () => {
      seriesOf([]);
      doc.widgets.push(widget('s', 'stat', { history: { ...defaultHistory('stat'), mode: 'rows', keys: ['name'], keep: ['id'] } }));
      open('s', grid([['vm1', 'a']]));
      tab('History');
      fireEvent.click(screen.getByRole('button', { name: 'Values over time' }));
      apply();
      return vi.waitFor(() => expect(applied('s').history).toMatchObject({ mode: 'values', keys: [], keep: [] }));
    });

    it('key_uniqueness_is_shown_from_the_preview', () => {
      doc.widgets[0] = { ...doc.widgets[0]!, history: { ...defaultHistory('table'), keys: ['name'] } };
      open(
        'a',
        grid([
          ['vm1', 'a'],
          ['vm1', 'b'],
        ]),
      );
      tab('History');
      expect(screen.getByText('Not unique in the last result')).toBeTruthy();
      cleanup();
      open(
        'a',
        grid([
          ['vm1', 'a'],
          ['vm2', 'b'],
          ['vm3', 'c'],
        ]),
      );
      tab('History');
      expect(screen.getByText('✓ Unique in the last result (3 rows)')).toBeTruthy();
    });

    it('the_series_list_shows_each_parameter_combination', async () => {
      seriesOf([one, { label: 'Severity = High', since: '2026-11-05T12:00:00Z', snapshots: 4, gaps: 1, stored: 9 }]);
      open('a');
      tab('History');
      const rows = await screen.findAllByRole('row');
      expect(rows).toHaveLength(3);
      expect(within(rows[1]!).getByText('All values')).toBeTruthy();
      expect(within(rows[1]!).getByText('Nov 2, 2026')).toBeTruthy();
      expect(within(rows[1]!).getByText('31 · 3 gaps')).toBeTruthy();
      expect(within(rows[1]!).getByText('120')).toBeTruthy();
      expect(within(rows[2]!).getByText('4 · 1 gap')).toBeTruthy();
    });

    it('shows the error when the series cannot be read', async () => {
      const base = call.getMockImplementation()!;
      call.mockImplementation((method: string, params: unknown) =>
        method === 'history.series' ? Promise.reject(new Error('disk gone')) : base(method, params),
      );
      open('a');
      tab('History');
      expect((await screen.findByRole('alert')).textContent).toContain('disk gone');
    });

    describe('applying an edit that would invalidate history', () => {
      beforeEach(() => {
        doc.widgets[0] = { ...doc.widgets[0]!, history: { ...defaultHistory('table'), keys: ['name'] } };
      });
      const editQuery = () => fireEvent.change(screen.getByRole('textbox', { name: 'KQL query' }), { target: { value: 'other' } });

      it('applying_a_query_edit_with_history_asks_first: Clear and apply clears, then applies', async () => {
        seriesOf([one]);
        open('a');
        editQuery();
        apply();
        const ask = await screen.findByRole('dialog', { name: "Clear this widget's history?" });
        expect(ask.getAttribute('aria-modal')).toBe('true');
        expect(applied().query?.text).not.toBe('other');
        fireEvent.click(within(ask).getByRole('button', { name: 'Clear and apply' }));
        await vi.waitFor(() => expect(applied().query?.text).toBe('other'));
        expect(call).toHaveBeenCalledWith('history.clear', { workbookId: doc.id, widgetId: 'a' });
        expect(onClose).toHaveBeenCalled();
      });

      it('Cancel keeps the editor open with the draft and clears nothing', async () => {
        seriesOf([one]);
        open('a');
        editQuery();
        apply();
        fireEvent.click(
          within(await screen.findByRole('dialog', { name: "Clear this widget's history?" })).getByRole('button', { name: 'Cancel' }),
        );
        expect(screen.queryByRole('dialog', { name: "Clear this widget's history?" })).toBeNull();
        expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Apply' }));
        expect((screen.getByRole('textbox', { name: 'KQL query' }) as HTMLTextAreaElement).value).toBe('other');
        expect(call).not.toHaveBeenCalledWith('history.clear', expect.anything());
        expect(onClose).not.toHaveBeenCalled();
        expect(applied().query?.text).not.toBe('other');
      });

      it('a failed clear shows the error and does not apply', async () => {
        seriesOf([one]);
        const base = call.getMockImplementation()!;
        call.mockImplementation((method: string, params: unknown) =>
          method === 'history.clear' ? Promise.reject(new Error('locked')) : base(method, params),
        );
        open('a');
        editQuery();
        apply();
        fireEvent.click(await screen.findByRole('button', { name: 'Clear and apply' }));
        expect((await screen.findByRole('alert')).textContent).toContain('locked');
        expect(applied().query?.text).not.toBe('other');
      });

      it('changing the keys, the mode or turning history off asks the same', async () => {
        seriesOf([one]);
        open('a', vms);
        tab('History');
        pick('Key columns: what makes a row the same row', 'id');
        apply();
        expect(await screen.findByRole('dialog', { name: "Clear this widget's history?" })).toBeTruthy();
        cleanup();
        open('a');
        tab('History');
        fireEvent.click(screen.getByRole('checkbox', { name: 'Keep history for this widget' }));
        apply();
        expect(await screen.findByRole('dialog', { name: "Clear this widget's history?" })).toBeTruthy();
      });

      it('no stored series, or only interval and retention changed, means no question', async () => {
        seriesOf([]);
        open('a');
        editQuery();
        apply();
        await vi.waitFor(() => expect(applied().query?.text).toBe('other'));
        expect(screen.queryByRole('dialog', { name: "Clear this widget's history?" })).toBeNull();
        cleanup();
        seriesOf([one]);
        doc = state().doc;
        open('a');
        tab('History');
        fireEvent.change(screen.getByRole('combobox', { name: 'Save at most' }), { target: { value: 'week' } });
        fireEvent.change(screen.getByRole('combobox', { name: 'Forget gone rows after' }), { target: { value: '30' } });
        apply();
        expect(applied().history).toMatchObject({ interval: 'week', retentionDays: 30 });
        expect(call).not.toHaveBeenCalledWith('history.clear', expect.anything());
      });
    });
  });
});
