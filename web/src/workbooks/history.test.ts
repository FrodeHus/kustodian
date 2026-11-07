import { describe, expect, it } from 'vitest';
import type { RunResult } from '../wire';
import { historyRows, recordable, seriesLabel, sinceInstant, sinceLabel, SKIP_TEXT } from './history';
import type { WidgetHistory } from './model';
import type { ResolvedParam } from './resolve';
import type { WidgetRun } from './workbook-store';

const result = (over: Partial<RunResult> = {}): RunResult => ({
  outcome: 'ok',
  message: null,
  error: null,
  columns: [],
  rows: [],
  total: 0,
  tables: [],
  durationMs: 1,
  droppedValues: 0,
  runId: 'r',
  diagnostics: [],
  permissions: [],
  ...over,
});
const done = (r: RunResult): WidgetRun => ({ state: 'done', result: r });
const setting = (over: Partial<WidgetHistory> = {}): WidgetHistory => ({
  mode: 'rows',
  interval: 'day',
  retentionDays: 90,
  keys: [],
  keep: [],
  since: 'P7D',
  ...over,
});
const p = (name: string, value: string, from: ResolvedParam['from'] = 'workbook'): ResolvedParam => ({ name, type: 'list', value, required: false, from });

describe('recordable', () => {
  it('a_cut_off_run_is_not_recordable', () => {
    const r = result({ total: 61200, rows: Array.from({ length: 50000 }, () => []) });
    expect(recordable(done(r), false)).toBe('cutOff');
  });
  it('a_refused_or_failed_run_is_not_recordable', () => {
    expect(recordable(done(result({ outcome: 'tooLarge' })), false)).toBe('failed');
    expect(recordable({ state: 'failed', error: new Error('x') }, false)).toBe('failed');
  });
  it('an_unsaved_workbook_is_not_recordable', () => {
    expect(recordable(done(result()), true)).toBe('unsaved');
  });
  it('sends_a_complete_saved_run', () => {
    expect(recordable(done(result({ total: 1, rows: [[1]] })), false)).toBeNull();
  });
  it('has_the_skip_copy', () => {
    expect(SKIP_TEXT.unsaved).toBe('Not recorded: save the workbook first');
  });
});

describe('historyRows', () => {
  const cols = ['CveId', 'DeviceName', 'DeviceId'].map((name) => ({ name, type: 'string' }));
  it('row_tracking_sends_keys_first_then_kept_columns', () => {
    const r = result({ columns: cols, rows: [['CVE-1', 'pc1', 'd1'], ['CVE-1', 'pc2', 'd2']] });
    const out = historyRows(r, setting({ keys: ['DeviceId', 'CveId'], keep: ['DeviceName'] }));
    expect(out).toEqual({
      columns: ['DeviceId', 'CveId', 'DeviceName'].map((name) => ({ name, type: 'string' })),
      rows: [['d1', 'CVE-1', 'pc1'], ['d2', 'CVE-1', 'pc2']],
    });
  });
  it('duplicate_keys_are_caught_before_sending', () => {
    const r = result({ columns: cols, rows: [['CVE-1', 'pc1', 'd1'], ['CVE-1', 'pc2', 'd1']] });
    expect(historyRows(r, setting({ keys: ['DeviceId', 'CveId'] }))).toBe('keysNotUnique');
  });
  it('a_missing_key_column_is_not_unique', () => {
    expect(historyRows(result({ columns: cols }), setting({ keys: ['Nope'] }))).toBe('keysNotUnique');
  });
  it('values_mode_sends_the_whole_result', () => {
    const r = result({ columns: cols, rows: [['a', 'b', 'c']] });
    expect(historyRows(r, setting({ mode: 'values' }))).toEqual({ columns: cols, rows: r.rows });
  });
});

describe('seriesLabel', () => {
  it('series_label_lists_the_values', () => {
    expect(seriesLabel([p('Severity', 'Critical\nHigh'), p('Site', 'Oslo', 'widget')])).toBe('Severity = Critical, High, Site = Oslo');
  });
  it('leaves_out_fixed_and_empty_params', () => {
    expect(seriesLabel([p('A', 'x', 'fixed'), p('B', '')])).toBe('All values');
    expect(seriesLabel([])).toBe('All values');
  });
});

describe('since', () => {
  const now = new Date(2026, 10, 7, 15, 30);
  it('since_7_days_is_local_midnight', () => {
    expect(sinceInstant('P7D', now)).toBe(new Date(2026, 9, 31).toISOString());
  });
  it('since_a_date', () => {
    expect(sinceInstant('2026-10-30', now)).toBe(new Date(2026, 9, 30).toISOString());
  });
  it('previous_stays_previous', () => {
    expect(sinceInstant('previous', now)).toBe('previous');
  });
  it('labels', () => {
    expect(sinceLabel('previous', null)).toBe('Previous snapshot');
    expect(sinceLabel('P1D', null)).toBe('Yesterday');
    expect(sinceLabel('P7D', null)).toBe('7 days ago');
    expect(sinceLabel('P30D', null)).toBe('30 days ago');
    expect(sinceLabel('2026-10-30', null)).toBe('Oct 30');
  });
});
