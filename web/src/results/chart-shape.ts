import type { ResultColumn } from '../wire';
import { cellText, type Row } from './export';

export type ChartType = 'column' | 'bar' | 'line' | 'area' | 'pie' | 'timechart';

/** What to chart: its type, the column along the x axis (or the pie's slices), and the number columns to plot. */
export interface ChartSpec {
  type: ChartType;
  x: string;
  series: string[];
}

export const CHART_TYPES: { type: ChartType; name: string }[] = [
  { type: 'column', name: 'Column' },
  { type: 'bar', name: 'Bar' },
  { type: 'line', name: 'Line' },
  { type: 'area', name: 'Area' },
  { type: 'pie', name: 'Pie' },
  { type: 'timechart', name: 'Time chart' },
];

/** The Chart tab's words for a result it can't chart. */
export const NO_SHAPE = 'This result has no shape to chart: it needs a text or date column and a number column.';

/** KQL's `render` visualizations, and the chart each one picks. */
export const RENDER_HINTS: Record<string, ChartType> = {
  columnchart: 'column',
  barchart: 'bar',
  linechart: 'line',
  areachart: 'area',
  piechart: 'pie',
  timechart: 'timechart',
};

const RENDER = /\|\s*render\s+(\w+)/i;

/** The chart a query's `| render` asks for: from the last line that has one, leaving out comment lines. Undefined when there
 * is none, or it names a visualization Kustodian doesn't draw. */
export function renderHint(kql: string): ChartType | undefined {
  const line = kql
    .split(/\r\n|\r|\n/)
    .filter((l) => !l.trimStart().startsWith('//') && RENDER.test(l))
    .at(-1);
  const word = line?.match(RENDER)?.[1]?.toLowerCase();
  return word ? RENDER_HINTS[word] : undefined;
}

const NUMERIC = new Set(['int', 'long', 'real', 'decimal', 'double']);
const isNumeric = (c: ResultColumn) => NUMERIC.has(c.type);
const isDate = (c: ResultColumn) => c.type === 'datetime';
const isText = (c: ResultColumn) => c.type === 'string';

/**
 * How to chart a result. A `renderHint` picks the type: the x axis is the first date column (the first text column for a pie),
 * else the first text column, else the first column that isn't a number; the series are the number columns. With no hint, a
 * date column and number columns make a time chart, and one text column and one number column make a column chart (20 rows or
 * fewer) or a bar chart. Anything else is null: see {@link NO_SHAPE}.
 */
export function chartShape(columns: ResultColumn[], rows: Row[], renderHint?: ChartType): ChartSpec | null {
  const numbers = columns.filter(isNumeric);
  const dates = columns.filter(isDate);
  const texts = columns.filter(isText);
  if (renderHint) {
    const x =
      renderHint === 'pie'
        ? (texts[0] ?? dates[0] ?? columns.find((c) => !isNumeric(c)))
        : (dates[0] ?? texts[0] ?? columns.find((c) => !isNumeric(c)));
    const series = numbers.filter((c) => c !== x).map((c) => c.name);
    return x && series.length > 0 ? { type: renderHint, x: x.name, series: renderHint === 'pie' ? series.slice(0, 1) : series } : null;
  }
  const date = dates[0];
  if (date && numbers.length > 0) {
    return { type: 'timechart', x: date.name, series: numbers.map((c) => c.name) };
  }
  const text = texts[0];
  const number = numbers[0];
  if (texts.length === 1 && numbers.length === 1 && text && number) {
    return { type: rows.length <= 20 ? 'column' : 'bar', x: text.name, series: [number.name] };
  }
  return null;
}

/** One point along the x axis: `x`, and a value for each series by its name. (Kept apart from `x`, and read by function rather
 * than by a Recharts key path, so a series called "x" or "a.b" draws as itself.) */
export interface ChartPoint {
  x: string;
  values: Record<string, unknown>;
}

/**
 * The points to draw, one per x value in the order they first appear. A single series is split into one series per value of
 * the result's one other text column, when it has one (as `summarize count() by app, bin(day)` charts a series per app);
 * otherwise each row is a point and the series are the spec's.
 */
export function chartData(columns: ResultColumn[], rows: Row[], spec: ChartSpec): { series: string[]; data: ChartPoint[] } {
  const index = (name: string) => columns.findIndex((c) => c.name === name);
  const xAt = index(spec.x);
  const splits = columns.filter((c) => isText(c) && c.name !== spec.x);
  const split = spec.series.length === 1 && spec.type !== 'pie' && splits.length === 1 ? splits[0] : undefined;

  if (!split) {
    const at = spec.series.map(index);
    return {
      series: spec.series,
      data: rows.map((row) => ({ x: cellText(row[xAt]), values: Object.fromEntries(spec.series.map((s, i) => [s, row[at[i] ?? -1] ?? null])) })),
    };
  }

  const valueAt = index(spec.series[0] ?? '');
  const splitAt = index(split.name);
  const series = new Set<string>();
  const points = new Map<string, ChartPoint>();
  for (const row of rows) {
    const x = cellText(row[xAt]);
    const name = cellText(row[splitAt]);
    series.add(name);
    const point = points.get(x) ?? { x, values: {} };
    point.values[name] = row[valueAt] ?? null;
    points.set(x, point);
  }
  return { series: [...series], data: [...points.values()] };
}
