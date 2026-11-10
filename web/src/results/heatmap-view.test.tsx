import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { HeatmapAxis, HeatmapData } from './heatmap-shape';
import HeatmapView from './heatmap-view';

const axis = (column: string, keys: (string | null)[], kind: HeatmapAxis['kind'] = 'text', labels?: string[]): HeatmapAxis => ({
  column,
  kind,
  keys,
  labels: labels ?? keys.map((k) => k ?? 'Other'),
});
const data = (): HeatmapData => ({
  rows: axis('app', ['Teams', null]),
  columns: axis('day', ['a', 'b', 'c']),
  cells: [
    [{ value: 412, rows: 3 }, null, { value: 10, rows: 1 }],
    [{ value: 5, rows: 1 }, { value: 100, rows: 1 }, null],
  ],
  min: 5,
  max: 412,
  notes: ['Showing the 50 busiest of 80 app values. The rest are in Other.'],
});
const cells = (c: HTMLElement) => [...c.querySelectorAll<HTMLElement>('[data-cell]')];

describe('HeatmapView', () => {
  it('heatmap_view_cells_have_colour_and_hover_text', () => {
    const { container } = render(<HeatmapView data={data()} value="count_" />);
    const all = cells(container);
    expect(all).toHaveLength(6);
    const filled = all.filter((c) => !c.classList.contains('heat-empty'));
    expect(filled).toHaveLength(4);
    for (const c of filled) {
      expect(c.style.getPropertyValue('--heat')).toContain('var(--accent)');
    }
    for (const c of all.filter((c) => c.classList.contains('heat-empty'))) {
      expect(c.style.getPropertyValue('--heat')).toBe('');
    }
    // Nothing hovered: the empty readout box is hidden but keeps its space.
    expect(screen.getByTestId('heat-tip').style.visibility).toBe('hidden');
    fireEvent.mouseOver(all[0]!);
    const tip = screen.getByTestId('heat-tip');
    expect(tip.style.visibility).toBe('visible');
    expect(tip.textContent).toContain('Teams');
    expect(tip.textContent).toContain('Teams / a —');
    expect(tip.textContent).toContain('412 count_');
    expect(tip.textContent).toContain('from 3 rows');
    fireEvent.mouseOver(all[3]!);
    expect(screen.getByTestId('heat-tip').textContent).not.toContain('from');
  });

  it('heatmap_view_labels_on_top_and_click_activates', () => {
    const { container } = render(<HeatmapView data={data()} value="v" />);
    const grid = screen.getByRole('grid');
    const first = [...grid.querySelectorAll('div')].find((d) => d.textContent === 'a')!;
    expect(first.compareDocumentPosition(cells(container)[0]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.focus(grid);
    fireEvent.click(cells(container)[4]!);
    const ring = screen.getByTestId('heat-ring');
    // One cell: an absolutely placed grid item with only a start line runs to the grid's edge.
    expect([ring.style.gridRow, ring.style.gridColumn]).toEqual(['3 / span 1', '3 / span 1']);
  });

  it.each([
    [6, 1],
    [24, 2],
  ])('heatmap_view_header_spans_%i_columns_by_%i', (n, step) => {
    const many = data();
    many.columns = axis(
      'day',
      Array.from({ length: n }, (_, i) => `k${i}`),
    );
    many.cells = many.cells.map(() => many.columns.keys.map(() => ({ value: 1, rows: 1 })));
    render(<HeatmapView data={many} value="v" />);
    const heads = screen.getAllByTestId('heat-colhead');
    expect(heads).toHaveLength(n / step);
    heads.forEach((h, i) => {
      expect(h.style.gridColumn).toBe(`${i * step + 2} / span ${step}`);
      expect(h.style.textOverflow).toBe('ellipsis');
      expect(h.style.overflow).toBe('hidden');
      expect(h.title).toBe(`k${i * step}`);
    });
  });

  it('heatmap_view_corner_is_above_headers_and_row_labels', () => {
    render(<HeatmapView data={data()} value="v" />);
    const z = (e: HTMLElement) => Number(e.style.zIndex);
    const corner = z(screen.getByTestId('heat-corner'));
    const others = [
      ...screen.getAllByTestId('heat-colhead'),
      ...screen.getByRole('grid').querySelectorAll<HTMLElement>('[role=row] > [title]'),
    ];
    expect(others.length).toBeGreaterThan(3);
    for (const o of others) {
      expect(corner).toBeGreaterThan(z(o));
    }
  });

  it('heatmap_view_keyboard', () => {
    const onPick = vi.fn();
    render(<HeatmapView data={data()} value="count_" onPick={onPick} />);
    const grid = screen.getByRole('grid');
    expect(grid.getAttribute('tabindex')).toBe('0');
    expect(grid.getAttribute('aria-label')).toContain('app');
    expect(grid.getAttribute('aria-label')).toContain('day');
    expect(grid.getAttribute('aria-label')).toContain('count_');
    fireEvent.focus(grid);
    fireEvent.keyDown(grid, { key: 'ArrowRight' });
    fireEvent.keyDown(grid, { key: 'ArrowDown' });
    expect(screen.getByTestId('heat-tip').textContent).toContain('100 count_');
    fireEvent.keyDown(grid, { key: 'ArrowUp' });
    fireEvent.keyDown(grid, { key: 'ArrowLeft' });
    fireEvent.keyDown(grid, { key: 'Enter' });
    expect(onPick).toHaveBeenCalledWith([
      { id: 'day', value: 'a' },
      { id: 'app', value: 'Teams' },
    ]);
  });

  it('heatmap_view_click_picks_and_other_does_not', () => {
    const onPick = vi.fn();
    const { container } = render(<HeatmapView data={data()} value="v" onPick={onPick} />);
    const all = cells(container);
    fireEvent.click(all[2]!);
    expect(onPick).toHaveBeenCalledWith([
      { id: 'day', value: 'c' },
      { id: 'app', value: 'Teams' },
    ]);
    onPick.mockClear();
    fireEvent.click(all[1]!); // empty
    fireEvent.click(all[3]!); // Other row
    fireEvent.click(all[4]!);
    expect(onPick).not.toHaveBeenCalled();
  });

  it('heatmap_view_fills_its_box_and_scrolls_inside_it', () => {
    // A box shorter than the grid (a small Chart tab or widget) scrolls the grid, keeping the readout and legend in view.
    render(<HeatmapView data={data()} value="count_" />);
    const scroller = screen.getByRole('grid').parentElement!;
    expect(scroller.parentElement!.className).toContain('h-full');
    expect([scroller.style.overflow, scroller.style.minHeight, scroller.style.maxHeight]).toEqual(['auto', '0px', '']);
  });

  it('heatmap_view_fit_takes_the_width_it_is_given', () => {
    // Printing: the grid is the page's width (labels clip), never as wide as its labels, and grows to its own height.
    const { container } = render(<HeatmapView data={data()} value="count_" fit />);
    const grid = screen.getByRole('grid');
    expect(grid.style.width).toBe('100%');
    expect(grid.parentElement!.getAttribute('style')).toBeNull();
    expect(container.firstElementChild!.className).toContain('heatmap');
  });

  it('heatmap_view_legend_and_notes', () => {
    render(<HeatmapView data={data()} value="count_" />);
    const legend = screen.getByTestId('heat-legend');
    expect(legend.textContent).toContain('5');
    expect(legend.textContent).toContain('412');
    expect(legend.textContent).toContain('count_');
    expect(screen.getByText(data().notes[0]!)).toBeTruthy();
  });

  it('heatmap_view_single_cell', () => {
    const one: HeatmapData = {
      rows: axis('r', ['x']),
      columns: axis('c', ['y']),
      cells: [[{ value: 7, rows: 1 }]],
      min: 7,
      max: 7,
      notes: [],
    };
    const { container } = render(<HeatmapView data={one} value="v" />);
    const [cell] = cells(container);
    expect(cells(container)).toHaveLength(1);
    expect(cell!.style.getPropertyValue('--heat')).toBe('color-mix(in srgb, var(--accent) 100%, transparent)');
    expect(container.innerHTML).not.toContain('NaN');
    expect(screen.getByTestId('heat-legend')).toBeTruthy();
  });

  it('heatmap_view_datetime_labels', () => {
    const d = data();
    d.columns = axis('t', ['2026-03-04T00:00:00Z', null, 'z'], 'datetime', ['2026-03-04T00:00:00Z', '2026-03-05T00:00:00.000Z', 'z']);
    render(<HeatmapView data={d} value="v" />);
    expect(screen.getByText('4 Mar')).toBeTruthy();
    expect(screen.getByText('5 Mar')).toBeTruthy();
  });
});
