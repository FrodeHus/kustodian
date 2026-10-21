import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ResultGrid } from './result-grid';

const columns = [
  { name: 'displayName', type: 'string' },
  { name: 'n', type: 'long' },
  { name: 'tags', type: 'dynamic' },
];

describe('ResultGrid', () => {
  it('result_grid_virtualizes_10000_rows', () => {
    const rows = Array.from({ length: 10000 }, (_, i) => [`app ${i}`, i, ['a']]);
    const { container } = render(<ResultGrid columns={columns} rows={rows} />);

    const rendered = container.querySelectorAll('tbody tr[data-index]').length;
    expect(rendered).toBeGreaterThan(0);
    expect(rendered).toBeLessThan(100);
    expect(screen.getByRole('tab', { name: 'Rows · 10,000' })).toBeTruthy();
  });

  it('result_grid_sorts_filters_and_shows_dynamic_as_json', () => {
    const rows = [
      ['Payroll', 2, { kind: 'secret' }],
      ['Contoso', 10, null],
      ['Legacy', 1, ['a', 'b']],
    ];
    const { container } = render(<ResultGrid columns={columns} rows={rows} />);
    const firstCells = () => [...container.querySelectorAll('tbody tr[data-index] td:first-child')].map((td) => td.textContent);

    fireEvent.click(screen.getByRole('button', { name: /^n/ }));
    expect(firstCells()).toEqual(['Legacy', 'Payroll', 'Contoso']);

    fireEvent.change(screen.getByRole('searchbox', { name: 'Filter rows' }), { target: { value: 'secret' } });
    expect(firstCells()).toEqual(['Payroll']);

    expect(screen.getByRole('region', { name: 'Result rows' })).toHaveProperty('tabIndex', 0);
    fireEvent.click(screen.getByRole('button', { name: 'Show tags as JSON' }));
    const panel = screen.getByRole('dialog', { name: 'tags' });
    expect(within(panel).getByText(/"kind": "secret"/)).toBeTruthy();
  });
});
