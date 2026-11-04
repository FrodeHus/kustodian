import type { ResultColumn } from '../wire';
import { cellText, type Row } from './export';

export type ChartType = 'column' | 'bar' | 'line' | 'area' | 'pie' | 'timechart';

/** What to chart: its type, the column along the x axis (or the pie's slices), and the number columns to plot. An `x` of null
 * puts the series' names along the axis instead, each drawn with its value from the result's first row. `split` names the
 * category column whose values become series (see {@link splitColumn}): null for none, left out to let the result decide. */
export interface ChartSpec {
  type: ChartType;
  x: string | null;
  series: string[];
  split?: string | null;
}

/** The one series of a chart whose x axis is the series' names ({@link ChartSpec} `x` of null). */
export const VALUE_SERIES = 'Value';

export const CHART_TYPES: { type: ChartType; name: string }[] = [
  { type: 'column', name: 'Column' },
  { type: 'bar', name: 'Bar' },
  { type: 'line', name: 'Line' },
  { type: 'area', name: 'Area' },
  { type: 'pie', name: 'Pie' },
  { type: 'timechart', name: 'Time chart' },
];

/** The Chart tab's words for a result it can't chart. */
export const NO_SHAPE = 'This result has no shape to chart: it needs a text, true/false or date column and a number column.';

/** KQL's `render` visualizations, and the chart each one picks. */
export const RENDER_HINTS: Record<string, ChartType> = {
  columnchart: 'column',
  barchart: 'bar',
  linechart: 'line',
  areachart: 'area',
  piechart: 'pie',
  timechart: 'timechart',
};

const RENDER = /\|\s*render\s+(\w+)/gi;

/** A line without its trailing `//` comment. A `//` inside a quoted string (such as a URL) is not a comment. */
function withoutComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === '\\') {
        i++;
      } else if (ch === quote) {
        quote = null;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '/' && line[i + 1] === '/') {
      return line.slice(0, i);
    }
  }
  return line;
}

/** A query's last `| render`, leaving out comments: its visualization, and the text after it. */
function lastRender(kql: string): { word: string; rest: string } | undefined {
  const text = kql.split(/\r\n|\r|\n/).map(withoutComment).join('\n');
  const match = [...text.matchAll(RENDER)].at(-1);
  return match?.[1] ? { word: match[1].toLowerCase(), rest: text.slice(match.index + match[0].length) } : undefined;
}

/** The chart a query's `| render` asks for: from the last one, leaving out comments. Undefined when there is none, or it names
 * a visualization Kustodian doesn't draw. */
export function renderHint(kql: string): ChartType | undefined {
  const word = lastRender(kql)?.word;
  return word ? RENDER_HINTS[word] : undefined;
}

/** How bars and areas share the value axis: side by side (or overlapping), stacked, or stacked to 100%. */
export type Stack = 'none' | 'stacked' | 'stacked100';

/** The `with (...)` properties of a query's `| render` that the Chart tab follows. Column names are as written; ones the
 * result doesn't have are ignored where they're used. */
export interface RenderOptions {
  xcolumn?: string;
  ycolumns?: string[];
  series?: string[];
  title?: string;
  stack?: Stack;
}

/** A property value without its quotes, or a `['name']` column name without its brackets. */
function unquote(value: string): string {
  const quoted = /^\[?\s*(["'])([\s\S]*)\1\s*\]?$/.exec(value);
  return quoted?.[2] !== undefined ? quoted[2].replace(/\\(.)/g, '$1') : value;
}

/**
 * The properties of the last `| render ... with (name=value, ...)`. A comma separates properties and also the names in a list
 * (`ycolumns=a, b`): a part with no `name=` of its own belongs to the property before it. Commas and parentheses inside quotes
 * are text. `kind` gives the stacking: `stacked`, `stacked100`, otherwise none.
 */
export function renderOptions(kql: string): RenderOptions {
  const rest = lastRender(kql)?.rest ?? '';
  const open = /^\s*with\s*\(/i.exec(rest);
  if (!open) {
    return {};
  }
  const props = new Map<string, string[]>();
  let last: string[] | undefined;
  let part = '';
  const flush = () => {
    const text = part.trim();
    part = '';
    const named = /^(\w+)\s*=\s*([\s\S]*)$/.exec(text);
    if (named?.[1] && named[2] !== undefined) {
      last = [unquote(named[2].trim())];
      props.set(named[1].toLowerCase(), last);
    } else if (text) {
      last?.push(unquote(text));
    }
  };
  let quote: string | null = null;
  for (let i = open[0].length; i < rest.length; i++) {
    const ch = rest[i] ?? '';
    if (quote) {
      if (ch === '\\') {
        part += ch + (rest[++i] ?? '');
        continue;
      }
      if (ch === quote) {
        quote = null;
      }
      part += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      part += ch;
    } else if (ch === ',' || ch === ')') {
      flush();
      if (ch === ')') {
        break;
      }
    } else {
      part += ch;
    }
  }
  const kind = props.get('kind')?.[0]?.toLowerCase();
  return {
    xcolumn: props.get('xcolumn')?.[0],
    ycolumns: props.get('ycolumns'),
    series: props.get('series'),
    title: props.get('title')?.[0],
    stack: kind === 'stacked' || kind === 'stacked100' ? kind : undefined,
  };
}

const NUMERIC = new Set(['int', 'long', 'real', 'decimal', 'double']);
export const isNumeric = (c: ResultColumn) => NUMERIC.has(c.type);
const isDate = (c: ResultColumn) => c.type === 'datetime';
const isText = (c: ResultColumn) => c.type === 'string';
/** A column whose values name groups: text first, then the other single values (true/false, GUIDs, durations). Not `dynamic`,
 * whose arrays and objects make poor labels. */
const CATEGORY = ['string', 'bool', 'guid', 'timespan'];
export const isCategory = (c: ResultColumn) => CATEGORY.includes(c.type);
const byCategory = (a: ResultColumn, b: ResultColumn) => CATEGORY.indexOf(a.type) - CATEGORY.indexOf(b.type);

/**
 * How to chart a result. A single row with two or more number columns charts those columns side by side (`x` of null), as a
 * column chart unless a `renderHint` picks another type. Otherwise a `renderHint` picks the type: the x axis is the first date column (the first category column for a
 * pie), else the first category column (text before true/false, GUID and duration), else the first column that isn't a number;
 * the series are the number columns. With no hint, a date column and number columns make a time chart, one category column
 * and one number column make a column chart (20 rows or fewer) or a bar chart, and two or more category columns with number
 * columns make the same, along the first and split by the second. Anything else is null: see {@link NO_SHAPE}.
 *
 * A `render`'s `options` then name the x axis (`xcolumn`), the number columns (`ycolumns`) and the split (the first `series`
 * column that is a category column), where the result has those columns.
 */
export function chartShape(columns: ResultColumn[], rows: Row[], renderHint?: ChartType, options: RenderOptions = {}): ChartSpec | null {
  const named = (name?: string) => columns.find((c) => c.name === name);
  const xcolumn = named(options.xcolumn);
  const spec = baseShape(columns, rows, renderHint, xcolumn);
  if (!spec) {
    return null;
  }
  const x = xcolumn?.name ?? spec.x;
  const ycolumns = (options.ycolumns ?? []).filter((n) => {
    const c = named(n);
    return c !== undefined && c.name !== x && isNumeric(c);
  });
  const series = ycolumns.length > 0 ? ycolumns : spec.series.filter((s) => s !== x);
  const split = options.series?.map(named).find((c) => c && isCategory(c) && c.name !== x)?.name;
  return series.length > 0 ? { ...spec, x, series: spec.type === 'pie' ? series.slice(0, 1) : series, ...(split ? { split } : {}) } : null;
}

/** {@link chartShape} before a `render`'s options, but for an `xcolumn` the hint's x axis is that column. */
function baseShape(columns: ResultColumn[], rows: Row[], renderHint: ChartType | undefined, xcolumn: ResultColumn | undefined): ChartSpec | null {
  const numbers = columns.filter(isNumeric);
  const dates = columns.filter(isDate);
  const categories = columns.filter(isCategory).sort(byCategory);
  if (rows.length === 1 && numbers.length > 1) {
    return { type: renderHint ?? 'column', x: null, series: numbers.map((c) => c.name) };
  }
  if (renderHint) {
    const x =
      xcolumn ??
      (renderHint === 'pie'
        ? (categories[0] ?? dates[0] ?? columns.find((c) => !isNumeric(c)))
        : (dates[0] ?? categories[0] ?? columns.find((c) => !isNumeric(c))));
    const series = numbers.filter((c) => c !== x).map((c) => c.name);
    return x && series.length > 0 ? { type: renderHint, x: x.name, series: renderHint === 'pie' ? series.slice(0, 1) : series } : null;
  }
  const date = dates[0];
  if (date && numbers.length > 0) {
    return { type: 'timechart', x: date.name, series: numbers.map((c) => c.name) };
  }
  const category = categories[0];
  const number = numbers[0];
  if (categories.length === 1 && numbers.length === 1 && category && number) {
    return { type: rows.length <= 20 ? 'column' : 'bar', x: category.name, series: [number.name] };
  }
  const split = categories[1];
  if (category && split && numbers.length > 0) {
    return { type: rows.length <= 20 ? 'column' : 'bar', x: category.name, series: numbers.map((c) => c.name), split: split.name };
  }
  return null;
}

/** The rows in order of `key`, rows whose key isn't a number last, keeping their order otherwise. */
function sortBy(rows: Row[], key: (row: Row) => number): Row[] {
  return rows
    .map((row) => ({ row, k: key(row) }))
    .sort((a, b) => (Number.isNaN(a.k) ? (Number.isNaN(b.k) ? 0 : 1) : Number.isNaN(b.k) ? -1 : a.k - b.k))
    .map((e) => e.row);
}

/** One point along the x axis: `x`, and a value for each series by its name. (Kept apart from `x`, and read by function rather
 * than by a Recharts key path, so a series called "x" or "a.b" draws as itself.) */
export interface ChartPoint {
  x: string;
  values: Record<string, unknown>;
}

/**
 * The category column whose values become series: the spec's `split` when it names a category column other than `x`, none
 * when it is null or the chart is a pie or has the series' names along its axis. Left out, a single series is split by the
 * result's one other text column, when it has one (as `summarize count() by app, bin(day)` charts a series per app), or else
 * its one other category column (as `by enabled, bin(day)` charts a series for true and one for false).
 */
export function splitColumn(columns: ResultColumn[], spec: ChartSpec): ResultColumn | undefined {
  if (spec.split === null || spec.type === 'pie' || spec.x === null) {
    return undefined;
  }
  const others = columns.filter((c) => isCategory(c) && c.name !== spec.x);
  if (spec.split !== undefined) {
    return others.find((c) => c.name === spec.split);
  }
  const texts = others.filter(isText);
  const splits = texts.length > 0 ? texts : others;
  return spec.series.length === 1 && splits.length === 1 ? splits[0] : undefined;
}

/**
 * The points to draw, one per x value in the order they first appear. With a {@link splitColumn}, each series is drawn once per
 * value of that column (named by the value, and by the series too when there are several); otherwise each row is a point and
 * the series are the spec's.
 */
export function chartData(columns: ResultColumn[], unsorted: Row[], spec: ChartSpec): { series: string[]; data: ChartPoint[] } {
  const index = (name: string) => columns.findIndex((c) => c.name === name);
  if (spec.x === null) {
    const row = unsorted[0] ?? [];
    return { series: [VALUE_SERIES], data: spec.series.map((s) => ({ x: s, values: { [VALUE_SERIES]: row[index(s)] ?? null } })) };
  }
  const xAt = index(spec.x);
  const xColumn = columns[xAt];
  // Along a date or number axis the points go in order of x, however the rows came.
  const order = xColumn && isDate(xColumn) ? (v: unknown) => Date.parse(String(v)) : xColumn && isNumeric(xColumn) ? Number : undefined;
  const rows = order ? sortBy(unsorted, (row) => (row[xAt] === null || row[xAt] === undefined ? NaN : order(row[xAt]))) : unsorted;
  const split = splitColumn(columns, spec);

  if (!split) {
    const at = spec.series.map(index);
    return {
      series: spec.series,
      data: rows.map((row) => ({ x: cellText(row[xAt]), values: Object.fromEntries(spec.series.map((s, i) => [s, row[at[i] ?? -1] ?? null])) })),
    };
  }

  const splitAt = index(split.name);
  const series = new Set<string>();
  const points = new Map<string, ChartPoint>();
  for (const row of rows) {
    const x = cellText(row[xAt]);
    const point = points.get(x) ?? { x, values: {} };
    for (const s of spec.series) {
      const name = spec.series.length > 1 ? `${cellText(row[splitAt])} · ${s}` : cellText(row[splitAt]);
      series.add(name);
      point.values[name] = row[index(s)] ?? null;
    }
    points.set(x, point);
  }
  return { series: [...series], data: [...points.values()] };
}
