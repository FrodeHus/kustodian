import type { ResultColumn } from '../wire';
import { dateTick } from './chart-style';
import { isNumeric, type Better, type ChartSpec, type Picked, type RenderOptions } from './chart-shape';
import { cellText, type Row } from './export';

/** The Chart tab's words for a result a gauge can't draw. */
export const GAUGE_NO_SHAPE = 'A gauge needs a number column.';

/** The Chart tab's words for a result only a gauge fits. */
export const GAUGE_PICK = 'Pick Gauge from the chart type list to chart this result.';

/** The Chart tab's words for a result a heatmap or a gauge fits. */
export const ANY_PICK = 'Pick Heatmap or Gauge from the chart type list to chart this result.';

export const GAUGE_CAP = 24;

/** The columns that can label a gauge: every column that isn't `dynamic` and isn't the `value` column. */
export function gaugeLabels(columns: ResultColumn[], value: string | undefined): string[] {
  return columns.filter((c) => c.type !== 'dynamic' && c.name !== value).map((c) => c.name);
}

/**
 * The default columns of a gauge: the value is the last number column; the label is the first text column, else the first
 * date column, else none. A `render`'s `xcolumn` and first `ycolumns` override them when they name a valid column. Null when
 * there is no number column: see {@link GAUGE_NO_SHAPE}.
 */
export function gaugeShape(columns: ResultColumn[], options: RenderOptions = {}): ChartSpec | null {
  const numbers = columns.filter(isNumeric);
  const value = numbers.find((c) => c.name === options.ycolumns?.[0])?.name ?? numbers.at(-1)?.name;
  if (value === undefined) {
    return null;
  }
  const labels = gaugeLabels(columns, value);
  const named = (type: string) => columns.find((c) => c.type === type && labels.includes(c.name))?.name;
  const x = labels.find((l) => l === options.xcolumn) ?? named('string') ?? named('datetime') ?? null;
  return { type: 'gauge', x, series: [value], split: null };
}

/** The scale of a gauge: 0-100 unless picked. `valid` is false when max is not above min (the default range is used then). */
export function gaugeRange(picked: Picked): { min: number; max: number; valid: boolean } {
  const min = picked.min ?? 0;
  const max = picked.max ?? 100;
  return max > min ? { min, max, valid: true } : { min: 0, max: 100, valid: false };
}

/** A value with at most one decimal and no trailing `.0`. */
export const gaugeText = (value: number) => String(Math.round(value * 10) / 10);

export interface Gauge {
  /** The raw cell text of the label, for filtering. */
  key: string;
  label: string;
  value: number | null;
  text: string;
  /** 0..1 along the ring. */
  fill: number;
  /** Whether the value is on the good side of the target; null with no target or no value. */
  good: boolean | null;
  aria: string;
}

export interface GaugeData {
  gauges: Gauge[];
  total: number;
  note?: string;
  labelColumn: string | null;
  valueColumn: string;
  target?: number;
  targetFill?: number;
  better: Better;
  min: number;
  max: number;
}

/** A cell as a number; NaN for null, '' and anything else that isn't one (Number would read null and '' as 0). */
const numberOf = (cell: unknown) =>
  cell === null || cell === undefined || (typeof cell === 'string' && cell.trim() === '') ? Number.NaN : Number(cell);

const clamp = (n: number) => Math.min(1, Math.max(0, n));

/**
 * The first {@link GAUGE_CAP} rows of a result as gauges: `spec.x` labels each (or `Row n`), `spec.series[0]` is the value,
 * placed on the `picked` range and judged against the `picked` target in the `picked` direction (higher by default).
 */
export function gaugeData(columns: ResultColumn[], rows: Row[], spec: ChartSpec, picked: Picked): GaugeData {
  const li = columns.findIndex((c) => c.name === spec.x);
  const vi = columns.findIndex((c) => c.name === spec.series[0]);
  const dated = columns[li]?.type === 'datetime';
  const { min, max } = gaugeRange(picked);
  const better = picked.better ?? 'higher';
  const { target } = picked;
  const place = (v: number) => clamp((v - min) / (max - min));
  const gauges = rows.slice(0, GAUGE_CAP).map((row, i): Gauge => {
    const key = li < 0 ? '' : cellText(row[li]);
    const label = li < 0 ? `Row ${i + 1}` : dated && key !== '' ? dateTick(key) : key;
    const v = numberOf(row[vi]);
    if (!Number.isFinite(v)) {
      return { key, label, value: null, text: '–', fill: 0, good: null, aria: `${label}: no value` };
    }
    const text = gaugeText(v);
    if (target === undefined) {
      return { key, label, value: v, text, fill: place(v), good: null, aria: `${label}: ${text}` };
    }
    const where = v < target ? 'below' : v > target ? 'above' : 'at';
    const aria = `${label}: ${text}, desired ${target}, ${better} is better, ${where} target`;
    return { key, label, value: v, text, fill: place(v), good: better === 'higher' ? v >= target : v <= target, aria };
  });
  const total = rows.length;
  const n = total.toLocaleString('en-US');
  const note =
    total <= GAUGE_CAP
      ? undefined
      : dated
        ? `Showing ${GAUGE_CAP} of ${n} rows. Add \`top 1 by ${spec.x}\` (or a filter) to show fewer.`
        : `Showing ${GAUGE_CAP} of ${n} rows. Add \`take\`, \`top\` or a filter to show fewer.`;
  return {
    gauges,
    total,
    ...(note !== undefined && { note }),
    labelColumn: li < 0 ? null : (spec.x ?? null),
    valueColumn: spec.series[0] ?? '',
    ...(target !== undefined && { target, targetFill: place(target) }),
    better,
    min,
    max,
  };
}
