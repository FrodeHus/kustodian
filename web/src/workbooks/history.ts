import { createContext, useEffect, useRef, useState } from 'react';
import { call } from '../bridge';
import { errorText } from '../shell/errors';
import type { HistoryChanges, HistoryValues, ResultColumn, RunResult } from '../wire';
import type { Widget, WidgetHistory } from './model';
import type { ResolvedParam } from './resolve';
import { useWorkbooks, type WidgetRun } from './workbook-store';

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

/** The setting as sent to the host; Values mode has no key columns (the host refuses keys the result lacks). */
export const historySetting = (h: WidgetHistory) => ({ mode: h.mode, interval: h.interval, retentionDays: h.retentionDays, keys: h.mode === 'rows' ? h.keys : [] });

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

/** `since` inside a sentence: "vs 7 days ago", "since previous snapshot", "since Oct 30". */
export function sinceWords(since: string): string {
  return SINCE_LABELS[since]?.toLowerCase() ?? sinceLabel(since, null);
}

export function sinceLabel(since: string, _at: string | null): string {
  if (SINCE_LABELS[since]) {
    return SINCE_LABELS[since];
  }
  const [y, m, d] = since.split('-').map(Number) as [number, number, number];
  return monthDay.format(new Date(y, m - 1, d));
}

const DAY_MS = 86_400_000;
const localDay = (iso: string) => {
  const d = new Date(iso);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
};

/** The snapshots as one table, oldest first, with a leading `Snapshot` column. For `day`, a row of nulls on each missing day,
 * so the chart draws a gap there. Columns are the latest snapshot's; an older snapshot's are matched by name. */
export function withGaps(snapshots: HistoryValues['snapshots'], interval: WidgetHistory['interval']): { columns: ResultColumn[]; rows: unknown[][] } {
  const sorted = [...snapshots].sort((a, b) => Date.parse(a.takenAt) - Date.parse(b.takenAt));
  const columns = sorted.at(-1)?.columns ?? [];
  const rows: unknown[][] = [];
  let last: Date | null = null;
  for (const s of sorted) {
    const day = localDay(s.takenAt);
    if (interval === 'day' && last) {
      for (let d = new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1); d < day; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
        rows.push([d.toISOString(), ...columns.map(() => null)]);
      }
    }
    last = day;
    if (s.rows.length === 0) {
      // Nothing reported: a point of nulls, so the line breaks there instead of joining its neighbours.
      rows.push([s.takenAt, ...columns.map(() => null)]);
      continue;
    }
    const at = columns.map((c) => s.columns.findIndex((sc) => sc.name === c.name));
    for (const r of s.rows) {
      rows.push([s.takenAt, ...at.map((i) => (i < 0 ? null : r[i]))]);
    }
  }
  return { columns: [{ name: 'Snapshot', type: 'datetime' }, ...columns], rows };
}

const numberText = (n: number) => n.toLocaleString('en-US');
/** A cell as a number; NaN for null, '' and anything else that isn't one (Number would read null and '' as 0). */
export const numberOf = (cell: unknown) => (cell === null || cell === undefined || (typeof cell === 'string' && cell.trim() === '') ? NaN : Number(cell));

/** The live run's `live.value` against the last snapshot from before that run (taken before `live.at`, ms) that is on or before
 * the since day, or (`'previous'`) the last one. Snapshots from `live.at` on are that run's own record. */
export function statChange(h: HistoryValues, valueColumn: string, since: string, now: Date, live: { value: number; at: number }): { text: string; at: string } | null {
  const snaps = [...h.snapshots].sort((a, b) => Date.parse(a.takenAt) - Date.parse(b.takenAt)).filter((s) => Date.parse(s.takenAt) < live.at);
  const day = since === 'previous' ? null : new Date(sinceInstant(since, now));
  // Any time on the since day counts: the bound is the next local midnight.
  const end = day && new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1).getTime();
  const old = end === null ? snaps.at(-1) : snaps.findLast((s) => Date.parse(s.takenAt) < end);
  if (!old) {
    return null;
  }
  const current = live.value;
  const then = numberOf(old.rows[0]?.[old.columns.findIndex((c) => c.name === valueColumn)]);
  if (!Number.isFinite(current) || !Number.isFinite(then)) {
    return null;
  }
  const diff = current - then;
  const vs = `vs ${sinceWords(since)}`;
  return { text: diff === 0 ? `No change ${vs}` : `${diff < 0 ? '▼' : '▲'} ${numberText(Math.abs(diff))} ${vs} (${numberText(then)})`, at: old.takenAt };
}

/** Whole days from `from` to `now`. */
export const daysSince = (from: string, now: Date) => Math.floor((now.getTime() - Date.parse(from)) / DAY_MS);

export interface HistoryView {
  values?: HistoryValues;
  changes?: HistoryChanges;
  error?: string;
  /** When the answer arrived, ms: "now" for the change line and the footer's days, so rendering stays pure. */
  readAt?: number;
}

/** What the widget frame read, for the widget inside it, and the tracked table's filter (the frame hides tools off Open now). */
export const HistoryData = createContext<HistoryView & { filter: HistoryFilter; setFilter: (f: HistoryFilter) => void }>({
  filter: 'open',
  setFilter: () => undefined,
});
export type HistoryFilter = 'open' | 'new' | 'gone' | 'both';

/** Reads the widget's history after each `done` run, once its record has answered (the store's entry changes then), and again
 * when its Since changes. It reads by the query the last run sent, so it reads the series the record wrote. A late answer to an
 * older request is dropped. Never records or logs. */
export function useHistory(tabId: string, widget: Widget, run: WidgetRun): HistoryView {
  const entry = useWorkbooks((s) => s.byTab[tabId]?.history[widget.id]);
  const workbookId = useWorkbooks((s) => s.byTab[tabId]?.doc.id);
  const chosen = useWorkbooks((s) => s.byTab[tabId]?.since[widget.id]);
  const h = widget.history;
  const since = chosen ?? h?.since;
  const done = run.state === 'done';
  const finishedAt = done ? run.finishedAt : undefined;
  const [view, setView] = useState<HistoryView>({});
  const latest = useRef(0);
  useEffect(() => {
    if (!h || !done || !entry || entry.pending || !workbookId || since === undefined) {
      return;
    }
    const n = ++latest.current;
    const params = {
      workbookId,
      widgetId: widget.id,
      query: entry.query,
      setting: historySetting(h),
    };
    const read: Promise<HistoryView> =
      h.mode === 'values'
        ? call<HistoryValues>('history.values', params).then((values) => ({ values, readAt: Date.now() }))
        : call<HistoryChanges>('history.changes', { ...params, since: sinceInstant(since, new Date()) }).then((changes) => ({ changes, readAt: Date.now() }));
    read.then(
      (v) => n === latest.current && setView(v),
      (e: unknown) => n === latest.current && setView({ error: errorText(e) }),
    );
  }, [h, done, entry, workbookId, since, finishedAt, widget.id]);
  return view;
}
