import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ResultGrid } from './result-grid';

const columns = [
  { name: 'displayName', type: 'string' },
  { name: 'n', type: 'long' },
  { name: 'tags', type: 'dynamic' },
];

const writeText = vi.fn<(text: string) => Promise<void>>();

beforeEach(() => {
  writeText.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
});

afterEach(() => {
  Reflect.deleteProperty(navigator, 'clipboard');
});

const headers = (container: HTMLElement) => [...container.querySelectorAll('thead th')].map((th) => th.textContent?.replace(/ [↑↓]$/, ''));
const bodyRows = (container: HTMLElement) => [...container.querySelectorAll<HTMLTableRowElement>('tbody tr[data-index]')];

describe('ResultGrid', () => {
  it('result_grid_virtualizes_10000_rows', () => {
    const rows = Array.from({ length: 10000 }, (_, i) => [`app ${i}`, i, ['a']]);
    const { container } = render(<ResultGrid columns={columns} rows={rows} />);

    const rendered = container.querySelectorAll('tbody tr[data-index]').length;
    expect(rendered).toBeGreaterThan(0);
    expect(rendered).toBeLessThan(100);
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

  it('grid_hides_and_reorders_columns', () => {
    const rows = [['Contoso', 1, null]];
    const { container } = render(<ResultGrid columns={columns} rows={rows} />);

    fireEvent.click(screen.getByRole('button', { name: 'Columns' }));
    const menu = screen.getByRole('menu', { name: 'Columns' });
    fireEvent.click(within(menu).getByRole('menuitemcheckbox', { name: 'n' }));
    expect(headers(container)).toEqual(['displayName', 'tags']);
    expect(within(menu).getByRole('menuitemcheckbox', { name: 'n' }).getAttribute('aria-checked')).toBe('false');

    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Move tags earlier' }));
    expect(headers(container)).toEqual(['tags', 'displayName']);
    expect([...container.querySelectorAll('tbody tr[data-index] td')].map((td) => td.textContent)).toEqual(['null', 'Contoso']);

    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Show all columns' }));
    expect(headers(container)).toEqual(['tags', 'displayName', 'n']);

    // Esc closes the menu and puts focus back on its button.
    fireEvent.keyDown(within(menu).getByRole('menuitem', { name: 'Show all columns' }), { key: 'Escape' });
    expect(screen.queryByRole('menu', { name: 'Columns' })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Columns' }));
  });

  it('grid_menu_closes_on_click_outside_not_on_blur', () => {
    render(<ResultGrid columns={columns} rows={[['Contoso', 1, null]]} />);

    fireEvent.click(screen.getByRole('button', { name: 'Columns' }));
    const item = within(screen.getByRole('menu', { name: 'Columns' })).getByRole('menuitemcheckbox', { name: 'n' });
    // WKWebView doesn't focus a button on mousedown, so focus leaving the menu mustn't close it before the click lands.
    fireEvent.blur(item, { relatedTarget: null });
    expect(screen.getByRole('menu', { name: 'Columns' })).toBeTruthy();
    expect(fireEvent.mouseDown(item)).toBe(false);

    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('menu', { name: 'Columns' })).toBeNull();
  });

  it('grid_groups_by_column', () => {
    const rows = [
      ['Contoso', 1, null],
      ['Payroll', 2, null],
      ['Contoso', 3, null],
    ];
    const { container } = render(<ResultGrid columns={columns} rows={rows} />);

    fireEvent.click(screen.getByRole('button', { name: 'Group by' }));
    fireEvent.click(within(screen.getByRole('menu', { name: 'Group by' })).getByRole('menuitemradio', { name: 'displayName' }));

    // Groups start collapsed: one row each, with how many rows it has.
    expect(bodyRows(container).map((tr) => tr.textContent)).toEqual(['▸ displayName: Contoso · 2', '▸ displayName: Payroll · 1']);
    fireEvent.click(screen.getByRole('button', { name: /Contoso · 2/ }));
    expect(screen.getByRole('button', { name: /Contoso · 2/ }).getAttribute('aria-expanded')).toBe('true');
    expect(bodyRows(container).map((tr) => tr.textContent)).toEqual([
      '▾ displayName: Contoso · 2',
      'Contoso1null',
      'Contoso3null',
      '▸ displayName: Payroll · 1',
    ]);
    // The grouped column keeps its place.
    expect(headers(container)).toEqual(['displayName', 'n', 'tags']);

    fireEvent.click(screen.getByRole('button', { name: 'Group by: displayName' }));
    fireEvent.click(within(screen.getByRole('menu', { name: 'Group by' })).getByRole('menuitemradio', { name: 'No grouping' }));
    expect(bodyRows(container)).toHaveLength(3);
  });

  it('grid_shift_click_selects_range_and_copies_csv', async () => {
    const rows = [
      ['Contoso, Ltd', 1, null],
      ['Payroll', 2, { kind: 'secret' }],
      ['Legacy', 3, null],
      ['Sync', 4, null],
    ];
    const { container } = render(<ResultGrid columns={columns} rows={rows} />);
    const row = (i: number) => bodyRows(container)[i]!;

    fireEvent.click(row(0));
    fireEvent.click(row(2), { shiftKey: true });
    expect(bodyRows(container).map((tr) => tr.getAttribute('aria-selected'))).toEqual(['true', 'true', 'true', 'false']);

    // Ctrl/Cmd-click toggles one row.
    fireEvent.click(row(1), { ctrlKey: true });
    fireEvent.click(row(3), { metaKey: true });
    expect(bodyRows(container).map((tr) => tr.getAttribute('aria-selected'))).toEqual(['true', 'false', 'true', 'true']);
    fireEvent.click(row(1), { ctrlKey: true });

    fireEvent.click(screen.getByRole('button', { name: 'Copy as' }));
    const menu = screen.getByRole('menu', { name: 'Copy as' });
    expect(within(menu).getByText('4 rows selected')).toBeTruthy();
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Rows as CSV' }));

    expect(writeText).toHaveBeenCalledWith(
      ['displayName,n,tags', '"Contoso, Ltd",1,', 'Payroll,2,"{""kind"":""secret""}"', 'Legacy,3,', 'Sync,4,'].join('\r\n'),
    );
    expect(await screen.findByText('Copied 4 rows as CSV.')).toBeTruthy();

    // A plain click selects just that row; cells leave the header out.
    fireEvent.click(row(1));
    fireEvent.click(screen.getByRole('button', { name: 'Copy as' }));
    fireEvent.click(within(screen.getByRole('menu', { name: 'Copy as' })).getByRole('menuitem', { name: 'Cells as Markdown' }));
    expect(writeText).toHaveBeenLastCalledWith('| Payroll | 2 | {"kind":"secret"} |');
  });

  it('grid_selected_count_leaves_out_rows_the_filter_hides', () => {
    const rows = [
      ['Contoso', 1, null],
      ['Payroll', 2, null],
      ['Legacy', 3, null],
    ];
    const { container } = render(<ResultGrid columns={columns} rows={rows} />);
    fireEvent.click(bodyRows(container)[0]!);
    fireEvent.click(bodyRows(container)[1]!, { shiftKey: true });

    fireEvent.change(screen.getByRole('searchbox', { name: 'Filter rows' }), { target: { value: 'Payroll' } });
    fireEvent.click(screen.getByRole('button', { name: 'Copy as' }));
    expect(screen.getByText('1 row selected')).toBeTruthy();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Cells as CSV' }));
    expect(writeText).toHaveBeenLastCalledWith('Payroll,2,');

    // With none of the selected rows shown, every row shown is copied.
    fireEvent.change(screen.getByRole('searchbox', { name: 'Filter rows' }), { target: { value: 'Legacy' } });
    fireEvent.click(screen.getByRole('button', { name: 'Copy as' }));
    expect(screen.getByText('All 1 row')).toBeTruthy();
  });

  it('grid_copy_says_when_the_clipboard_fails', async () => {
    writeText.mockRejectedValue(new Error('Write permission denied.'));
    render(<ResultGrid columns={columns} rows={[['Contoso', 1, null]]} />);

    fireEvent.click(screen.getByRole('button', { name: 'Copy as' }));
    // Nothing selected: every row shown is copied.
    expect(screen.getByText('All 1 row')).toBeTruthy();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rows as JSON' }));

    expect((await screen.findByRole('alert')).textContent).toContain('Couldn’t copy: Write permission denied.');
  });

  it('grid_opens_row_on_double_click_and_enter', () => {
    const onOpenRow = vi.fn();
    const rows = [
      ['b', 2, null],
      ['a', 1, null],
    ];
    const { container } = render(<ResultGrid columns={columns} rows={rows} onOpenRow={onOpenRow} />);

    // Sorted, the first row shown is the second row returned.
    fireEvent.click(screen.getByRole('button', { name: /^n/ }));
    // A double-click comes after the click of its first press.
    fireEvent.click(bodyRows(container)[0]!);
    fireEvent.doubleClick(bodyRows(container)[0]!);
    expect(onOpenRow).toHaveBeenLastCalledWith(1);

    const region = screen.getByRole('region', { name: 'Result rows' });
    fireEvent.keyDown(region, { key: 'ArrowDown' });
    expect(bodyRows(container)[1]!.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(region, { key: 'Enter' });
    expect(onOpenRow).toHaveBeenLastCalledWith(0);
  });
});
