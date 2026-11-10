import { fireEvent, render, screen } from '@testing-library/react';
import { useState, type ComponentProps, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { NO_SHAPE, withType, type Picked } from './chart-shape';
import ChartView from './chart-view';
import { HEATMAP_NO_SHAPE, HEATMAP_PICK } from './heatmap-shape';

// jsdom has no layout for Recharts to measure: each chart stands in as an element naming its kind and series.
vi.mock('recharts', () => {
  const chart = (kind: string) =>
    function Chart({ children, stackOffset }: { children?: ReactNode; stackOffset?: string }) {
      return (
        <div data-chart={kind} data-offset={stackOffset}>
          {children}
        </div>
      );
    };
  const mark = (kind: string) =>
    function Mark({
      name,
      fill,
      stroke,
      stackId,
      onClick,
    }: {
      name?: string;
      fill?: string;
      stroke?: string;
      stackId?: string;
      onClick?: (data: unknown, index: number) => void;
    }) {
      // A click on the mark stands for one on its second point.
      return <span data-mark={kind} data-name={name} data-colour={fill ?? stroke} data-stack={stackId} onClick={() => onClick?.({}, 1)} />;
    };
  const none = () => null;
  return {
    ResponsiveContainer: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
    BarChart: chart('bar'),
    LineChart: chart('line'),
    AreaChart: chart('area'),
    PieChart: chart('pie'),
    Bar: mark('bar'),
    Line: mark('line'),
    Area: mark('area'),
    Pie: ({ children }: { children?: ReactNode }) => <span data-mark="pie">{children}</span>,
    Cell: ({ fill }: { fill?: string }) => <span data-mark="cell" data-colour={fill} />,
    CartesianGrid: none,
    XAxis: none,
    YAxis: none,
    Tooltip: none,
    Legend: none,
  };
});

const columns = [
  { name: 'app', type: 'string' },
  { name: 'n', type: 'long' },
];
const rows = [
  ['Teams', 3],
  ['Exchange', 5],
];

// The panel holds the picks; here the test does.
function Chart(props: Omit<ComponentProps<typeof ChartView>, 'picked' | 'setPicked'>) {
  const [picked, setPicked] = useState<Picked>({});
  return <ChartView {...props} picked={picked} setPicked={setPicked} />;
}

describe('ChartView', () => {
  it('chart_view_picks_the_shape_and_the_picker_overrides_it', () => {
    const { container } = render(<Chart columns={columns} rows={rows} kql="t | summarize n = count() by app" />);
    const picker = screen.getByRole('combobox', { name: 'Chart type' });

    expect(picker).toHaveProperty('value', 'column');
    expect(container.querySelector('[data-chart="bar"]')).toBeTruthy();
    expect(container.querySelector('[data-mark="bar"]')?.getAttribute('data-colour')).toBe('var(--accent)');

    fireEvent.change(picker, { target: { value: 'line' } });
    expect(container.querySelector('[data-chart="line"]')).toBeTruthy();
    expect(container.querySelector('[data-mark="line"]')?.getAttribute('data-name')).toBe('n');

    fireEvent.change(picker, { target: { value: 'pie' } });
    expect(container.querySelectorAll('[data-mark="cell"]')).toHaveLength(2);
  });

  it('chart_view_without_controls_draws_the_chart_alone_as_picked', () => {
    const { container } = render(<ChartView columns={columns} rows={rows} kql="t" picked={{ type: 'line' }} controls={false} />);
    expect(container.querySelector('[data-chart="line"]')).toBeTruthy();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Full screen' })).toBeNull();
  });

  it('chart_view_without_controls_splits_and_stacks_as_picked', () => {
    const cols = [
      { name: 'app', type: 'string' },
      { name: 'state', type: 'string' },
      { name: 'n', type: 'long' },
    ];
    const split = [
      ['Teams', 'open', 1],
      ['Teams', 'closed', 2],
      ['Exchange', 'open', 3],
    ];
    const { container } = render(
      <ChartView
        columns={cols}
        rows={split}
        kql="t"
        picked={{ type: 'column', x: 'app', split: 'state', stack: 'stacked100' }}
        controls={false}
      />,
    );
    const marks = [...container.querySelectorAll('[data-mark="bar"]')];
    expect(marks.map((m) => m.getAttribute('data-name'))).toEqual(['open', 'closed']);
    expect(marks.map((m) => m.getAttribute('data-stack'))).toEqual(['stack', 'stack']);
    expect(container.querySelector('[data-chart="bar"]')?.getAttribute('data-offset')).toBe('expand');
  });

  it('chart_view_without_controls_scrolls_a_bar_chart_of_many_categories', () => {
    const many = Array.from({ length: 40 }, (_, i) => [`app ${i}`, i]);
    const { container } = render(<ChartView columns={columns} rows={many} kql="t" picked={{ type: 'bar' }} controls={false} />);
    const tall = container.querySelector<HTMLElement>('.overflow-y-auto > div');
    expect(tall?.style.height).toBe('max(100%, 880px)');
  });

  it('chart_view_click_picks_the_rows_behind_the_mark', () => {
    const onPick = vi.fn();
    const { container } = render(<Chart columns={columns} rows={rows} kql="t" onPick={onPick} />);
    fireEvent.click(container.querySelector('[data-mark="bar"]')!);
    expect(onPick).toHaveBeenCalledWith([{ id: 'app', value: 'Exchange' }]);
  });

  it('chart_view_full_screen_toggles_and_esc_leaves_it', () => {
    render(<Chart columns={columns} rows={rows} kql="t" />);
    const chart = screen.getByRole('region', { name: 'Chart' });
    fireEvent.click(screen.getByRole('button', { name: 'Full screen' }));
    expect(chart.className).toContain('fixed');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(chart.className).not.toContain('fixed');
    expect(screen.getByRole('button', { name: 'Full screen' }).getAttribute('aria-pressed')).toBe('false');
  });

  it('chart_view_follows_the_render_hint', () => {
    render(<Chart columns={columns} rows={rows} kql={'t\n| summarize n = count() by app\n| render piechart'} />);
    expect(screen.getByRole('combobox', { name: 'Chart type' })).toHaveProperty('value', 'pie');
    expect(screen.getByText('From render piechart')).toBeTruthy();
  });

  it('chart_view_empty_state_explains', () => {
    render(<Chart columns={[{ name: 'tags', type: 'dynamic' }]} rows={[[[]]]} kql="t" />);
    expect(
      screen.getByText('This result has no shape to chart: it needs a text, true/false or date column and a number column.'),
    ).toBeTruthy();
    expect(screen.queryByRole('combobox', { name: 'Chart type' })).toBeNull();
  });

  it('chart_view_axis_and_values_are_pickable', () => {
    const cols = [
      { name: 'app', type: 'string' },
      { name: 'os', type: 'string' },
      { name: 'n', type: 'long' },
      { name: 'm', type: 'long' },
    ];
    const data = [
      ['Teams', 'iOS', 3, 1],
      ['Exchange', 'Windows', 5, 2],
    ];
    const { container } = render(<Chart columns={cols} rows={data} kql="t | render columnchart" />);
    const names = () => [...container.querySelectorAll('[data-mark="bar"]')].map((m) => m.getAttribute('data-name'));
    expect(screen.getByRole('combobox', { name: 'X axis' })).toHaveProperty('value', 'app');
    expect(names()).toEqual(['n', 'm']);

    // One value left is split by the other text column.
    fireEvent.click(screen.getByRole('checkbox', { name: 'm' }));
    expect(names()).toEqual(['iOS', 'Windows']);
    fireEvent.change(screen.getByRole('combobox', { name: 'X axis' }), { target: { value: 'os' } });
    expect(screen.getByRole('combobox', { name: 'X axis' })).toHaveProperty('value', 'os');
    fireEvent.click(screen.getByRole('checkbox', { name: 'n' }));
    expect(screen.getByText('Tick a value to chart.')).toBeTruthy();
  });

  it('chart_view_single_row_offers_column_names', () => {
    const cols = [
      { name: 'Count A', type: 'long' },
      { name: 'Count B', type: 'long' },
    ];
    const { container } = render(<Chart columns={cols} rows={[[10, 4]]} kql="t" />);
    expect(screen.getByRole('combobox', { name: 'X axis' })).toHaveProperty('value', '');
    expect(screen.getByRole('option', { name: 'Column names' })).toBeTruthy();
    expect(container.querySelectorAll('[data-mark="bar"]')).toHaveLength(1);
  });

  it('chart_view_split_by_is_pickable', () => {
    const cols = [
      { name: 'Value', type: 'long' },
      { name: 'CompanyName', type: 'string' },
      { name: 'Department', type: 'string' },
    ];
    const data = [
      [10, 'Acme', 'HR'],
      [20, 'Acme', 'Finance'],
    ];
    const { container } = render(<Chart columns={cols} rows={data} kql="t" />);
    const names = () => [...container.querySelectorAll('[data-mark="bar"]')].map((m) => m.getAttribute('data-name'));
    const split = screen.getByRole('combobox', { name: 'Split by' });
    expect(split).toHaveProperty('value', 'Department');
    expect(names()).toEqual(['HR', 'Finance']);

    fireEvent.change(split, { target: { value: '' } });
    expect(names()).toEqual(['Value']);
    fireEvent.change(screen.getByRole('combobox', { name: 'Chart type' }), { target: { value: 'pie' } });
    expect(screen.queryByRole('combobox', { name: 'Split by' })).toBeNull();
  });

  it('chart_view_follows_render_properties_and_stacking_is_pickable', () => {
    const cols = [
      { name: 'Value', type: 'long' },
      { name: 'Other', type: 'long' },
      { name: 'CompanyName', type: 'string' },
      { name: 'Department', type: 'string' },
    ];
    const data = [
      [10, 1, 'Acme', 'HR'],
      [20, 2, 'Acme', 'Finance'],
    ];
    const kql = 't\n| render columnchart with (kind=stacked, xcolumn=Department, ycolumns=Value, series=CompanyName, title="Headcount")';
    const { container } = render(<Chart columns={cols} rows={data} kql={kql} />);
    const marks = () => [...container.querySelectorAll('[data-mark="bar"]')];
    expect(screen.getByText('Headcount')).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'X axis' })).toHaveProperty('value', 'Department');
    expect(screen.getByRole('combobox', { name: 'Split by' })).toHaveProperty('value', 'CompanyName');
    expect(screen.getByRole('checkbox', { name: 'Other' })).toHaveProperty('checked', false);
    expect(screen.getByRole('combobox', { name: 'Stacking' })).toHaveProperty('value', 'stacked');
    expect(marks().map((m) => m.getAttribute('data-stack'))).toEqual(['stack']);

    fireEvent.change(screen.getByRole('combobox', { name: 'Stacking' }), { target: { value: 'stacked100' } });
    expect(container.querySelector('[data-chart="bar"]')?.getAttribute('data-offset')).toBe('expand');
    fireEvent.change(screen.getByRole('combobox', { name: 'Stacking' }), { target: { value: 'none' } });
    expect(marks()[0]?.getAttribute('data-stack')).toBeNull();
    fireEvent.change(screen.getByRole('combobox', { name: 'Chart type' }), { target: { value: 'line' } });
    expect(screen.queryByRole('combobox', { name: 'Stacking' })).toBeNull();
  });

  // dayofweek() gives a timespan and hourofday() an int: nothing but a heatmap fits.
  const week = [
    { name: 'Day', type: 'timespan' },
    { name: 'Hour', type: 'int' },
    { name: 'count_', type: 'long' },
  ];
  const weekRows = [
    ['1.00:00:00', 9, 4],
    ['2.00:00:00', 10, 2],
  ];
  const optionNames = (name: string) => [...screen.getByRole('combobox', { name }).querySelectorAll('option')].map((o) => o.textContent);

  it('chart_view_offers_heatmap', () => {
    const { container } = render(<Chart columns={columns} rows={rows} kql="t" />);
    expect(screen.getByRole('option', { name: 'Heatmap' })).toBeTruthy();
    expect(screen.getByText('Values', { selector: 'span' })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Chart type' })).toHaveProperty('value', 'column');
    expect(container.querySelector('[data-chart="bar"]')).toBeTruthy();
    expect(screen.queryByRole('grid')).toBeNull();
  });

  it('chart_view_heatmap_pickers', () => {
    const cols = [
      { name: 'TimeGenerated', type: 'datetime' },
      { name: 'Day', type: 'timespan' },
      { name: 'Hour', type: 'int' },
      { name: 'count_', type: 'long' },
      { name: 'sum_', type: 'long' },
    ];
    const data = [['2026-11-10T00:00:00Z', '1.00:00:00', 9, 4, 7]];
    render(<Chart columns={cols} rows={data} kql="t" />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Chart type' }), { target: { value: 'heatmap' } });

    expect(screen.getByRole('combobox', { name: 'Columns' })).toHaveProperty('value', 'TimeGenerated');
    expect(optionNames('Columns')).not.toContain('Column names');
    expect(screen.getByRole('combobox', { name: 'Rows' })).toHaveProperty('value', 'Day');
    expect(optionNames('Rows')).not.toContain('None');
    expect(optionNames('Rows')).toEqual(expect.arrayContaining(['Day', 'Hour']));
    expect(optionNames('Rows')).not.toContain('TimeGenerated');
    expect(screen.queryByRole('combobox', { name: 'Stacking' })).toBeNull();
    expect(screen.getByText('Value', { selector: 'span' })).toBeTruthy();
    expect(screen.queryByText('Values', { selector: 'span' })).toBeNull();
    expect(screen.getByRole('checkbox', { name: 'sum_' })).toHaveProperty('checked', true);

    fireEvent.click(screen.getByRole('checkbox', { name: 'count_' }));
    expect(screen.getByRole('checkbox', { name: 'count_' })).toHaveProperty('checked', true);
    expect(screen.getByRole('checkbox', { name: 'sum_' })).toHaveProperty('checked', false);
    expect(screen.getByRole('grid').getAttribute('aria-label')).toBe('Heatmap of count_ by Day (rows) and TimeGenerated (columns)');
  });

  it('chart_view_pick_heatmap_when_nothing_else_fits', () => {
    const { container, unmount } = render(<Chart columns={week} rows={weekRows} kql="t" />);
    expect(screen.getByRole('combobox', { name: 'Chart type' })).toBeTruthy();
    expect(screen.getByText(HEATMAP_PICK)).toBeTruthy();
    expect(screen.getByText('Chart', { selector: 'b' })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Chart type' })).toHaveProperty('value', '');
    expect(screen.getByRole('option', { name: 'Choose a type' })).toHaveProperty('disabled', true);
    expect(screen.queryByRole('grid')).toBeNull();

    fireEvent.change(screen.getByRole('combobox', { name: 'Chart type' }), { target: { value: 'heatmap' } });
    expect(container.querySelectorAll('[data-cell]')).toHaveLength(4);
    unmount();

    render(<Chart columns={[{ name: 'tags', type: 'dynamic' }]} rows={[[[]]]} kql="t" />);
    expect(screen.getByText(NO_SHAPE)).toBeTruthy();
  });

  it('chart_view_heatmap_cannot_shape_explains', () => {
    render(<ChartView columns={columns} rows={rows} kql="t" picked={{ type: 'heatmap' }} />);
    expect(screen.getByRole('combobox', { name: 'Chart type' })).toHaveProperty('value', 'heatmap');
    expect(screen.getByText(HEATMAP_NO_SHAPE)).toBeTruthy();
  });

  it('chart_view_switching_heatmap_resets_picks', () => {
    expect(withType({ type: 'column', x: 'a', split: 'b', series: ['n'], stack: 'stacked' }, 'heatmap')).toEqual({
      type: 'heatmap',
      stack: 'stacked',
    });
    expect(withType({ type: 'heatmap', x: 'a', split: 'b', series: ['n'] }, 'column')).toEqual({ type: 'column', stack: undefined });
    expect(withType({ type: 'column', x: 'a' }, 'bar')).toEqual({ type: 'bar', x: 'a' });
  });

  it('chart_view_heatmap_stale_picks_fall_back', () => {
    render(<ChartView columns={week} rows={weekRows} kql="t" picked={{ type: 'heatmap', x: 'gone', split: 'gone', series: ['gone'] }} />);
    expect(screen.getByRole('combobox', { name: 'Columns' })).toHaveProperty('value', 'Hour');
    expect(screen.getByRole('combobox', { name: 'Rows' })).toHaveProperty('value', 'Day');
    expect(screen.getByRole('checkbox', { name: 'count_' })).toHaveProperty('checked', true);
  });

  it('chart_view_heatmap_wrong_role_picks_fall_back', () => {
    // Day isn't a number, and count_ is the value, so neither can take that role.
    render(<ChartView columns={week} rows={weekRows} kql="t" picked={{ type: 'heatmap', x: 'count_', series: ['Day'] }} />);
    expect(screen.getByRole('combobox', { name: 'Columns' })).toHaveProperty('value', 'Hour');
    expect(screen.getByRole('combobox', { name: 'Rows' })).toHaveProperty('value', 'Day');
    expect(screen.getByRole('checkbox', { name: 'count_' })).toHaveProperty('checked', true);
  });

  it('chart_view_heatmap_axes_swap', () => {
    render(<Chart columns={week} rows={weekRows} kql="t" />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Chart type' }), { target: { value: 'heatmap' } });
    expect(optionNames('Columns')).toEqual(['Day', 'Hour']);
    fireEvent.change(screen.getByRole('combobox', { name: 'Columns' }), { target: { value: 'Day' } });
    expect(screen.getByRole('combobox', { name: 'Columns' })).toHaveProperty('value', 'Day');
    expect(screen.getByRole('combobox', { name: 'Rows' })).toHaveProperty('value', 'Hour');
  });

  it('chart_view_heatmap_cell_pick', () => {
    const onPick = vi.fn();
    const { container } = render(<ChartView columns={week} rows={weekRows} kql="t" picked={{ type: 'heatmap' }} onPick={onPick} />);
    fireEvent.click(container.querySelector('[data-cell][data-r="0"][data-c="0"]')!);
    expect(onPick).toHaveBeenCalledWith([
      { id: 'Hour', value: '9' },
      { id: 'Day', value: '1.00:00:00' },
    ]);
  });

  it('chart_view_heatmap_title', () => {
    const { unmount } = render(<ChartView columns={week} rows={weekRows} kql="t" picked={{ type: 'heatmap' }} />);
    expect(screen.getByText('Heatmap', { selector: 'b' })).toBeTruthy();
    unmount();
    render(
      <ChartView columns={week} rows={weekRows} kql={'t\n| render columnchart with (title="Busy hours")'} picked={{ type: 'heatmap' }} />,
    );
    expect(screen.getByText('Busy hours', { selector: 'b' })).toBeTruthy();
  });

  it('chart_view_heatmap_widget', () => {
    const { container } = render(<ChartView columns={week} rows={weekRows} kql="t" picked={{ type: 'heatmap' }} controls={false} />);
    expect(screen.getByRole('grid')).toBeTruthy();
    expect(container.querySelectorAll('[data-cell]')).toHaveLength(4);
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });
});
