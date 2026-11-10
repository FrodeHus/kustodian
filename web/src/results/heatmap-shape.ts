import type { ResultColumn } from '../wire';
import { isNumeric, type ChartSpec, type RenderOptions } from './chart-shape';
import type { Row } from './export';

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
