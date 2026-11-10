import { describe, expect, it } from 'vitest';
import { heatmapAxes, heatmapData, heatmapShape, heatStrength } from './heatmap-shape';
import type { ChartSpec } from './chart-shape';

const col = (name: string, type: string) => ({ name, type });

describe('heatmapShape', () => {
  it('heatmap_shape_defaults', () => {
    expect(heatmapShape([col('Day', 'timespan'), col('Hour', 'int'), col('count_', 'long')], [])).toEqual({
      type: 'heatmap',
      x: 'Hour',
      split: 'Day',
      series: ['count_'],
    });
    expect(heatmapShape([col('Computer', 'string'), col('TimeGenerated', 'datetime'), col('count_', 'long')], [])).toMatchObject({
      x: 'TimeGenerated',
      split: 'Computer',
    });
    expect(heatmapShape([col('type', 'string'), col('location', 'string'), col('n', 'long')], [])).toMatchObject({
      x: 'location',
      split: 'type',
      series: ['n'],
    });
    expect(heatmapAxes([col('a', 'string'), col('d', 'dynamic'), col('n', 'long')], 'n')).toEqual(['a']);
  });

  it('heatmap_shape_render_options', () => {
    const cols = [col('a', 'string'), col('b', 'string'), col('n', 'long')];
    expect(heatmapShape(cols, [], { xcolumn: 'a', series: ['b'] })).toMatchObject({ x: 'a', split: 'b' });
    expect(heatmapShape(cols, [], { xcolumn: 'a', series: ['a'] })).toMatchObject({ x: 'a', split: 'b' });
  });

  it('heatmap_shape_needs_two_axes_and_a_number', () => {
    expect(heatmapShape([col('a', 'string'), col('n', 'long')], [])).toBeNull();
    expect(heatmapShape([col('a', 'string'), col('b', 'string')], [])).toBeNull();
  });
});

const spec = (): ChartSpec => ({ type: 'heatmap', x: 'c', split: 'r', series: ['v'] });
const cols = (r: string, c: string) => [col('r', r), col('c', c), col('v', 'long')];
const hours = (n: number, from = 0) => Array.from({ length: n }, (_, i) => new Date(Date.UTC(2026, 0, 1, from + i)).toISOString());

describe('heatmapData', () => {
  it('heatmap_data_sums_duplicates_and_counts_rows', () => {
    const d = heatmapData(
      cols('string', 'string'),
      [
        ['a', 'x', 2],
        ['a', 'x', 3],
      ],
      spec(),
    );
    expect(d.cells).toEqual([[{ value: 5, rows: 2 }]]);
    expect([d.min, d.max]).toEqual([5, 5]);
  });

  it('heatmap_data_empty_vs_zero', () => {
    const d = heatmapData(
      cols('string', 'string'),
      [
        ['a', 'x', 0],
        ['a', 'y', null],
        ['b', 'x', 1],
        ['b', 'y', Number.NaN],
      ],
      spec(),
    );
    expect(d.rows.keys).toEqual(['b', 'a']);
    expect(d.cells[1]).toEqual([{ value: 0, rows: 1 }, null]);
    expect(d.cells[0]).toEqual([{ value: 1, rows: 1 }, null]);
    expect(heatmapData(cols('string', 'string'), [], spec())).toMatchObject({ min: 0, max: 0, cells: [] });
  });

  it('heatmap_data_missing_pair_is_empty', () => {
    const d = heatmapData(
      cols('string', 'string'),
      [
        ['a', 'x', 1],
        ['b', 'y', 1],
      ],
      spec(),
    );
    expect(d.cells).toEqual([
      [{ value: 1, rows: 1 }, null],
      [null, { value: 1, rows: 1 }],
    ]);
  });

  it('heatmap_data_does_not_fill_row_gaps', () => {
    const h = hours(5);
    const d = heatmapData(
      [col('c', 'string'), col('r', 'datetime'), col('v', 'long')],
      [h[0], h[1], h[4]].map((t) => ['x', t, 1]),
      spec(),
    );
    expect(d.rows.keys).toEqual([h[0], h[1], h[4]]);
  });

  it('heatmap_data_shapes_a_large_grid', () => {
    const rows = Array.from({ length: 100 * 2000 }, (_, i) => [Math.floor(i / 2000), i % 2000, 1]);
    const d = heatmapData(cols('int', 'int'), rows, spec());
    expect([d.rows.keys.length, d.columns.keys.length, d.max]).toEqual([100, 2000, 1]);
  });

  it('heatmap_data_orders_axes', () => {
    const d = heatmapData(
      cols('string', 'int'),
      [
        ['b', 3, 1],
        ['a', 1, 5],
        ['b', 2, 1],
        ['c', 9, 1],
      ],
      spec(),
    );
    expect(d.columns.keys.slice(0, 3)).toEqual(['1', '2', '3']);
    expect(d.rows.keys).toEqual(['a', 'b', 'c']);
    const dt = heatmapData(
      cols('string', 'datetime'),
      [
        ['a', '2026-01-02T00:00:00Z', 1],
        ['a', '2026-01-01T00:00:00Z', 1],
      ],
      spec(),
    );
    expect(dt.columns.keys).toEqual(['2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z']);
    const ts = heatmapData(
      cols('string', 'timespan'),
      [
        ['a', '2.00:00:00', 1],
        ['a', '00:00:00', 1],
        ['a', '-1.02:03:04.5000000', 1],
      ],
      spec(),
    );
    expect(ts.columns.keys).toEqual(['-1.02:03:04.5000000', '00:00:00', '2.00:00:00']);
    const tx = heatmapData(
      cols('string', 'string'),
      [
        ['b', 'z', 1],
        ['a', 'y', 1],
        ['a', 'z', 1],
      ],
      spec(),
    );
    expect(tx.columns.keys).toEqual(['z', 'y']);
    expect(tx.rows.keys).toEqual(['a', 'b']);
  });

  it('heatmap_data_day_names', () => {
    const rows = [0, 1, 2, 3, 4, 5, 6].map((d) => ['a', d === 0 ? '00:00:00' : `${d}.00:00:00`, 1]);
    const d = heatmapData(cols('string', 'timespan'), rows, spec());
    expect(d.columns.labels).toEqual(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);
    expect(d.columns.keys[1]).toBe('1.00:00:00');
  });

  it('heatmap_data_fills_time_gaps', () => {
    const h = hours(5);
    const d = heatmapData(
      cols('string', 'datetime'),
      [h[0], h[1], h[4]].map((t) => ['a', t, 1]),
      spec(),
    );
    expect(d.columns.keys).toEqual([h[0], h[1], null, null, h[4]]);
    expect(d.cells[0]?.map((c) => c !== null)).toEqual([true, true, false, false, true]);
    const irregular = ['2026-01-01T00:00:00Z', '2026-01-01T01:00:00Z', '2026-01-01T03:30:00Z'];
    expect(
      heatmapData(
        cols('string', 'datetime'),
        irregular.map((t) => ['a', t, 1]),
        spec(),
      ).columns.keys,
    ).toEqual(irregular);
  });

  it('heatmap_data_fills_whole_number_gaps', () => {
    const d = heatmapData(
      cols('string', 'int'),
      [0, 1, 5].map((n) => ['a', n, 1]),
      spec(),
    );
    expect(d.columns.keys).toEqual(['0', '1', null, null, null, '5']);
    expect(
      heatmapData(
        cols('string', 'int'),
        [0, 200].map((n) => ['a', n, 1]),
        spec(),
      ).columns.keys,
    ).toEqual(['0', '200']);
  });

  it('heatmap_data_caps_text_rows', () => {
    const rows = Array.from({ length: 60 }, (_, i) => [`h${i}`, 'x', i + 1]);
    const d = heatmapData(cols('string', 'string'), rows, spec());
    expect(d.rows.keys).toHaveLength(51);
    expect(d.rows.labels.at(-1)).toBe('Other');
    expect(d.rows.keys.at(-1)).toBeNull();
    expect(d.cells[50]?.[0]).toEqual({ value: 55, rows: 10 });
    expect(d.notes[0]).toBe('Showing the 50 busiest of 60 r values. The rest are in Other.');
    const ints = heatmapData(
      cols('int', 'string'),
      rows.map((_, i) => [i, 'x', 1]),
      spec(),
    );
    expect(ints.rows.keys).toHaveLength(60);
    expect(ints.notes).toEqual([]);
  });

  it('heatmap_data_caps_text_columns', () => {
    const rows = Array.from({ length: 60 }, (_, i) => ['a', `c${i}`, i + 1]);
    const d = heatmapData(cols('string', 'string'), rows, spec());
    expect(d.columns.keys).toHaveLength(51);
    expect(d.columns.labels.at(-1)).toBe('Other');
    expect(d.columns.keys.slice(0, 50)).toEqual(Array.from({ length: 50 }, (_, i) => `c${i + 10}`));
    expect(d.notes).toEqual(['Showing the 50 busiest of 60 c values. The rest are in Other.']);
  });

  it('heatmap_data_limits_ordered_columns', () => {
    const h = hours(2500);
    const d = heatmapData(
      cols('string', 'datetime'),
      h.map((t) => ['a', t, 1]),
      spec(),
    );
    expect(d.columns.keys).toEqual(h.slice(500));
    expect(d.notes).toEqual(['Showing the latest 2,000 of 2,500 c columns. Use a larger bin() to see them all.']);
    const far = heatmapData(
      cols('string', 'datetime'),
      [h[0], h[1], hours(1, 3000)[0]].map((t) => ['a', t, 1]),
      spec(),
    );
    expect(far.columns.keys).toHaveLength(2000);
    expect(far.columns.keys.at(-1)).toBe(hours(1, 3000)[0]);
    expect(far.notes).toEqual(['Showing the latest 2,000 of 3,001 c columns. Use a larger bin() to see them all.']);
  });

  it('heatmap_data_null_axis_values', () => {
    const d = heatmapData(
      cols('string', 'string'),
      [
        [null, null, 1],
        [null, null, 2],
      ],
      spec(),
    );
    expect(d.rows.labels).toEqual(['']);
    expect(d.columns.labels).toEqual(['']);
    expect(d.cells).toEqual([[{ value: 3, rows: 2 }]]);
  });

  it('heatmap_data_skips_all_null_rows', () => {
    // A values-history gap day: no Rows, no Columns, no value.
    const d = heatmapData(
      cols('string', 'string'),
      [
        [null, null, null],
        ['a', 'x', 1],
      ],
      spec(),
    );
    expect(d.rows.labels).toEqual(['a']);
    expect(d.columns.labels).toEqual(['x']);
    expect(d.cells).toEqual([[{ value: 1, rows: 1 }]]);
  });

  it('heatmap_data_limits_ordered_rows', () => {
    const d = heatmapData(
      cols('int', 'string'),
      Array.from({ length: 250 }, (_, i) => [i, 'x', 1]),
      spec(),
    );
    expect(d.rows.keys).toEqual(Array.from({ length: 200 }, (_, i) => String(i + 50)));
    expect(d.cells).toHaveLength(200);
    expect(d.notes).toEqual(['Showing the latest 200 of 250 r values. Use a larger bin() to see them all.']);
  });
});

describe('heatStrength', () => {
  it('heat_strength_scale', () => {
    expect(heatStrength(100, 0, 100)).toBe(1);
    expect(heatStrength(25, 0, 100)).toBe(0.5);
    expect(heatStrength(-10, -10, 10)).toBe(0);
    expect(heatStrength(5, 5, 5)).toBe(1);
  });
});
