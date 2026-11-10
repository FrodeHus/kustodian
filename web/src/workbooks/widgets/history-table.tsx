import { useContext, useState, type ReactNode } from 'react';
import { ResultGrid } from '../../results/result-grid';
import type { ResultColumn, TrackedRow } from '../../wire';
import { HistoryData, type HistoryFilter } from '../history';
import { useWorkbooks } from '../workbook-store';

const number = (n: number) => n.toLocaleString('en-US');
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The widget's Since: a choice, or a date. It sets the view's Since only; nothing reruns, the history view refetches. */
export function SinceSelect({ tabId, widgetId, since }: { tabId: string; widgetId: string; since: string }) {
  const [picking, setPicking] = useState(DATE.test(since));
  const set = (s: string) => useWorkbooks.getState().setSince(tabId, widgetId, s);
  return (
    <span className="flex items-center gap-1">
      <select
        className="textbox"
        style={{ height: 24 }}
        aria-label="Since"
        value={picking ? 'date' : since}
        onChange={(e) => {
          const v = e.target.value;
          setPicking(v === 'date');
          if (v !== 'date') {
            set(v);
          }
        }}
      >
        <option value="previous">Previous snapshot</option>
        <option value="P1D">Yesterday</option>
        <option value="P7D">7 days ago</option>
        <option value="P30D">30 days ago</option>
        <option value="date">A date…</option>
      </select>
      {picking && (
        <input
          type="date"
          className="textbox"
          style={{ height: 24 }}
          aria-label="Since date"
          value={DATE.test(since) ? since : ''}
          onChange={(e) => DATE.test(e.target.value) && set(e.target.value)}
        />
      )}
    </span>
  );
}

const ADDED: ResultColumn[] = [
  { name: 'Change', type: 'string' },
  { name: 'First seen', type: 'datetime' },
  { name: 'No longer reported', type: 'datetime' },
];
const rowsOf = (rows: TrackedRow[], change: string) => rows.map((r) => [...r.values, change, r.firstSeen, r.gone]);

/**
 * A Row tracking table (screen 8): Open now is `open`, the run's grid with its selection and tools; New since, No longer
 * reported since and Both show the tracked rows, with what changed and when, and no selection (a tool can't act on them).
 */
export function HistoryTable({
  tabId,
  widgetId,
  since,
  rowCount,
  open,
}: {
  tabId: string;
  widgetId: string;
  since: string;
  rowCount: number;
  open: ReactNode;
}) {
  const { changes, filter: chosen, setFilter } = useContext(HistoryData);
  // Until the changes are read (or when reading failed) only Open now can show.
  const filter = changes ? chosen : 'open';
  const news = changes ? rowsOf(changes.new, 'new') : [];
  const gone = changes ? rowsOf(changes.gone, 'no longer reported') : [];
  const shown = filter === 'new' ? news : filter === 'gone' ? gone : [...news, ...gone];
  const newCount = changes?.newCount ?? 0;
  const goneCount = changes?.goneCount ?? 0;
  const total = filter === 'new' ? newCount : filter === 'gone' ? goneCount : newCount + goneCount;
  const choices: [HistoryFilter, string][] = [
    ['open', `Open now (${number(rowCount)})`],
    ['new', `New since (${number(newCount)})`],
    ['gone', `No longer reported since (${number(goneCount)})`],
    ['both', 'Both'],
  ];
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 px-3 pb-2 text-[12px]">
        {changes && (
          <div className="flex flex-wrap gap-1" role="group" aria-label="Show">
            {choices.map(([f, label]) => (
              <button key={f} type="button" className="btn ghost" aria-pressed={filter === f} onClick={() => setFilter(f)}>
                {label}
              </button>
            ))}
          </div>
        )}
        <SinceSelect tabId={tabId} widgetId={widgetId} since={since} />
        {filter !== 'open' && shown.length < total && (
          <span className="faint text-[11.5px]">
            Showing {number(shown.length)} of {number(total)}
          </span>
        )}
      </div>
      {filter === 'open' || !changes ? (
        open
      ) : (
        <ResultGrid key={filter} columns={[...changes.columns, ...ADDED]} rows={shown} selection="none" />
      )}
    </div>
  );
}
