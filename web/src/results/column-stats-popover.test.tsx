import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ColumnStatsPopover } from './column-stats-popover';

const column = { name: 'state', type: 'string' };
const values = ['a', 'a', 'b', null];

/** A figure's value: the term's next element. */
const figure = (dialog: HTMLElement, term: string) => within(dialog).getByText(term).nextElementSibling?.textContent;

describe('ColumnStatsPopover', () => {
  it('shows_counts_and_top_values', () => {
    render(<ColumnStatsPopover column={column} values={values} onClose={vi.fn()} />);
    const dialog = screen.getByRole('dialog', { name: 'state statistics' });

    expect(within(dialog).getByText('Of 4 rows shown')).toBeTruthy();
    expect(figure(dialog, 'Rows')).toBe('4');
    expect(figure(dialog, 'Distinct')).toBe('2');
    expect(figure(dialog, 'Empty')).toBe('1');
    const a = within(dialog).getByText('a').closest('li')!;
    expect(within(a).getByText('2')).toBeTruthy();
    expect(within(a).getByText('50%')).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: 'Filter…' })).toBeNull();
  });

  it('shows_min_max_and_average_for_numbers', () => {
    render(<ColumnStatsPopover column={{ name: 'n', type: 'long' }} values={[1, 2, 6]} onClose={vi.fn()} />);
    const dialog = screen.getByRole('dialog', { name: 'n statistics' });
    expect(figure(dialog, 'Min')).toBe('1');
    expect(figure(dialog, 'Max')).toBe('6');
    expect(figure(dialog, 'Average')).toBe('3');
  });

  it('filters_by_a_top_value', () => {
    const onFilter = vi.fn();
    render(<ColumnStatsPopover column={column} values={values} onFilter={onFilter} onClose={vi.fn()} />);
    const a = within(screen.getByRole('dialog')).getByText('a').closest('li')!;

    fireEvent.click(within(a).getByRole('button', { name: 'Filter…' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Filter by "a"' }));
    expect(onFilter).toHaveBeenCalledWith(column, 'a', 'eq');
  });

  it('closes_on_escape_but_not_from_the_filter_menu', () => {
    const onClose = vi.fn();
    render(<ColumnStatsPopover column={column} values={values} onFilter={vi.fn()} onClose={onClose} />);
    const a = within(screen.getByRole('dialog')).getByText('a').closest('li')!;

    fireEvent.click(within(a).getByRole('button', { name: 'Filter…' }));
    fireEvent.keyDown(screen.getByRole('menuitem', { name: 'Filter by "a"' }), { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('closes_on_a_mousedown_outside', () => {
    const onClose = vi.fn();
    render(<ColumnStatsPopover column={column} values={values} onClose={onClose} />);
    fireEvent.mouseDown(within(screen.getByRole('dialog')).getByText('Of 4 rows shown'));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(document.body);
    expect(onClose).toHaveBeenCalled();
  });

  it('counts_many_values_in_chunks', async () => {
    render(<ColumnStatsPopover column={column} values={values} chunkedAbove={2} onClose={vi.fn()} />);
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Counting…')).toBeTruthy();
    expect(await within(dialog).findByText('Of 4 rows shown')).toBeTruthy();
    expect(figure(dialog, 'Distinct')).toBe('2');
  });
});
