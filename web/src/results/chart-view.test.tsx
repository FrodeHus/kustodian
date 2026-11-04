import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import ChartView from './chart-view';

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
    function Mark({ name, fill, stroke, stackId }: { name?: string; fill?: string; stroke?: string; stackId?: string }) {
      return <span data-mark={kind} data-name={name} data-colour={fill ?? stroke} data-stack={stackId} />;
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

describe('ChartView', () => {
  it('chart_view_picks_the_shape_and_the_picker_overrides_it', () => {
    const { container } = render(<ChartView columns={columns} rows={rows} kql="t | summarize n = count() by app" />);
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

  it('chart_view_follows_the_render_hint', () => {
    render(<ChartView columns={columns} rows={rows} kql={'t\n| summarize n = count() by app\n| render piechart'} />);
    expect(screen.getByRole('combobox', { name: 'Chart type' })).toHaveProperty('value', 'pie');
    expect(screen.getByText('From render piechart')).toBeTruthy();
  });

  it('chart_view_empty_state_explains', () => {
    render(<ChartView columns={[{ name: 'tags', type: 'dynamic' }]} rows={[[[]]]} kql="t" />);
    expect(screen.getByText('This result has no shape to chart: it needs a text, true/false or date column and a number column.')).toBeTruthy();
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
    const { container } = render(<ChartView columns={cols} rows={data} kql="t | render columnchart" />);
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
    const { container } = render(<ChartView columns={cols} rows={[[10, 4]]} kql="t" />);
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
    const { container } = render(<ChartView columns={cols} rows={data} kql="t" />);
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
    const { container } = render(<ChartView columns={cols} rows={data} kql={kql} />);
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
});
