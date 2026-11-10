import { describe, expect, it } from 'vitest';
import { NO_SHAPE, VALUE_SERIES, chartData, chartShape, markFilter, renderHint, renderOptions } from './chart-shape';

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
    const rows = [
      ['2026-10-20T00:00:00Z', 'Teams', 3, 0],
      ['2026-10-21T00:00:00Z', 'Teams', 4, 1],
    ];
    expect(chartShape(columns, rows)).toEqual({
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
    expect(
      chartData(withText, [['2026-10-19T00:00:00Z', 'Teams', true, 5]], { type: 'timechart', x: 'day', series: ['n'] }).series,
    ).toEqual(['Teams']);
  });

  it('chart_shape_null_explains', () => {
    expect(chartShape([col('name', 'string'), col('tags', 'dynamic')], [['a', []]])).toBeNull();
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
    const rows = [
      ['2026-10-20T00:00:00Z', 3],
      [null, 9],
      ['2026-10-18T00:00:00Z', 1],
      ['2026-10-19T00:00:00Z', 2],
    ];
    expect(chartData(columns, rows, { type: 'timechart', x: 'day', series: ['n'] }).data.map((p) => p.x)).toEqual([
      '2026-10-18T00:00:00Z',
      '2026-10-19T00:00:00Z',
      '2026-10-20T00:00:00Z',
      '',
    ]);

    const numbers = [col('bucket', 'long'), col('app', 'string'), col('n', 'long')];
    const split = chartData(
      numbers,
      [
        [10, 'a', 1],
        [2, 'b', 2],
        [10, 'b', 3],
      ],
      { type: 'line', x: 'bucket', series: ['n'] },
    );
    expect(split.data).toEqual([
      { x: '2', values: { b: 2 } },
      { x: '10', values: { a: 1, b: 3 } },
    ]);

    // A text axis keeps the result's order.
    expect(
      chartData(
        [col('app', 'string'), col('n', 'long')],
        [
          ['b', 1],
          ['a', 2],
        ],
        { type: 'column', x: 'app', series: ['n'] },
      ).data.map((p) => p.x),
    ).toEqual(['b', 'a']);
  });

  it('chart_data_keeps_series_columns_without_a_split', () => {
    const columns = [col('app', 'string'), col('n', 'long'), col('m', 'real')];
    const rows = [
      ['Teams', 1, 2.5],
      ['Exchange', null, 4],
    ];
    expect(chartData(columns, rows, { type: 'bar', x: 'app', series: ['n', 'm'] })).toEqual({
      series: ['n', 'm'],
      data: [
        { x: 'Teams', values: { n: 1, m: 2.5 } },
        { x: 'Exchange', values: { n: null, m: 4 } },
      ],
    });
  });

  it('chart_shape_single_row_charts_its_number_columns_side_by_side', () => {
    const columns = [col('Count A', 'long'), col('Count B', 'long'), col('Count C', 'int')];
    const rows = [[10, 4, 3]];
    const spec = chartShape(columns, rows);
    expect(spec).toEqual({ type: 'column', x: null, series: ['Count A', 'Count B', 'Count C'] });
    expect(chartShape(columns, rows, 'pie')?.type).toBe('pie');
    expect(chartData(columns, rows, { type: 'bar', x: null, series: ['Count A', 'Count C'] })).toEqual({
      series: [VALUE_SERIES],
      data: [
        { x: 'Count A', values: { [VALUE_SERIES]: 10 } },
        { x: 'Count C', values: { [VALUE_SERIES]: 3 } },
      ],
    });
  });

  it('chart_shape_two_text_columns_split_by_the_second', () => {
    const columns = [col('Value', 'long'), col('CompanyName', 'string'), col('Department', 'string')];
    const rows = [
      [10, 'Acme', 'HR'],
      [20, 'Acme', 'Finance'],
      [5, 'Globex', 'HR'],
    ];
    const spec = chartShape(columns, rows);
    expect(spec).toEqual({ type: 'column', x: 'CompanyName', series: ['Value'], split: 'Department' });
    expect(chartData(columns, rows, spec!)).toEqual({
      series: ['HR', 'Finance'],
      data: [
        { x: 'Acme', values: { HR: 10, Finance: 20 } },
        { x: 'Globex', values: { HR: 5 } },
      ],
    });
    // Swapped, or turned off.
    expect(chartData(columns, rows, { ...spec!, x: 'Department', split: 'CompanyName' }).series).toEqual(['Acme', 'Globex']);
    expect(chartData(columns, rows, { ...spec!, split: null }).series).toEqual(['Value']);
  });

  it('chart_data_names_split_series_by_value_and_series_when_there_are_several', () => {
    const columns = [col('app', 'string'), col('os', 'string'), col('n', 'long'), col('m', 'long')];
    const rows = [['Teams', 'iOS', 1, 2]];
    expect(chartData(columns, rows, { type: 'column', x: 'app', series: ['n', 'm'], split: 'os' })).toEqual({
      series: ['iOS · n', 'iOS · m'],
      data: [{ x: 'Teams', values: { 'iOS · n': 1, 'iOS · m': 2 } }],
    });
  });

  it('mark_filter_matches_the_x_value_and_the_split_series', () => {
    const columns = [col('app', 'string'), col('os', 'string'), col('n', 'long'), col('m', 'long')];
    const rows = [
      ['Teams', 'iOS', 1, 2],
      ['Teams', 'Android', 3, 4],
    ];
    const one = { type: 'column' as const, x: 'app', series: ['n'], split: 'os' };
    expect(markFilter(columns, rows, one, 'Teams', 'Android')).toEqual([
      { id: 'app', value: 'Teams' },
      { id: 'os', value: 'Android' },
    ]);
    // With several number columns the series is named "value · column".
    expect(markFilter(columns, rows, { ...one, series: ['n', 'm'] }, 'Teams', 'iOS · m')).toEqual([
      { id: 'app', value: 'Teams' },
      { id: 'os', value: 'iOS' },
    ]);
    // A line's click names no series, and with no split the x value is all there is.
    expect(markFilter(columns, rows, one, 'Teams')).toEqual([{ id: 'app', value: 'Teams' }]);
    expect(markFilter(columns, rows, { ...one, split: null }, 'Teams', 'n')).toEqual([{ id: 'app', value: 'Teams' }]);
    // Series' names along the axis all come from one row.
    expect(markFilter(columns, rows.slice(0, 1), { type: 'column', x: null, series: ['n', 'm'] }, 'n', VALUE_SERIES)).toBeNull();
  });

  it('render_options_reads_the_with_properties', () => {
    expect(renderOptions('t | render columnchart')).toEqual({});
    expect(
      renderOptions(
        "t\n| render columnchart with (kind=Stacked100, xcolumn=app, ycolumns=n, ['Count A'], series=os, title='Sign-ins, by (app)') // done",
      ),
    ).toEqual({ xcolumn: 'app', ycolumns: ['n', 'Count A'], series: ['os'], title: 'Sign-ins, by (app)', stack: 'stacked100' });
    // Over several lines, the last render wins, and an unknown kind is no stacking.
    expect(renderOptions('t | render piechart with (title="a")\n| render areachart with (\n  kind=unstacked,\n  title="b"\n)')).toEqual({
      xcolumn: undefined,
      ycolumns: undefined,
      series: undefined,
      title: 'b',
      stack: undefined,
    });
    expect(renderHint('t | render barchart with (kind=stacked)')).toBe('bar');
  });

  it('chart_shape_follows_render_options_where_the_result_has_the_columns', () => {
    const columns = [col('app', 'string'), col('os', 'string'), col('n', 'long'), col('m', 'long'), col('day', 'datetime')];
    const rows = [
      ['Teams', 'iOS', 1, 2, '2026-10-20T00:00:00Z'],
      ['Teams', 'Windows', 3, 4, '2026-10-21T00:00:00Z'],
    ];
    expect(chartShape(columns, rows, 'column', { xcolumn: 'app', ycolumns: ['m', 'missing'], series: ['nope', 'os'] })).toEqual({
      type: 'column',
      x: 'app',
      series: ['m'],
      split: 'os',
    });
    // Names the result doesn't have change nothing.
    expect(chartShape(columns, rows, 'column', { xcolumn: 'missing', ycolumns: ['missing'] })).toEqual(chartShape(columns, rows, 'column'));
    // A number column can be the x axis; it leaves the series.
    expect(chartShape(columns, rows, 'line', { xcolumn: 'n' })).toEqual({ type: 'line', x: 'n', series: ['m'] });
  });
});
