import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import ChartView from './chart-view';

// jsdom has no layout for Recharts to measure: each chart stands in as an element naming its kind and series.
vi.mock('recharts', () => {
  const chart = (kind: string) =>
    function Chart({ children }: { children?: ReactNode }) {
      return <div data-chart={kind}>{children}</div>;
    };
  const mark = (kind: string) =>
    function Mark({ name, fill, stroke }: { name?: string; fill?: string; stroke?: string }) {
      return <span data-mark={kind} data-name={name} data-colour={fill ?? stroke} />;
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
});
