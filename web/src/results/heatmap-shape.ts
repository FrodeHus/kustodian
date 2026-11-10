import type { ResultColumn } from '../wire';
import { isNumeric, type ChartSpec, type RenderOptions } from './chart-shape';
import { cellText, type Row } from './export';

/** The Chart tab's words for a result a heatmap can't draw. */
export const HEATMAP_NO_SHAPE = 'A heatmap needs two columns to lay out and a number column.';

/** The Chart tab's words for a result only a heatmap fits. */
export const HEATMAP_PICK = 'Pick Heatmap from the chart type list to chart this result.';

/** The columns that can be a heatmap's axes: every column that isn't `dynamic` and isn't the `value` column. */
export function heatmapAxes(columns: ResultColumn[], value: string | undefined): string[] {
  return columns.filter((c) => c.type !== 'dynamic' && c.name !== value).map((c) => c.name);
}

/**
 * The default columns of a heatmap: the value is the last number column; the Columns (`x`) are the first date axis column, else
 * the second axis column; the Rows (`split`) are the first axis column that isn't `x`. A `render`'s `xcolumn` and first `series`
 * override `x` and `split` when they name an axis column; if both name the same column `x` wins and `split` falls back. Null
 * when there is no number column or fewer than two axes: see {@link HEATMAP_NO_SHAPE}.
 */
export function heatmapShape(columns: ResultColumn[], _rows: Row[], options: RenderOptions = {}): ChartSpec | null {
  const value = columns.filter(isNumeric).at(-1)?.name;
  const axes = heatmapAxes(columns, value);
  if (value === undefined || axes.length < 2) {
    return null;
  }
  const dateAxis = columns.find((c) => c.type === 'datetime' && axes.includes(c.name))?.name;
  const x = axes.find((a) => a === options.xcolumn) ?? dateAxis ?? axes[1];
  const split = axes.find((a) => a === options.series?.[0] && a !== x) ?? axes.find((a) => a !== x);
  return x === undefined || split === undefined ? null : { type: 'heatmap', x, split, series: [value] };
}

export type AxisKind = 'datetime' | 'ordered' | 'text'; // ordered = number or timespan
export interface HeatmapAxis {
  column: string;
  kind: AxisKind;
  /** The cell text each row/column was built from (cellText of the value), or null for Other and for filled-in gaps. */
  keys: (string | null)[];
  /** What to show: day names for dayofweek, `Other`, otherwise the key (the view formats datetimes). */
  labels: string[];
}
export interface HeatmapCell {
  value: number;
  rows: number;
}
export interface HeatmapData {
  rows: HeatmapAxis;
  columns: HeatmapAxis;
  /** [row][column]; null is empty. */
  cells: (HeatmapCell | null)[][];
  min: number;
  max: number;
  /** The cap and limit notes, in the exact wording, in the order rows then columns. */
  notes: string[];
}

export const HEATMAP_ROW_CAP = 50;
export const HEATMAP_TEXT_COLUMN_CAP = 50;
export const HEATMAP_COLUMN_LIMIT = 2000;
export const HEATMAP_INT_GAP_LIMIT = 100;

const DAY = 86_400_000;
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const TIMESPAN = /^(-)?(?:(\d+)\.)?(\d+):(\d+):(\d+)(?:\.(\d+))?$/;

/** A timespan's text, `[-][d.]hh:mm:ss[.fffffff]`, in milliseconds; NaN when it isn't one. */
function timespanMs(text: string): number {
  const m = TIMESPAN.exec(text);
  if (!m) {
    return Number.NaN;
  }
  const ms = ((Number(m[2] ?? 0) * 24 + Number(m[3])) * 60 + Number(m[4])) * 60_000 + Number(m[5]) * 1000 + Number(`0.${m[6] ?? 0}`) * 1000;
  return m[1] ? -ms : ms;
}

/** What an ordered axis sorts by; NaN (an empty or unreadable key) sorts last. */
function orderOf(kind: AxisKind, column: ResultColumn, key: string): number {
  if (kind === 'datetime') {
    return key === '' ? Number.NaN : Date.parse(key);
  }
  return key === '' ? Number.NaN : column.type === 'timespan' ? timespanMs(key) : Number(key);
}

interface Built {
  axis: HeatmapAxis;
  /** The slot each source key lands in; a key cut by the column limit has none. */
  slot: Map<string, number>;
  note: string | null;
}

/**
 * One axis from the keys seen (first-seen order) and the total of each. Date, number and timespan keys go ascending, with
 * regular gaps filled; text keys keep first-seen order (`byTotal` ranks them busiest first) and past `cap` the rest merge into
 * Other. `limit` keeps the latest slots of an ordered axis.
 */
function buildAxis(
  column: ResultColumn,
  seen: string[],
  totals: Map<string, number>,
  opts: { byTotal: boolean; cap: number; limit: number },
): Built {
  const kind: AxisKind = column.type === 'datetime' ? 'datetime' : isNumeric(column) || column.type === 'timespan' ? 'ordered' : 'text';
  const slot = new Map<string, number>();
  let keys: (string | null)[];
  let labels: string[] | undefined;
  let note: string | null = null;
  if (kind === 'text') {
    let kept = opts.byTotal ? [...seen].sort((a, b) => (totals.get(b) ?? 0) - (totals.get(a) ?? 0)) : seen;
    if (kept.length > opts.cap) {
      const top = new Set(kept.slice(0, opts.cap));
      kept = kept.filter((k) => top.has(k));
      note = `Showing the ${opts.cap} busiest of ${seen.length} ${column.name} values. The rest are in Other.`;
    }
    kept.forEach((k, i) => slot.set(k, i));
    keys = [...kept];
    if (note) {
      seen.forEach((k) => slot.has(k) || slot.set(k, kept.length));
      keys.push(null);
      labels = [...kept, 'Other'];
    }
  } else {
    const order = new Map(seen.map((k) => [k, orderOf(kind, column, k)] as const));
    const rank = (k: string) => order.get(k) ?? Number.NaN;
    const sorted = [...seen].sort((a, b) => (Number.isNaN(rank(a)) ? 1 : 0) - (Number.isNaN(rank(b)) ? 1 : 0) || rank(a) - rank(b) || 0);
    const real = sorted.filter((k) => !Number.isNaN(order.get(k)));
    const nums = real.map((k) => order.get(k) ?? 0);
    const unique = [...new Set(nums)];
    let step = 0;
    if (unique.length > 1 && real.length === sorted.length) {
      const min = Math.min(...unique.slice(1).map((n, i) => n - (unique[i] ?? 0)));
      const regular = unique.every((n) => (n - (unique[0] ?? 0)) % min === 0);
      const span = ((unique.at(-1) ?? 0) - (unique[0] ?? 0)) / min;
      if (
        kind === 'datetime'
          ? regular
          : column.type !== 'timespan' && min === 1 && unique.every(Number.isInteger) && span + 1 - unique.length <= HEATMAP_INT_GAP_LIMIT
      ) {
        step = min;
      }
    }
    let first = 0;
    let total = sorted.length;
    if (step > 0) {
      first = unique[0] ?? 0;
      total = ((unique.at(-1) ?? 0) - first) / step + 1;
    }
    const start = Math.max(0, total - opts.limit);
    if (total > opts.limit) {
      note = `Showing the latest ${opts.limit.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} ${column.name} columns. Use a larger bin() to see them all.`;
    }
    keys = Array.from({ length: total - start }, () => null);
    if (step > 0) {
      sorted.forEach((k) => {
        const i = ((order.get(k) ?? 0) - first) / step - start;
        if (i >= 0) {
          slot.set(k, i);
          keys[i] = k;
        }
      });
      labels = keys.map((k, i) => {
        if (k !== null) {
          return k;
        }
        const v = first + (i + start) * step;
        return kind === 'datetime' ? new Date(v).toISOString() : String(v);
      });
    } else {
      sorted.slice(start).forEach((k, i) => {
        slot.set(k, i);
        keys[i] = k;
      });
    }
  }
  const days = kind === 'ordered' && column.type === 'timespan' && keys.length <= 7 && keys.every((k) => k !== null && isDayOfWeek(k));
  return {
    axis: {
      column: column.name,
      kind,
      keys,
      labels: days ? keys.map((k) => DAY_NAMES[timespanMs(k ?? '') / DAY] ?? '') : (labels ?? keys.map((k) => k ?? '')),
    },
    slot,
    note,
  };
}

const isDayOfWeek = (key: string) => {
  const ms = timespanMs(key);
  return ms >= 0 && ms % DAY === 0 && ms / DAY <= 6;
};

/**
 * The rows of a result laid out as heatmap cells: `spec.split` names the Rows column, `spec.x` the Columns, `spec.series[0]`
 * the value. Rows with the same pair sum their values (and count the rows); a pair with no row, a null value or one that isn't
 * a finite number is empty (null), where a 0 is a cell. Text axes are capped to 50 with the rest in Other; an ordered Columns
 * axis keeps its latest 2,000; whole-number axes fill gaps of up to 100 and regular datetime axes fill theirs.
 */
export function heatmapData(columns: ResultColumn[], rows: Row[], spec: ChartSpec): HeatmapData {
  const find = (name: string | null | undefined) => columns.findIndex((c) => c.name === name);
  const ri = find(spec.split);
  const ci = find(spec.x);
  const vi = find(spec.series[0]);
  const rowColumn = columns[ri] ?? { name: '', type: 'string' };
  const colColumn = columns[ci] ?? { name: '', type: 'string' };
  const rowSeen: string[] = [];
  const colSeen: string[] = [];
  const rowTotals = new Map<string, number>();
  const colTotals = new Map<string, number>();
  const pairs: { r: string; c: string; v: number }[] = [];
  const see = (list: string[], totals: Map<string, number>, key: string, v: number) => {
    if (!totals.has(key)) {
      list.push(key);
    }
    totals.set(key, (totals.get(key) ?? 0) + (Number.isFinite(v) ? v : 0));
  };
  for (const row of rows) {
    const r = cellText(row[ri]);
    const c = cellText(row[ci]);
    const raw = row[vi];
    const v = raw === null || raw === undefined || raw === '' ? Number.NaN : Number(raw);
    see(rowSeen, rowTotals, r, v);
    see(colSeen, colTotals, c, v);
    if (Number.isFinite(v)) {
      pairs.push({ r, c, v });
    }
  }
  const rowAxis = buildAxis(rowColumn, rowSeen, rowTotals, { byTotal: true, cap: HEATMAP_ROW_CAP, limit: Infinity });
  const colAxis = buildAxis(colColumn, colSeen, colTotals, { byTotal: false, cap: HEATMAP_TEXT_COLUMN_CAP, limit: HEATMAP_COLUMN_LIMIT });
  const cells: (HeatmapCell | null)[][] = rowAxis.axis.keys.map(() => colAxis.axis.keys.map(() => null));
  for (const { r, c, v } of pairs) {
    const line = cells[rowAxis.slot.get(r) ?? -1];
    const at = colAxis.slot.get(c);
    if (line && at !== undefined) {
      const cell = line[at];
      line[at] = { value: (cell?.value ?? 0) + v, rows: (cell?.rows ?? 0) + 1 };
    }
  }
  const values = cells.flat().flatMap((c) => (c ? [c.value] : []));
  return {
    rows: rowAxis.axis,
    columns: colAxis.axis,
    cells,
    min: values.length > 0 ? Math.min(...values) : 0,
    max: values.length > 0 ? Math.max(...values) : 0,
    notes: [rowAxis.note, colAxis.note].filter((n): n is string => n !== null),
  };
}

/** 0..1 colour strength for a value: sqrt((v - lo) / (max - lo)) with lo = min(0, min); 1 when max === lo. */
export function heatStrength(value: number, min: number, max: number): number {
  const lo = Math.min(0, min);
  return max === lo ? 1 : Math.sqrt((value - lo) / (max - lo));
}
