import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HistoryChanges, HistoryQuery, HistoryValues, RunResult } from '../../wire';
import { sinceInstant } from '../history';
import type { Widget, WidgetHistory, WidgetType } from '../model';
import { newWidget, newWorkbook } from '../model';
import type { WidgetHistoryState, WidgetRun, WorkbookState } from '../workbook-store';
import { useWorkbooks } from '../workbook-store';
import { WorkbookView } from '../workbook-view';

const call = vi.hoisted(() => vi.fn());
vi.mock('../../bridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../bridge')>()),
  call,
  on: () => () => undefined,
}));

// Recharts can't lay out in jsdom: the chart's props are what's checked.
const chart = vi.hoisted(() => vi.fn());
vi.mock('../../results/chart-view', () => ({
  default: (props: unknown) => {
    chart(props);
    return <p>Chart</p>;
  },
}));

const result = (columns: RunResult['columns'], rows: unknown[][], total = rows.length): RunResult => ({
  outcome: 'ok',
  message: null,
  error: null,
  columns,
  rows,
  total,
  tables: [],
  durationMs: 120,
  droppedValues: 0,
  runId: 'r',
  diagnostics: [],
  permissions: [],
});

const NOW = new Date(2026, 10, 7, 12);
const daysAgo = (n: number, h = 10) => new Date(2026, 10, 7 - n, h).toISOString();
const query: HistoryQuery = { source: 'graph', text: 'Q', options: null, parameters: [] };

function widget(type: WidgetType, history: Partial<WidgetHistory>, extra: Partial<Widget> = {}): Widget {
  const w = newWidget(type, { x: 0, y: 0, w: 4, h: 12 });
  return {
    ...w,
    id: 'w',
    title: 'Open findings',
    query: { ...w.query!, text: 'Q' },
    history: { mode: 'values', interval: 'day', retentionDays: 90, keys: [], keep: [], since: 'P7D', ...history },
    ...extra,
  };
}

/** `entry` null: the record hasn't answered yet. */
function show(w: Widget, run: WidgetRun, entry: Partial<WidgetHistoryState> | null = {}) {
  const doc = { ...newWorkbook('Findings'), widgets: [w] };
  const state: WorkbookState = {
    doc,
    values: { workbook: {}, widgets: {} },
    runs: { w: run },
    editing: false,
    undo: [],
    redo: [],
    dirty: false,
    selections: {},
    history: entry ? { w: { skipped: null, reset: false, recordedAt: 1, query, ...entry } } : {},
    since: {},
  };
  useWorkbooks.setState({ byTab: { t: state } });
  return render(<WorkbookView tabId="t" />);
}

const n = [{ name: 'n', type: 'long' }];
const snap = (takenAt: string, v: number) => ({ takenAt, columns: n, rows: [[v]] });
const values: HistoryValues = { snapshots: [snap(daysAgo(34), 300), snap(daysAgo(8), 375), snap(daysAgo(0, 9), 412)], reset: false };
const tracked = (id: string, firstSeen: string, gone: string | null = null) => ({ values: [id], firstSeen, gone });
const changes = (over: Partial<HistoryChanges> = {}): HistoryChanges => ({
  since: daysAgo(8),
  columns: [{ name: 'Id', type: 'string' }],
  new: [tracked('n1', daysAgo(1))],
  newCount: 23,
  gone: [tracked('g1', daysAgo(20), daysAgo(2))],
  goneCount: 41,
  open: 1206,
  reset: false,
  ...over,
});
const sent = (method: string) => call.mock.calls.filter(([m]) => m === method);
const widgetFrame = () => screen.getByRole('region', { name: 'Open findings' });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  chart.mockReset();
  call.mockReset();
  call.mockImplementation((method: string) =>
    Promise.resolve(method === 'history.values' ? values : method === 'history.changes' ? changes() : null),
  );
});

afterEach(() => {
  vi.useRealTimers();
});

describe('history in the widgets', () => {
  it('a_stat_with_values_history_shows_the_change', async () => {
    // The run's own record is taken as it finishes.
    show(widget('stat', {}), { state: 'done', result: result(n, [[412]]), finishedAt: Date.parse(daysAgo(0, 9)) });
    expect(await screen.findByText('▲ 37 vs 7 days ago (375)')).toBeTruthy();
    expect(within(widgetFrame()).getByText('412')).toBeTruthy();
    expect(within(widgetFrame()).getByText('Daily · 34 days')).toBeTruthy();
    expect(sent('history.values')).toEqual([
      ['history.values', { workbookId: expect.any(String), widgetId: 'w', query, setting: { mode: 'values', interval: 'day', retentionDays: 90, keys: [] } }],
    ]);
  });

  it('a_stat_whose_run_was_not_recorded_compares_the_number_it_shows', async () => {
    call.mockImplementation((method: string) =>
      Promise.resolve(method === 'history.values' ? { snapshots: [snap(daysAgo(8), 375), snap(daysAgo(1), 390)], reset: false } : null),
    );
    show(widget('stat', { since: 'previous' }), { state: 'done', result: result(n, [[412]]), finishedAt: NOW.getTime() }, { skipped: 'unsaved' });
    expect(await screen.findByText('▲ 22 vs previous snapshot (390)')).toBeTruthy();
    expect(within(widgetFrame()).getByText('412')).toBeTruthy();
  });

  it('a_stat_with_row_tracking_counts_new_and_gone', async () => {
    show(widget('stat', { mode: 'rows', keys: ['Id'], since: '2026-10-30' }), { state: 'done', result: result([{ name: 'Id', type: 'string' }], [['a']]), finishedAt: 5 });
    expect(await screen.findByText('1,206')).toBeTruthy();
    expect(screen.getByText('23 new · 41 no longer reported since Oct 30')).toBeTruthy();
    expect(sent('history.changes')[0]?.[1]).toMatchObject({ since: sinceInstant('2026-10-30', NOW), setting: { mode: 'rows', keys: ['Id'] } });
    // Row tracking's footer has no snapshots to count days from.
    expect(within(widgetFrame()).getByText('Daily')).toBeTruthy();
  });

  it('a_chart_with_history_plots_snapshots', async () => {
    const twoDays = { snapshots: [snap(daysAgo(2), 1), snap(daysAgo(0), 3)], reset: false };
    call.mockImplementation((method: string) => Promise.resolve(method === 'history.values' ? twoDays : null));
    show(widget('chart', {}, { chart: { type: 'line' } }), { state: 'done', result: result(n, [[3]]), finishedAt: 5 });
    await act(async () => undefined);
    expect(chart).toHaveBeenLastCalledWith(
      expect.objectContaining({
        picked: { type: 'line', x: 'Snapshot' },
        columns: [{ name: 'Snapshot', type: 'datetime' }, ...n],
        rows: [[daysAgo(2), 1], [new Date(2026, 10, 6).toISOString(), null], [daysAgo(0), 3]],
      }),
    );
    expect(screen.queryByRole('combobox', { name: 'Since' })).toBeNull();
  });

  it('a_tracked_table_filters_by_change', async () => {
    const big = changes({ new: Array.from({ length: 5000 }, (_, i) => tracked(`n${i}`, daysAgo(1))), newCount: 6000 });
    call.mockImplementation((method: string) => Promise.resolve(method === 'history.changes' ? big : null));
    const { container } = show(widget('table', { mode: 'rows', keys: ['Id'] }), {
      state: 'done',
      result: result([{ name: 'Id', type: 'string' }], [['open-1'], ['open-2']]),
      finishedAt: 5,
    });
    const filters = await screen.findByRole('group', { name: 'Show' });
    const button = (name: RegExp) => within(filters).getByRole('button', { name });
    const headers = () => [...container.querySelectorAll('thead th:not(.inspect-col)')].map((th) => th.textContent?.replace(/ [↑↓]$/, ''));
    const cells = (col: number) => [...container.querySelectorAll(`tbody tr[data-index] td:nth-child(${col})`)].map((td) => td.textContent);
    expect(button(/^Open now/).textContent).toBe('Open now (2)');
    expect(button(/^New since/).textContent).toBe('New since (6,000)');
    expect(button(/^No longer reported since/).textContent).toBe('No longer reported since (41)');
    expect(button(/^Open now/).getAttribute('aria-pressed')).toBe('true');
    // Open now: the run's rows, with selection.
    expect(container.textContent).toContain('open-1');
    expect(container.querySelector('tbody input[type="checkbox"]')).toBeTruthy();

    fireEvent.click(button(/^New since/));
    expect(button(/^New since/).getAttribute('aria-pressed')).toBe('true');
    expect(headers()).toEqual(expect.arrayContaining(['Id', 'Change', 'First seen', 'No longer reported']));
    expect(container.textContent).toContain('n0');
    expect(container.textContent).not.toContain('open-1');
    expect(container.querySelector('tbody input[type="checkbox"]')).toBeNull();
    expect(screen.getByText('Showing 5,000 of 6,000')).toBeTruthy();

    fireEvent.click(button(/^No longer reported since/));
    expect(container.textContent).toContain('g1');
    expect(container.textContent).not.toContain('n0');
    expect(screen.getByText('Showing 1 of 41')).toBeTruthy();
    const changeAt = headers().indexOf('Change') + 2; // the inspect column, then 1-based
    const goneAt = headers().indexOf('No longer reported') + 2;
    expect(cells(changeAt)).toEqual(['no longer reported']);
    expect(cells(goneAt)[0]).not.toBe('');

    // Both: the new rows, then the gone ones (the grid virtualizes, so only the first are drawn).
    fireEvent.click(button(/^Both/));
    expect(cells(changeAt)[0]).toBe('new');
    expect(screen.getByText('Showing 5,001 of 6,041')).toBeTruthy();
  });

  it('changing_since_refetches', async () => {
    show(widget('table', { mode: 'rows', keys: ['Id'] }), { state: 'done', result: result([{ name: 'Id', type: 'string' }], [['a']]), finishedAt: 5 });
    await screen.findByRole('group', { name: 'Show' });
    expect(sent('history.changes')).toHaveLength(1);
    fireEvent.change(screen.getByRole('combobox', { name: 'Since' }), { target: { value: 'previous' } });
    await act(async () => undefined);
    expect(sent('history.changes')).toHaveLength(2);
    expect(sent('history.changes')[1]?.[1]).toMatchObject({ since: 'previous' });
    expect(useWorkbooks.getState().byTab.t?.since).toEqual({ w: 'previous' });
    expect(sent('query.run')).toHaveLength(0);
  });

  it('a_date_since_shows_a_date_input', async () => {
    show(widget('stat', {}), { state: 'done', result: result(n, [[412]]), finishedAt: 5 });
    fireEvent.change(screen.getByRole('combobox', { name: 'Since' }), { target: { value: 'date' } });
    fireEvent.change(screen.getByLabelText('Since date'), { target: { value: '2026-10-30' } });
    expect(useWorkbooks.getState().byTab.t?.since).toEqual({ w: '2026-10-30' });
    await act(async () => undefined);
  });

  it('the_footer_shows_the_skip_reason', async () => {
    show(widget('stat', {}), { state: 'done', result: result(n, [[412]]), finishedAt: 5 }, { skipped: 'cutOff' });
    const line = within(widgetFrame()).getByText('! Not recorded: the run was cut off at the row limit');
    expect(line.classList.contains('text-warn')).toBe(true);
    await act(async () => undefined);
  });

  it('a_failed_record_is_said_in_the_footer', async () => {
    show(widget('stat', {}), { state: 'done', result: result(n, [[412]]), finishedAt: 5 }, { error: 'disk full' });
    const line = within(widgetFrame()).getByText('! Not recorded: disk full');
    expect(line.classList.contains('text-warn')).toBe(true);
    await act(async () => undefined);
  });

  it('a_values_read_sends_no_key_columns', async () => {
    show(widget('stat', { keys: ['n'] }), { state: 'done', result: result(n, [[412]]), finishedAt: 5 });
    await vi.waitFor(() => expect(sent('history.values')).toHaveLength(1));
    expect(sent('history.values')[0]![1]).toMatchObject({ setting: { keys: [] } });
  });

  it('a_read_that_says_reset_is_said_in_the_footer', async () => {
    call.mockImplementation((method: string) => Promise.resolve(method === 'history.values' ? { ...values, reset: true } : null));
    show(widget('stat', {}), { state: 'done', result: result(n, [[412]]), finishedAt: 5 });
    expect(await within(widgetFrame()).findByText('History was reset: its file was damaged.')).toBeTruthy();
  });

  it('a_reset_database_is_said_once_per_widget', async () => {
    show(widget('stat', {}), { state: 'done', result: result(n, [[412]]), finishedAt: 5 }, { reset: true });
    expect(within(widgetFrame()).getAllByText('History was reset: its file was damaged.')).toHaveLength(1);
    await act(async () => undefined);
  });

  it('a_history_read_error_is_said_in_the_footer', async () => {
    call.mockImplementation(() => Promise.reject(new Error('disk')));
    show(widget('stat', {}), { state: 'done', result: result(n, [[412]]), finishedAt: 5 });
    expect(await within(widgetFrame()).findByText(/Couldn’t read history: .*disk/)).toBeTruthy();
  });

  it('nothing_is_fetched_before_the_record_answers', async () => {
    show(widget('stat', {}), { state: 'done', result: result(n, [[412]]), finishedAt: 5 }, null);
    await act(async () => undefined);
    expect(sent('history.values')).toHaveLength(0);
  });

  it('the_labels_never_say_patched_or_removed', async () => {
    const { container } = show(widget('table', { mode: 'rows', keys: ['Id'] }), { state: 'done', result: result([{ name: 'Id', type: 'string' }], [['a']]), finishedAt: 5 });
    const filters = await screen.findByRole('group', { name: 'Show' });
    for (const b of within(filters).getAllByRole('button')) {
      fireEvent.click(b);
      expect(container.textContent).not.toMatch(/Patched|Removed/);
    }
    expect(sent('history.record')).toHaveLength(0);
  });
});
