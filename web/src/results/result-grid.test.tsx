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

const headers = (container: HTMLElement) =>
  [...container.querySelectorAll('thead th:not(.inspect-col)')].map((th) => th.textContent?.replace(/ [↑↓]$/, ''));
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
    const firstCells = () => [...container.querySelectorAll('tbody tr[data-index] td:nth-child(2)')].map((td) => td.textContent);

    fireEvent.click(screen.getByRole('button', { name: /^n/ }));
    expect(firstCells()).toEqual(['Legacy', 'Payroll', 'Contoso']);

    fireEvent.change(screen.getByRole('searchbox', { name: 'Filter rows' }), { target: { value: 'secret' } });
    expect(firstCells()).toEqual(['Payroll']);

    expect(screen.getByRole('region', { name: 'Result rows' })).toHaveProperty('tabIndex', 0);
    fireEvent.click(screen.getByRole('button', { name: 'Show tags as JSON' }));
    const panel = screen.getByRole('dialog', { name: 'tags' });
    expect(within(panel).getByText(/"kind": "secret"/)).toBeTruthy();
  });

  it('grid_has_an_inspect_button_on_every_row', () => {
    const rows = [
      ['Payroll', 2, null],
      ['Contoso', 10, null],
      ['Legacy', 1, null],
    ];
    const onOpenRow = vi.fn();
    const { container, rerender } = render(<ResultGrid columns={columns} rows={rows} onOpenRow={onOpenRow} />);
    expect(container.querySelector('thead th.inspect-col')?.textContent).toBe('Inspect');

    // Sorted by n: Legacy, Payroll, Contoso. Each button opens its row by its index in `rows`.
    fireEvent.click(screen.getByRole('button', { name: /^n/ }));
    const buttons = bodyRows(container).map((tr) => within(tr).getByRole('button', { name: /^Inspect row/ }));
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual(['Inspect row 3', 'Inspect row 1', 'Inspect row 2']);
    fireEvent.click(buttons[0]!);
    expect(onOpenRow).toHaveBeenLastCalledWith(2);

    // The row open in the sheet: its button says so, points at the sheet, and closes it.
    rerender(<ResultGrid columns={columns} rows={rows} onOpenRow={onOpenRow} inspected={2} inspectorId="sheet" />);
    const open = screen.getByRole('button', { name: 'Inspect row 3' });
    expect(open.getAttribute('aria-expanded')).toBe('true');
    expect(open.getAttribute('aria-controls')).toBe('sheet');
    expect(open.closest('tr')?.classList.contains('inspected')).toBe(true);
    expect(screen.getByRole('button', { name: 'Inspect row 1' }).getAttribute('aria-controls')).toBeNull();
    fireEvent.click(open);
    expect(onOpenRow).toHaveBeenLastCalledWith(null);
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
    expect([...container.querySelectorAll('tbody tr[data-index] td:not(.inspect-col)')].map((td) => td.textContent)).toEqual([
      'null',
      'Contoso',
    ]);

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

  it('grid_controlled_grouping_renders_and_reports_changes', () => {
    const rows = [
      ['Contoso', 1, null],
      ['Payroll', 2, null],
      ['Contoso', 3, null],
    ];
    const onGroupingChange = vi.fn();
    const { container, rerender } = render(
      <ResultGrid columns={columns} rows={rows} grouping={['displayName']} onGroupingChange={onGroupingChange} />,
    );
    expect(bodyRows(container).map((tr) => tr.textContent)).toEqual(['▸ displayName: Contoso · 2', '▸ displayName: Payroll · 1']);

    fireEvent.click(screen.getByRole('button', { name: 'Group by: displayName' }));
    fireEvent.click(within(screen.getByRole('menu', { name: 'Group by' })).getByRole('menuitemradio', { name: 'No grouping' }));
    expect(onGroupingChange).toHaveBeenLastCalledWith([]);

    // A rerun without the grouped column drops it, once.
    onGroupingChange.mockClear();
    const cols = columns.filter((c) => c.name !== 'displayName');
    rerender(<ResultGrid columns={cols} rows={[[1, null]]} grouping={['displayName']} onGroupingChange={onGroupingChange} />);
    expect(onGroupingChange).toHaveBeenCalledTimes(1);
    expect(onGroupingChange).toHaveBeenCalledWith([]);
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

  it('grid_checkbox_column_selects_rows_through_the_caller', () => {
    const rows = [
      ['Contoso', 1, null],
      ['Payroll', 2, null],
      ['Legacy', 3, null],
    ];
    const onChange = vi.fn();
    const onOpenRow = vi.fn();
    const { container, rerender } = render(
      <ResultGrid columns={columns} rows={rows} onOpenRow={onOpenRow} selection={{ mode: 'multi', selected: new Set(), onChange }} />,
    );
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select row 2' }));
    expect(onChange).toHaveBeenLastCalledWith(new Set([1]));
    expect(onChange).toHaveBeenCalledTimes(1);
    // The inspect button opens the row without toggling its selection.
    fireEvent.click(screen.getByRole('button', { name: 'Inspect row 3' }));
    expect(onOpenRow).toHaveBeenLastCalledWith(2);
    expect(onChange).toHaveBeenCalledTimes(1);

    rerender(
      <ResultGrid columns={columns} rows={rows} onOpenRow={onOpenRow} selection={{ mode: 'multi', selected: new Set([1]), onChange }} />,
    );
    expect(bodyRows(container).map((tr) => tr.getAttribute('aria-selected'))).toEqual(['false', 'true', 'false']);
    expect(screen.getByRole('checkbox', { name: 'Select row 2' })).toHaveProperty('checked', true);
    const all = screen.getByRole('checkbox', { name: 'Select all rows' });
    expect(all).toHaveProperty('indeterminate', true);
    expect(all).toHaveProperty('checked', false);

    // Unchecking it clears that row.
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select row 2' }));
    expect(onChange).toHaveBeenLastCalledWith(new Set());
  });

  it('grid_select_all_selects_only_rows_the_filter_shows', () => {
    const rows = [
      ['Contoso', 1, null],
      ['Payroll', 2, null],
      ['Contoso East', 3, null],
    ];
    const onChange = vi.fn();
    const { rerender } = render(<ResultGrid columns={columns} rows={rows} selection={{ mode: 'multi', selected: new Set(), onChange }} />);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Filter rows' }), { target: { value: 'Contoso' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all rows' }));
    expect(onChange).toHaveBeenLastCalledWith(new Set([0, 2]));

    // With every shown row selected it is checked, and clicking it clears the selection.
    rerender(<ResultGrid columns={columns} rows={rows} selection={{ mode: 'multi', selected: new Set([0, 2]), onChange }} />);
    const all = screen.getByRole('checkbox', { name: 'Select all rows' });
    expect(all).toHaveProperty('checked', true);
    expect(all).toHaveProperty('indeterminate', false);
    fireEvent.click(all);
    expect(onChange).toHaveBeenLastCalledWith(new Set());
  });

  it('grid_single_mode_keeps_one_row', () => {
    const rows = [
      ['Contoso', 1, null],
      ['Payroll', 2, null],
      ['Legacy', 3, null],
    ];
    const onChange = vi.fn();
    const { container } = render(
      <ResultGrid columns={columns} rows={rows} selection={{ mode: 'single', selected: new Set([0]), onChange }} />,
    );
    fireEvent.click(bodyRows(container)[2]!, { ctrlKey: true });
    expect(onChange).toHaveBeenLastCalledWith(new Set([2]));
    fireEvent.click(bodyRows(container)[1]!, { shiftKey: true });
    expect(onChange).toHaveBeenLastCalledWith(new Set([1]));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select row 3' }));
    expect(onChange).toHaveBeenLastCalledWith(new Set([2]));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select row 1' }));
    expect(onChange).toHaveBeenLastCalledWith(new Set());
    expect(screen.queryByRole('checkbox', { name: 'Select all rows' })).toBeNull();
  });

  it('grid_selection_none_has_no_checkboxes_and_selects_nothing', () => {
    const rows = [
      ['Contoso', 1, null],
      ['Payroll', 2, null],
    ];
    const { container, unmount } = render(<ResultGrid columns={columns} rows={rows} selection="none" />);
    expect(screen.queryByRole('checkbox')).toBeNull();
    fireEvent.click(bodyRows(container)[0]!);
    fireEvent.keyDown(screen.getByRole('region', { name: 'Result rows' }), { key: 'ArrowDown' });
    expect(bodyRows(container).map((tr) => tr.getAttribute('aria-selected'))).toEqual(['false', 'false']);
    unmount();

    // The Rows tab's grid, with no selection prop, has no checkbox column either.
    render(<ResultGrid columns={columns} rows={rows} />);
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('grid_reports_shown_rows_in_order', () => {
    const rows = [
      ['Contoso', 1, null],
      ['Payroll', 2, null],
      ['Contoso East', 3, null],
    ];
    const onShownChange = vi.fn();
    render(<ResultGrid columns={columns} rows={rows} onShownChange={onShownChange} />);
    expect(onShownChange).toHaveBeenLastCalledWith([0, 1, 2]);
    // Sort by n descending: two clicks.
    fireEvent.click(screen.getByRole('button', { name: /^n/ }));
    fireEvent.click(screen.getByRole('button', { name: /^n/ }));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Filter rows' }), { target: { value: 'Contoso' } });
    expect(onShownChange).toHaveBeenLastCalledWith([2, 0]);
  });

  it('right-clicking a cell offers Filter by and Exclude; Esc closes the menu and focus goes back to the grid', () => {
    const cols = [
      { name: 'state', type: 'string' },
      { name: 'created', type: 'datetime' },
    ];
    const rows = [['Enabled', '2026-11-10T08:00:00Z']];
    const onFilter = vi.fn();
    render(<ResultGrid columns={cols} rows={rows} onFilter={onFilter} />);

    fireEvent.contextMenu(screen.getByText('Enabled'), { clientX: 40, clientY: 50 });
    const menu = screen.getByRole('menu');
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((b) => b.textContent),
    ).toEqual(['Filter by "Enabled"', 'Exclude "Enabled"']);
    expect(document.activeElement).toBe(within(menu).getByRole('menuitem', { name: 'Filter by "Enabled"' }));
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(document.activeElement?.textContent).toBe('Exclude "Enabled"');
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('region', { name: 'Result rows' }));
    expect(onFilter).not.toHaveBeenCalled();

    fireEvent.contextMenu(screen.getByText('Enabled'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Filter by "Enabled"' }));
    expect(onFilter).toHaveBeenCalledWith(cols[0], 'Enabled', 'eq');
    expect(screen.queryByRole('menu')).toBeNull();

    // A datetime cell has four items.
    fireEvent.contextMenu(screen.getByText('2026-11-10T08:00:00Z'));
    expect(
      within(screen.getByRole('menu'))
        .getAllByRole('menuitem')
        .map((b) => b.textContent),
    ).toEqual([
      'Filter by 2026-11-10T08:00:00Z',
      'Exclude 2026-11-10T08:00:00Z',
      'On or after 2026-11-10T08:00:00Z',
      'Before 2026-11-10T08:00:00Z',
    ]);
  });

  it('a cell menu opens at the pointer, moved by its measured size to stay inside the grid', () => {
    const size = (el: HTMLElement, own: number, parent: number) => (el.getAttribute('role') === 'menu' ? own : parent);
    const spies = [
      vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
        return size(this, 300, 0);
      }),
      vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
        return size(this, 100, 0);
      }),
      vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
        return size(this, 0, 500);
      }),
      vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
        return size(this, 0, 400);
      }),
    ];
    try {
      render(<ResultGrid columns={[{ name: 'state', type: 'string' }]} rows={[['Enabled']]} onFilter={vi.fn()} />);
      fireEvent.contextMenu(screen.getByText('Enabled'), { clientX: 450, clientY: 380 });
      const menu = screen.getByRole('menu');
      expect([menu.style.left, menu.style.top]).toEqual(['200px', '300px']);

      fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
      fireEvent.contextMenu(screen.getByText('Enabled'), { clientX: 40, clientY: 50 });
      expect([screen.getByRole('menu').style.left, screen.getByRole('menu').style.top]).toEqual(['40px', '50px']);
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
  });

  it('without onFilter, right-clicking a cell shows no menu', () => {
    render(<ResultGrid columns={[{ name: 'state', type: 'string' }]} rows={[['Enabled']]} />);
    const event = fireEvent.contextMenu(screen.getByText('Enabled'));
    expect(event).toBe(true);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  describe('column statistics', () => {
    const cols = [
      { name: 'state', type: 'string' },
      { name: 'n', type: 'long' },
    ];
    const rows = [
      ['Enabled', 1],
      ['Enabled', 2],
      ['Disabled', 3],
    ];
    const openStats = (name: string) => {
      fireEvent.click(screen.getByRole('button', { name: `${name} column menu` }));
      fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Column statistics' }));
      return screen.getByRole('dialog', { name: `${name} statistics` });
    };

    it('a header menu opens the statistics of the rows shown', () => {
      const { container } = render(<ResultGrid columns={cols} rows={rows} statistics />);
      const menuButton = screen.getByRole('button', { name: 'state column menu' });
      expect(menuButton.getAttribute('aria-haspopup')).toBe('menu');
      expect(screen.getByRole('button', { name: 'n column menu' })).toBeTruthy();

      fireEvent.change(screen.getByRole('searchbox', { name: 'Filter rows' }), { target: { value: 'En' } });
      expect(bodyRows(container)).toHaveLength(2);
      const dialog = openStats('state');
      expect(within(dialog).getByText('Of 2 rows shown')).toBeTruthy();

      fireEvent.keyDown(dialog, { key: 'Escape' });
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(document.activeElement).toBe(menuButton);
    });

    it('new rows close the statistics', () => {
      const { rerender } = render(<ResultGrid columns={cols} rows={rows} statistics />);
      openStats('n');
      rerender(<ResultGrid columns={cols} rows={[...rows]} statistics />);
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('the sort button still sorts', () => {
      const { container } = render(<ResultGrid columns={cols} rows={rows} statistics />);
      fireEvent.click(screen.getByRole('button', { name: 'state' }));
      expect(bodyRows(container).map((tr) => tr.cells[1]?.textContent)).toEqual(['Disabled', 'Enabled', 'Enabled']);
    });

    it('without statistics there is no header menu', () => {
      render(<ResultGrid columns={cols} rows={rows} />);
      expect(screen.queryByRole('button', { name: /column menu$/ })).toBeNull();
    });
  });

  describe('nested grouping', () => {
    const cols = [
      { name: 'g', type: 'string' },
      { name: 'v', type: 'string' },
      { name: 'n', type: 'long' },
      { name: 'w', type: 'string' },
    ];
    // g: x,x,x,y,z,z. Inside x, v: p,q,q.
    const rows = [
      ['x', 'p', 1, 'a'],
      ['x', 'q', 2, 'a'],
      ['y', 'p', 3, 'a'],
      ['z', 'p', 4, 'a'],
      ['x', 'q', 5, 'a'],
      ['z', 'p', 6, 'a'],
    ];
    const texts = (container: HTMLElement) => bodyRows(container).map((tr) => tr.textContent);
    const headerItem = (column: string, name: string | RegExp) => {
      fireEvent.click(screen.getByRole('button', { name: `${column} column menu` }));
      return within(screen.getByRole('menu', { name: `${column} column` })).getByRole('menuitem', { name });
    };
    const toggle = (name: RegExp) => screen.getByRole('button', { name });

    it('the header menu groups by a column, stops grouping by it, and allows up to 3', () => {
      const { container } = render(<ResultGrid columns={cols} rows={rows} statistics />);
      const menu = () => screen.getByRole('menu', { name: 'g column' });
      fireEvent.click(screen.getByRole('button', { name: 'g column menu' }));
      expect(
        within(menu())
          .getAllByRole('menuitem')
          .map((b) => b.textContent),
      ).toEqual(['Column statistics', 'Group by this column']);
      fireEvent.click(within(menu()).getByRole('menuitem', { name: 'Group by this column' }));
      expect(texts(container)).toEqual(['▸ g: x · 3', '▸ g: z · 2', '▸ g: y · 1']);

      fireEvent.click(headerItem('g', 'Stop grouping by this column'));
      expect(bodyRows(container)).toHaveLength(6);

      fireEvent.click(headerItem('g', 'Group by this column'));
      fireEvent.click(headerItem('v', 'Group by this column'));
      fireEvent.click(headerItem('n', 'Group by this column'));
      expect(screen.getByRole('button', { name: 'Group by' })).toBeTruthy();
      expect(screen.getByText('Grouped by g › v › n')).toBeTruthy();
      const capped = headerItem('w', 'Group by this column');
      expect(capped).toHaveProperty('disabled', true);
      expect(capped.getAttribute('title')).toBe('Up to 3 columns');
    });

    it('the toolbar menu nests the columns checked, in that order, and No grouping clears', () => {
      const { container } = render(<ResultGrid columns={cols} rows={rows} statistics />);
      fireEvent.click(screen.getByRole('button', { name: 'Group by' }));
      const menu = screen.getByRole('menu', { name: 'Group by' });
      fireEvent.click(within(menu).getByRole('menuitemcheckbox', { name: 'g' }));
      fireEvent.click(within(menu).getByRole('menuitemcheckbox', { name: 'v' }));
      expect(within(menu).getByRole('menuitemcheckbox', { name: 'v' }).getAttribute('aria-checked')).toBe('true');
      expect(screen.getByRole('button', { name: 'Group by' })).toBeTruthy();
      expect(screen.getByText('Grouped by g › v')).toBeTruthy();

      fireEvent.click(toggle(/g: x/));
      expect(texts(container)).toEqual(['▾ g: x · 3', '▸ v: q · 2', '▸ v: p · 1', '▸ g: z · 2', '▸ g: y · 1']);

      // Unchecking removes it; at three the others are disabled.
      fireEvent.click(within(menu).getByRole('menuitemcheckbox', { name: 'v' }));
      expect(screen.getByRole('button', { name: 'Group by' })).toBeTruthy();
      expect(screen.getByText('Grouped by g')).toBeTruthy();
      fireEvent.click(within(menu).getByRole('menuitemcheckbox', { name: 'v' }));
      fireEvent.click(within(menu).getByRole('menuitemcheckbox', { name: 'n' }));
      const w = within(menu).getByRole('menuitemcheckbox', { name: 'w' });
      expect(w).toHaveProperty('disabled', true);
      expect(w.getAttribute('title')).toBe('Up to 3 columns');

      fireEvent.click(within(menu).getByRole('menuitem', { name: 'No grouping' }));
      expect(bodyRows(container)).toHaveLength(6);
      expect(screen.getByRole('button', { name: 'Group by' })).toBeTruthy();
    });

    it('a chip says what the rows are grouped by, and clears it', () => {
      const { container } = render(<ResultGrid columns={cols} rows={rows} statistics />);
      expect(screen.queryByText(/^Grouped by/)).toBeNull();
      fireEvent.click(headerItem('g', 'Group by this column'));
      fireEvent.click(headerItem('v', 'Group by this column'));
      expect(screen.getByText('Grouped by g › v')).toBeTruthy();
      expect(screen.getByText('Grouped by g › v').parentElement?.getAttribute('title')).toBe('Grouped by g › v');

      fireEvent.click(screen.getByRole('button', { name: 'Clear grouping' }));
      expect(screen.queryByText(/^Grouped by/)).toBeNull();
      expect(bodyRows(container)).toHaveLength(6);
    });

    it('groups are sorted by size, largest first, at every level, and leaf rows keep the sort (widget grids too)', () => {
      // No statistics: a widget's grid, with its single-column toolbar menu.
      const { container, unmount } = render(<ResultGrid columns={cols} rows={rows} />);
      fireEvent.click(screen.getByRole('button', { name: 'Group by' }));
      fireEvent.click(within(screen.getByRole('menu', { name: 'Group by' })).getByRole('menuitemradio', { name: 'g' }));
      expect(texts(container)).toEqual(['▸ g: x · 3', '▸ g: z · 2', '▸ g: y · 1']);
      // n descending: the leaf rows follow it, the groups keep their size order.
      fireEvent.click(screen.getByRole('button', { name: /^n/ }));
      fireEvent.click(screen.getByRole('button', { name: /^n/ }));
      fireEvent.click(toggle(/g: x/));
      expect(texts(container)).toEqual(['▾ g: x · 3', 'xq5a', 'xq2a', 'xp1a', '▸ g: z · 2', '▸ g: y · 1']);
      unmount();

      const nested = render(<ResultGrid columns={cols} rows={rows} grouping={['g', 'v']} onGroupingChange={vi.fn()} />);
      fireEvent.click(toggle(/g: x/));
      expect(texts(nested.container).slice(0, 3)).toEqual(['▾ g: x · 3', '▸ v: q · 2', '▸ v: p · 1']);
    });

    it('group rows start closed; Right opens and Left closes the focused one; Up/Down select only rows', () => {
      const { container, rerender } = render(<ResultGrid columns={cols} rows={rows} grouping={['g', 'v']} onGroupingChange={vi.fn()} />);
      expect(texts(container)).toEqual(['▸ g: x · 3', '▸ g: z · 2', '▸ g: y · 1']);
      // The arrow is decoration: aria-expanded says whether it is open.
      expect(screen.getByRole('button', { name: 'g: x · 3' })).toBeTruthy();

      fireEvent.keyDown(toggle(/g: x/), { key: 'ArrowRight' });
      expect(toggle(/g: x/).getAttribute('aria-expanded')).toBe('true');
      fireEvent.keyDown(toggle(/v: q/), { key: 'ArrowRight' });
      expect(toggle(/v: q/).getAttribute('aria-expanded')).toBe('true');
      // Left on the open nested group closes it, not its parent.
      fireEvent.keyDown(toggle(/v: q/), { key: 'ArrowLeft' });
      expect(toggle(/v: q/).getAttribute('aria-expanded')).toBe('false');
      expect(toggle(/g: x/).getAttribute('aria-expanded')).toBe('true');
      fireEvent.keyDown(toggle(/g: x/), { key: 'ArrowLeft' });
      expect(toggle(/g: x/).getAttribute('aria-expanded')).toBe('false');

      // Up/Down skip the group rows.
      rerender(<ResultGrid columns={cols} rows={rows} grouping={['g']} onGroupingChange={vi.fn()} />);
      fireEvent.click(toggle(/g: z/));
      fireEvent.click(toggle(/g: y/));
      const region = screen.getByRole('region', { name: 'Result rows' });
      const selectedText = () => bodyRows(container).find((tr) => tr.getAttribute('aria-selected') === 'true')?.textContent;
      fireEvent.keyDown(region, { key: 'ArrowDown' });
      expect(selectedText()).toBe('zp4a');
      fireEvent.keyDown(region, { key: 'ArrowDown' });
      fireEvent.keyDown(region, { key: 'ArrowDown' });
      expect(selectedText()).toBe('yp3a');
      fireEvent.keyDown(region, { key: 'ArrowUp' });
      expect(selectedText()).toBe('zp6a');
    });

    it('new rows close the open groups', () => {
      const { container, rerender } = render(<ResultGrid columns={cols} rows={rows} grouping={['g']} onGroupingChange={vi.fn()} />);
      fireEvent.click(toggle(/g: x/));
      expect(bodyRows(container)).toHaveLength(6);
      rerender(<ResultGrid columns={cols} rows={[...rows]} grouping={['g']} onGroupingChange={vi.fn()} />);
      expect(texts(container)).toEqual(['▸ g: x · 3', '▸ g: z · 2', '▸ g: y · 1']);
    });

    it('right-clicking a group row filters by its first row’s value', () => {
      const onFilter = vi.fn();
      const withNull = [...rows, [null, 'p', 7, 'a']];
      render(<ResultGrid columns={cols} rows={withNull} grouping={['g']} onGroupingChange={vi.fn()} onFilter={onFilter} />);
      fireEvent.contextMenu(toggle(/g: x/));
      fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Filter by "x"' }));
      expect(onFilter).toHaveBeenCalledWith(cols[0], 'x', 'eq');

      fireEvent.contextMenu(toggle(/g: null · 1/));
      expect(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Filter by null' })).toBeTruthy();
    });

    it('without onFilter, right-clicking a group row shows the browser’s menu', () => {
      render(<ResultGrid columns={cols} rows={rows} grouping={['g']} onGroupingChange={vi.fn()} />);
      expect(fireEvent.contextMenu(toggle(/g: x/))).toBe(true);
      expect(screen.queryByRole('menu')).toBeNull();
    });

    it('with groups closed, copy counts and writes every filtered row, ungrouped', () => {
      render(<ResultGrid columns={cols} rows={rows} grouping={['g']} onGroupingChange={vi.fn()} />);
      fireEvent.click(screen.getByRole('button', { name: 'Copy as' }));
      expect(screen.getByText('All 6 rows')).toBeTruthy();
      fireEvent.click(screen.getByRole('menuitem', { name: 'Cells as CSV' }));
      expect(writeText).toHaveBeenLastCalledWith(['x,p,1,a', 'x,q,2,a', 'x,q,5,a', 'z,p,4,a', 'z,p,6,a', 'y,p,3,a'].join('\r\n'));
    });
  });
});
