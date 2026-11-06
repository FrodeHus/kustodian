import { isNumeric } from '../../results/chart-shape';
import type { Widget } from '../model';
import type { WidgetRun } from '../workbook-store';

const number = (n: number) => n.toLocaleString('en-US');

/** A stat widget: the first row's value column (the first number column unless set), and its change against `stat.compare`. */
export function StatWidget({ widget, run }: { widget: Widget; run: WidgetRun }) {
  if (run.state !== 'done') {
    return null;
  }
  const { columns, rows } = run.result;
  const at = (name: string | null | undefined) => (name ? columns.findIndex((c) => c.name === name) : -1);
  const valueAt = widget.stat?.value ? at(widget.stat.value) : columns.findIndex(isNumeric);
  const value = Number(rows[0]?.[valueAt]);
  if (valueAt < 0 || rows.length === 0 || !Number.isFinite(value)) {
    return <p className="faint m-0 p-4 text-[12px]">No number to show.</p>;
  }
  const compareAt = at(widget.stat?.compare);
  const compare = compareAt < 0 ? NaN : Number(rows[0]?.[compareAt]);
  let change = null;
  if (Number.isFinite(compare)) {
    const diff = value - compare;
    const share = compare === 0 ? '' : ` (${Math.round((Math.abs(diff) / Math.abs(compare)) * 100)}%)`;
    change = `${diff < 0 ? '▼' : '▲'} ${number(Math.abs(diff))}${share}`;
  }
  return (
    <div className="flex flex-1 flex-col justify-center gap-1 px-4 pb-3">
      <span className="text-[28px] font-semibold tabular-nums">{number(value)}</span>
      {change && <span className="muted text-[12px] tabular-nums">{change}</span>}
    </div>
  );
}
