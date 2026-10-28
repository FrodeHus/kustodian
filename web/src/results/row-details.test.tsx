import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RowDetails } from './row-details';

const columns = [
  { name: 'displayName', type: 'string' },
  { name: 'appRoles', type: 'dynamic' },
  { name: 'owner', type: 'string' },
];
const row = ['HR Connector', [{ value: 'Employees.Read.All', isEnabled: true }], null];

const writeText = vi.fn<(text: string) => Promise<void>>();

beforeEach(() => {
  writeText.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
});

afterEach(() => {
  Reflect.deleteProperty(navigator, 'clipboard');
});

describe('RowDetails', () => {
  it('row_details_expands_dynamic', async () => {
    render(<RowDetails columns={columns} row={row} onClose={() => undefined} />);
    const sheet = screen.getByRole('dialog', { name: 'Row details: HR Connector' });

    expect(within(sheet).getByText('appRoles · dynamic')).toBeTruthy();
    // The first level of the tree starts open.
    const tree = within(sheet).getByRole('group', { name: 'appRoles' });
    expect(within(tree).getByRole('button', { name: '0: {2 keys}' }).getAttribute('aria-expanded')).toBe('true');
    expect(tree.textContent).toContain('"value": "Employees.Read.All"');
    expect(tree.textContent).toContain('"isEnabled": true');
    expect(within(sheet).getByText('owner · string')).toBeTruthy();
    expect(within(sheet).getByText('null')).toBeTruthy();

    fireEvent.click(within(sheet).getByRole('button', { name: 'Copy appRoles' }));
    expect(writeText).toHaveBeenLastCalledWith(JSON.stringify(row[1], null, 2));
    expect(await within(sheet).findByText('Copied appRoles.')).toBeTruthy();

    fireEvent.click(within(sheet).getByRole('button', { name: 'Copy row as JSON' }));
    expect(JSON.parse(writeText.mock.lastCall?.[0] ?? '')).toEqual({ displayName: 'HR Connector', appRoles: row[1], owner: null });
  });

  it('row_details_is_not_modal_and_tab_cycles_inside', () => {
    const onClose = vi.fn();
    render(
      <>
        <button type="button">Outside</button>
        <RowDetails columns={columns} row={row} onClose={onClose} />
      </>,
    );
    const sheet = screen.getByRole('dialog');
    expect(sheet.getAttribute('aria-modal')).toBeNull();
    const close = screen.getByRole('button', { name: 'Close row details' });
    expect(document.activeElement).toBe(close);

    // Tab from the last button wraps to the first, Shift+Tab from the first to the last.
    const buttons = within(sheet).getAllByRole('button');
    buttons.at(-1)!.focus();
    fireEvent.keyDown(buttons.at(-1)!, { key: 'Tab' });
    expect(document.activeElement).toBe(buttons[0]);
    fireEvent.keyDown(buttons[0]!, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(buttons.at(-1));

    // Focus may leave it, as into the editor.
    screen.getByRole('button', { name: 'Outside' }).focus();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Outside' }));

    fireEvent.keyDown(sheet, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('row_details_opens_and_closes_the_tree', () => {
    const value = { id: 7, owners: [{ name: 'Ada', roles: ['admin'] }], tags: [], note: null };
    render(<RowDetails columns={[{ name: 'app', type: 'dynamic' }]} row={[value]} onClose={() => undefined} />);
    const tree = screen.getByRole('group', { name: 'app' });

    // The value's own entries show, and the first level under them; deeper ones start closed and say how many they hold.
    expect(tree.textContent).toContain('"id": 7');
    expect(tree.textContent).toContain('"tags": []');
    expect(tree.textContent).toContain('"note": null');
    const owners = within(tree).getByRole('button', { name: 'owners: [1 item]' });
    expect(owners.getAttribute('aria-expanded')).toBe('true');
    const first = within(tree).getByRole('button', { name: '0: {2 keys}' });
    expect(first.getAttribute('aria-expanded')).toBe('false');
    expect(tree.textContent).not.toContain('Ada');

    fireEvent.click(first);
    expect(first.getAttribute('aria-expanded')).toBe('true');
    expect(tree.textContent).toContain('"name": "Ada"');
    fireEvent.click(owners);
    expect(owners.getAttribute('aria-expanded')).toBe('false');
    expect(tree.textContent).not.toContain('Ada');

    // Expand all opens every level; Collapse goes back to the first.
    fireEvent.click(screen.getByRole('button', { name: 'Expand app' }));
    const all = screen.getByRole('group', { name: 'app' });
    expect(all.textContent).toContain('"admin"');
    expect(within(all).getAllByRole('button').every((b) => b.getAttribute('aria-expanded') === 'true')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Collapse app' }));
    expect(screen.getByRole('group', { name: 'app' }).textContent).not.toContain('Ada');
  });

  it('row_details_shows_a_cut_dynamic_value_as_text', () => {
    const cut = `${'{"id": 1, "blob": "'.padEnd(998, 'x')}…`;
    render(<RowDetails columns={[{ name: 'app', type: 'dynamic' }]} row={[cut]} onClose={() => undefined} />);

    expect(screen.queryByRole('group', { name: 'app' })).toBeNull();
    expect(document.querySelector('pre')?.textContent).toBe(cut);
    expect(screen.getByText('Cut to 1,000 characters, so it shows as text.')).toBeTruthy();
  });

  it('row_details_says_when_copy_fails', async () => {
    Reflect.deleteProperty(navigator, 'clipboard');
    render(<RowDetails columns={columns} row={row} onClose={() => undefined} />);

    fireEvent.click(screen.getByRole('button', { name: 'Copy displayName' }));

    expect((await screen.findByRole('alert')).textContent).toBe('Couldn’t copy: the clipboard isn’t available here.');
  });
});
