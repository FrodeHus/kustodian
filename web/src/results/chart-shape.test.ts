import { describe, expect, it } from 'vitest';
import { NO_SHAPE, chartData, chartShape, renderHint } from './chart-shape';

const col = (name: string, type: string) => ({ name, type });

describe('chartShape', () => {
  it('chart_shape_uses_render_hint', () => {
    const kql = 'signIns\n| summarize n = count() by app\n// | render piechart\n| render  LineChart with (title="x")\n';
    expect(renderHint(kql)).toBe('line');
    expect(renderHint('users | take 5')).toBeUndefined();
    expect(renderHint('users | render scatterchart')).toBeUndefined();
    // The last line that has one wins.
    expect(renderHint('t | render barchart\nt | render areachart')).toBe('area');

    const columns = [col('app', 'string'), col('n', 'long')];
    const rows = [['Teams', 3]];
    expect(chartShape(columns, rows, 'line')).toEqual({ type: 'line', x: 'app', series: ['n'] });
    expect(chartShape(columns, rows, 'pie')).toEqual({ type: 'pie', x: 'app', series: ['n'] });
    // With no hint, one text and one number column with few rows make a column chart.
    expect(chartShape(columns, rows)).toEqual({ type: 'column', x: 'app', series: ['n'] });
  });

  it('chart_shape_text_and_number_is_bar_over_20_rows', () => {
    const columns = [col('app', 'string'), col('n', 'long')];
    const rows = Array.from({ length: 21 }, (_, i) => [`app ${i}`, i]);
    expect(chartShape(columns, rows)?.type).toBe('bar');
    expect(chartShape(columns, rows.slice(0, 20))?.type).toBe('column');
  });

  it('chart_shape_timechart_for_datetime_and_number', () => {
    const columns = [col('day', 'datetime'), col('app', 'string'), col('signIns', 'long'), col('failures', 'int')];
    expect(chartShape(columns, [['2026-10-20T00:00:00Z', 'Teams', 3, 0]])).toEqual({
      type: 'timechart',
      x: 'day',
      series: ['signIns', 'failures'],
    });
  });

  it('chart_shape_bool_and_number_is_column', () => {
    const columns = [col('accountEnabled', 'bool'), col('n', 'long')];
    const rows = [
      [true, 40],
      [false, 3],
    ];
    expect(chartShape(columns, rows)).toEqual({ type: 'column', x: 'accountEnabled', series: ['n'] });
    expect(chartShape(columns, rows, 'pie')).toEqual({ type: 'pie', x: 'accountEnabled', series: ['n'] });
    expect(chartData(columns, rows, { type: 'column', x: 'accountEnabled', series: ['n'] }).data).toEqual([
      { x: 'true', values: { n: 40 } },
      { x: 'false', values: { n: 3 } },
    ]);
    // Text comes before true/false along the axis.
    expect(chartShape([col('enabled', 'bool'), col('app', 'string'), col('n', 'long')], [[true, 'Teams', 1]], 'column')?.x).toBe('app');
  });

  it('chart_data_splits_by_a_bool_column_when_there_is_no_other_text', () => {
    const columns = [col('day', 'datetime'), col('enabled', 'bool'), col('n', 'long')];
    const rows = [
      ['2026-10-19T00:00:00Z', true, 5],
      ['2026-10-19T00:00:00Z', false, 1],
    ];
    expect(chartData(columns, rows, { type: 'timechart', x: 'day', series: ['n'] })).toEqual({
      series: ['true', 'false'],
      data: [{ x: '2026-10-19T00:00:00Z', values: { true: 5, false: 1 } }],
    });
    // A text column still wins the split over a bool one.
    const withText = [col('day', 'datetime'), col('app', 'string'), col('enabled', 'bool'), col('n', 'long')];
    expect(chartData(withText, [['2026-10-19T00:00:00Z', 'Teams', true, 5]], { type: 'timechart', x: 'day', series: ['n'] }).series).toEqual([
      'Teams',
    ]);
  });

  it('chart_shape_null_explains', () => {
    expect(chartShape([col('name', 'string'), col('tags', 'dynamic')], [['a', []]])).toBeNull();
    expect(chartShape([col('a', 'string'), col('b', 'string'), col('n', 'long')], [['a', 'b', 1]])).toBeNull();
    expect(chartShape([col('n', 'long')], [[1]], 'column')).toBeNull();
    expect(NO_SHAPE).toBe('This result has no shape to chart: it needs a text, true/false or date column and a number column.');
  });

  it('chart_data_splits_one_series_by_the_other_text_column', () => {
    const columns = [col('app', 'string'), col('day', 'datetime'), col('signIns', 'long')];
    const rows = [
      ['Teams', '2026-10-19T00:00:00Z', 96],
      ['Exchange', '2026-10-19T00:00:00Z', 40],
      ['Teams', '2026-10-20T00:00:00Z', 118],
    ];
    const spec = chartShape(columns, rows, 'column');
    expect(spec).toEqual({ type: 'column', x: 'day', series: ['signIns'] });
    expect(chartData(columns, rows, spec!)).toEqual({
      series: ['Teams', 'Exchange'],
      data: [
        { x: '2026-10-19T00:00:00Z', values: { Teams: 96, Exchange: 40 } },
        { x: '2026-10-20T00:00:00Z', values: { Teams: 118 } },
      ],
    });
  });

  it('render_hint_ignores_a_trailing_comment_but_not_a_url', () => {
    expect(renderHint('t | take 5 // | render piechart')).toBeUndefined();
    expect(renderHint('t | render barchart // was | render piechart')).toBe('bar');
    expect(renderHint('t | where u == "https://x" | render linechart')).toBe('line');
  });

  it('chart_data_sorts_points_along_a_date_or_number_axis', () => {
    const columns = [col('day', 'datetime'), col('n', 'long')];
    const rows = [['2026-10-20T00:00:00Z', 3], [null, 9], ['2026-10-18T00:00:00Z', 1], ['2026-10-19T00:00:00Z', 2]];
    expect(chartData(columns, rows, { type: 'timechart', x: 'day', series: ['n'] }).data.map((p) => p.x)).toEqual([
      '2026-10-18T00:00:00Z',
      '2026-10-19T00:00:00Z',
      '2026-10-20T00:00:00Z',
      '',
    ]);

    const numbers = [col('bucket', 'long'), col('app', 'string'), col('n', 'long')];
    const split = chartData(numbers, [[10, 'a', 1], [2, 'b', 2], [10, 'b', 3]], { type: 'line', x: 'bucket', series: ['n'] });
    expect(split.data).toEqual([
      { x: '2', values: { b: 2 } },
      { x: '10', values: { a: 1, b: 3 } },
    ]);

    // A text axis keeps the result's order.
    expect(chartData([col('app', 'string'), col('n', 'long')], [['b', 1], ['a', 2]], { type: 'column', x: 'app', series: ['n'] }).data.map((p) => p.x)).toEqual(['b', 'a']);
  });

  it('chart_data_keeps_series_columns_without_a_split', () => {
    const columns = [col('app', 'string'), col('n', 'long'), col('m', 'real')];
    const rows = [['Teams', 1, 2.5], ['Exchange', null, 4]];
    expect(chartData(columns, rows, { type: 'bar', x: 'app', series: ['n', 'm'] })).toEqual({
      series: ['n', 'm'],
      data: [
        { x: 'Teams', values: { n: 1, m: 2.5 } },
        { x: 'Exchange', values: { n: null, m: 4 } },
      ],
    });
  });
});
