import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CompareView } from './compare-view';

const columns = [
  { name: 'app', type: 'string' },
  { name: 'signIns', type: 'long' },
];
const pinned = { columns, rows: [['Teams', 96], ['Legacy Intranet', 3], ['Exchange', 40]] };
const current = { columns, rows: [['Teams', 118], ['Exchange', 40], ['Azure Portal', 12]] };

describe('CompareView', () => {
  it('compare_view_shows_the_diff_by_key', () => {
    render(<CompareView pinned={pinned} current={current} />);

    expect(screen.getByRole('combobox', { name: 'Match rows on' })).toHaveProperty('value', 'app');
    const table = screen.getByRole('table', { name: 'Differences' });
    const rows = within(table).getAllByRole('row').slice(1);
    // As the mockup orders them: added, changed, removed.
    expect(rows.map((r) => r.textContent)).toEqual(['+ Azure Portal12', 'Teams96 → 118', '− Legacy Intranet3']);
    expect(rows[0]!.className).toContain('text-ok');
    expect(rows[2]!.className).toContain('text-bad');
    expect(within(rows[1]!).getByText('96 → 118').closest('td')?.getAttribute('data-changed')).toBe('true');
    expect(screen.getByText('1 added · 1 removed · 1 changed · 1 the same')).toBeTruthy();

    // Matched on the number column instead, every row differs.
    fireEvent.change(screen.getByRole('combobox', { name: 'Match rows on' }), { target: { value: 'signIns' } });
    expect(screen.getByText('2 added · 2 removed · 0 changed · 1 the same')).toBeTruthy();
  });

  it('compare_view_side_by_side_shows_both_runs', () => {
    render(<CompareView pinned={pinned} current={current} />);

    fireEvent.click(screen.getByRole('button', { name: 'Side by side' }));

    expect(screen.getByRole('region', { name: 'Pinned run' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'This run' })).toBeTruthy();
    expect(screen.queryByRole('table', { name: 'Differences' })).toBeNull();
  });

  it('compare_view_without_common_columns_says_so', () => {
    render(<CompareView pinned={pinned} current={{ columns: [{ name: 'other', type: 'string' }], rows: [] }} />);
    expect(screen.getByText('The two runs have no column in common to match rows on.')).toBeTruthy();
  });
});
