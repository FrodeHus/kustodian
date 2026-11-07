import type { ResultColumn, RunResult } from '../wire';
import type { WidgetHistory } from './model';
import type { ResolvedParam } from './resolve';
import type { WidgetRun } from './workbook-store';

export type SkipReason = 'cutOff' | 'failed' | 'tooManyRows' | 'keysNotUnique' | 'unsaved';

export const SKIP_TEXT: Record<SkipReason, string> = {
  cutOff: 'Not recorded: the run was cut off at the row limit',
  failed: 'Not recorded: the run failed',
  tooManyRows: 'Not recorded: over 500 rows. Use Row tracking or summarise the query.',
  keysNotUnique: "Not recorded: the key columns aren't unique in this result",
  unsaved: 'Not recorded: save the workbook first',
};

/** Why a run must not be sent to history, or null. A partial result would mark every missing key as gone (spec §10.2). */
export function recordable(run: WidgetRun, dirty: boolean): SkipReason | null {
  if (run.state !== 'done') {
    return 'failed';
  }
  if (run.result.outcome !== 'ok') {
    return 'failed';
  }
  if (run.result.total > run.result.rows.length) {
    return 'cutOff';
  }
  return dirty ? 'unsaved' : null;
}

/** What to send: the whole result (Values; the host refuses over 500 rows), or key columns then `keep` (Rows). */
export function historyRows(result: RunResult, h: WidgetHistory): { columns: ResultColumn[]; rows: unknown[][] } | 'keysNotUnique' {
  if (h.mode === 'values') {
    return { columns: result.columns, rows: result.rows };
  }
  const index = [...h.keys, ...h.keep.filter((k) => !h.keys.includes(k))].map((name) => result.columns.findIndex((c) => c.name === name));
  const keyCount = h.keys.length;
  if (keyCount === 0 || index.slice(0, keyCount).includes(-1)) {
    return 'keysNotUnique';
  }
  const used = index.filter((i) => i >= 0);
  const rows = result.rows.map((r) => used.map((i) => r[i]));
  const seen = new Set(rows.map((r) => JSON.stringify(r.slice(0, keyCount))));
  if (seen.size !== rows.length) {
    return 'keysNotUnique';
  }
  return { columns: used.map((i) => result.columns[i] as ResultColumn), rows };
}

/** The values the run used, e.g. `Severity = Critical, High`; fixed parameters and empty ones aren't part of the series' name. */
export function seriesLabel(params: ResolvedParam[]): string {
  const parts = params
    .filter((p) => p.from !== 'fixed')
    .flatMap((p) => {
      const values = p.value.split('\n').map((v) => v.trim()).filter((v) => v !== '');
      return values.length ? [`${p.name} = ${values.join(', ')}`] : [];
    });
  return parts.length ? parts.join(', ') : 'All values';
}

/** `since` as an instant: local midnight of that day, ISO; `'previous'` is the host's to resolve. */
export function sinceInstant(since: string, now: Date): string {
  if (since === 'previous') {
    return since;
  }
  const days = /^P(\d+)D$/.exec(since);
  if (days) {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() - Number(days[1])).toISOString();
  }
  const [y, m, d] = since.split('-').map(Number) as [number, number, number];
  return new Date(y, m - 1, d).toISOString();
}

const SINCE_LABELS: Record<string, string> = { previous: 'Previous snapshot', P1D: 'Yesterday', P7D: '7 days ago', P30D: '30 days ago' };
const monthDay = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });

export function sinceLabel(since: string, _at: string | null): string {
  if (SINCE_LABELS[since]) {
    return SINCE_LABELS[since];
  }
  const [y, m, d] = since.split('-').map(Number) as [number, number, number];
  return monthDay.format(new Date(y, m - 1, d));
}
