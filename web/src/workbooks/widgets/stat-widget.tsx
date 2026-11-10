import { useContext } from 'react';
import { isNumeric } from '../../results/chart-shape';
import { HistoryData, numberOf, sinceWords, statChange } from '../history';
import type { Widget } from '../model';
import { useWorkbooks, type WidgetRun } from '../workbook-store';
import { SinceSelect } from './history-table';

const number = (n: number) => n.toLocaleString('en-US');

/** A stat widget: the first row's value column (the first number column unless set), and its change against `stat.compare`.
 * With Values history the change is against the snapshot at Since instead; with Row tracking the number is this run's rows, and
 * the line counts the new and gone ones. Since is chosen under it (a `tabId` only: the editor's preview has no history). */
export function StatWidget({ widget, run, tabId }: { widget: Widget; run: WidgetRun; tabId?: string }) {
  const { values, changes, readAt } = useContext(HistoryData);
  const chosen = useWorkbooks((s) => (tabId ? s.byTab[tabId]?.since[widget.id] : undefined));
  if (run.state !== 'done') {
    return null;
  }
  const h = tabId !== undefined && widget.history ? { mode: widget.history.mode, since: chosen ?? widget.history.since } : null;
  const { columns, rows } = run.result;
  const at = (name: string | null | undefined) => (name ? columns.findIndex((c) => c.name === name) : -1);
  const valueAt = widget.stat?.value ? at(widget.stat.value) : columns.findIndex(isNumeric);
  let value = numberOf(rows[0]?.[valueAt]);
  let change: string | null = null;
  if (h?.mode === 'rows') {
    // This run's rows: stored history can be an earlier run's (one record per interval, or this one not kept).
    value = rows.length;
    change = changes
      ? `${number(changes.newCount)} new · ${number(changes.goneCount)} no longer reported since ${sinceWords(h.since)}`
      : null;
  } else if (valueAt < 0 || rows.length === 0 || !Number.isFinite(value)) {
    return <p className="faint m-0 p-4 text-[12px]">No number to show.</p>;
  } else if (h) {
    // The number shown is this run's, recorded or not; snapshots from its finish on are its own record.
    const live = { value, at: run.finishedAt ?? readAt ?? 0 };
    change = values ? (statChange(values, columns[valueAt]!.name, h.since, new Date(readAt ?? 0), live)?.text ?? null) : null;
  } else {
    const compareAt = at(widget.stat?.compare);
    const compare = compareAt < 0 ? NaN : numberOf(rows[0]?.[compareAt]);
    if (Number.isFinite(compare)) {
      const diff = value - compare;
      const share = compare === 0 ? '' : ` (${Math.round((Math.abs(diff) / Math.abs(compare)) * 100)}%)`;
      change = `${diff < 0 ? '▼' : '▲'} ${number(Math.abs(diff))}${share}`;
    }
  }
  return (
    <div className="flex flex-1 flex-col justify-center gap-1 px-4 pb-3">
      <span className="text-[28px] font-semibold tabular-nums">{number(value)}</span>
      {change && <span className="muted text-[12px] tabular-nums">{change}</span>}
      {h && tabId !== undefined && (
        <div className="mt-1">
          <SinceSelect tabId={tabId} widgetId={widget.id} since={h.since} />
        </div>
      )}
    </div>
  );
}
