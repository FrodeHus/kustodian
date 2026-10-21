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

  it('chart_shape_null_explains', () => {
    expect(chartShape([col('name', 'string'), col('tags', 'dynamic')], [['a', []]])).toBeNull();
    expect(chartShape([col('a', 'string'), col('b', 'string'), col('n', 'long')], [['a', 'b', 1]])).toBeNull();
    expect(chartShape([col('n', 'long')], [[1]], 'column')).toBeNull();
    expect(NO_SHAPE).toBe('This result has no shape to chart: it needs a text or date column and a number column.');
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
