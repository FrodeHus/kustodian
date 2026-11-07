import type { Row } from '../results/export';
import type { ToolButton } from './model';

export interface RowSelection {
  selected: readonly number[];
  /** Row indexes in the order the grid shows them; null: every row. */
  shown: readonly number[] | null;
}

export interface ToolTarget {
  rows: Row[]; // in shown order; empty means the button is off
  count: string; // '2' | 'all 14'
  heading: string; // 'on 2 selected rows' | 'on all 14 rows' | 'on 1 selected row'
}

/** The rows a tool button runs on: the selected ones that are shown, else (selectedOrAll) every shown row. */
export function toolTarget(runsOn: ToolButton['runsOn'], rows: Row[], selection: RowSelection): ToolTarget {
  const shown = selection.shown ?? rows.map((_, i) => i);
  const chosen = new Set(selection.selected);
  const picked = shown.filter((i) => chosen.has(i));
  if (picked.length > 0 || runsOn === 'selected') {
    const n = picked.length;
    return { rows: picked.map((i) => rows[i]!), count: String(n), heading: `on ${n} selected row${n === 1 ? '' : 's'}` };
  }
  return { rows: shown.map((i) => rows[i]!), count: `all ${shown.length}`, heading: `on all ${shown.length} rows` };
}
