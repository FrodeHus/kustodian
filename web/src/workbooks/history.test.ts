import { describe, expect, it } from 'vitest';
import type { RunResult } from '../wire';
import { historyRows, recordable, seriesLabel, sinceInstant, sinceLabel, SKIP_TEXT, statChange, withGaps } from './history';
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

const local = (m: number, d: number, h = 10) => new Date(2026, m - 1, d, h).toISOString();
const snap = (takenAt: string, n: number) => ({ takenAt, columns: [{ name: 'n', type: 'long' }], rows: [[n]] });

describe('withGaps', () => {
  it('with_gaps_inserts_a_null_row_per_missing_day', () => {
    const snaps = [snap(local(11, 1), 1), snap(local(11, 4), 4)];
    expect(withGaps(snaps, 'day')).toEqual({
      columns: [
        { name: 'Snapshot', type: 'datetime' },
        { name: 'n', type: 'long' },
      ],
      rows: [[local(11, 1), 1], [local(11, 2, 0), null], [local(11, 3, 0), null], [local(11, 4), 4]],
    });
    expect(withGaps(snaps, 'run').rows).toEqual([[local(11, 1), 1], [local(11, 4), 4]]);
    expect(withGaps(snaps, 'week').rows).toHaveLength(2);
  });
});

describe('statChange', () => {
  const h = { snapshots: [snap(local(10, 24), 375), snap(local(10, 28), 390), snap(local(11, 1), 412)], reset: false };
  const now = new Date(2026, 10, 1, 12);
  it('stat_change_compares_with_the_snapshot_at_or_before_the_point', () => {
    expect(statChange(h, 'n', 'P7D', now)).toEqual({ text: '▲ 37 vs 7 days ago (375)', at: local(10, 24) });
    expect(statChange(h, 'n', 'previous', now)).toEqual({ text: '▲ 22 vs previous snapshot (390)', at: local(10, 28) });
    expect(statChange(h, 'n', '2026-10-29', now)?.text).toBe('▲ 22 vs Oct 29 (390)');
    const fall = { ...h, snapshots: [snap(local(10, 24), 1500), snap(local(11, 1), 412)] };
    expect(statChange(fall, 'n', 'P7D', now)?.text).toBe('▼ 1,088 vs 7 days ago (1,500)');
    const same = { ...h, snapshots: [snap(local(10, 24), 412), snap(local(11, 1), 412)] };
    expect(statChange(same, 'n', 'P7D', now)?.text).toBe('No change vs 7 days ago');
  });
  it('stat_change_is_null_without_an_old_enough_snapshot', () => {
    expect(statChange(h, 'n', 'P30D', now)).toBeNull();
    expect(statChange({ snapshots: [snap(local(11, 1), 412)], reset: false }, 'n', 'previous', now)).toBeNull();
    expect(statChange(h, 'missing', 'P7D', now)).toBeNull();
  });
});
