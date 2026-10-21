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
    expect(sheet.querySelector('pre')?.textContent).toBe(JSON.stringify(row[1], null, 2));
    expect(sheet.querySelector('pre')?.textContent).toContain('    "isEnabled": true');
    expect(within(sheet).getByText('owner · string')).toBeTruthy();
    expect(within(sheet).getByText('null')).toBeTruthy();

    fireEvent.click(within(sheet).getByRole('button', { name: 'Copy appRoles' }));
    expect(writeText).toHaveBeenLastCalledWith(JSON.stringify(row[1], null, 2));
    expect(await within(sheet).findByText('Copied appRoles.')).toBeTruthy();

    fireEvent.click(within(sheet).getByRole('button', { name: 'Copy row as JSON' }));
    expect(JSON.parse(writeText.mock.lastCall?.[0] ?? '')).toEqual({ displayName: 'HR Connector', appRoles: row[1], owner: null });
  });

  it('row_details_closes_on_escape_and_keeps_focus_inside', () => {
    const onClose = vi.fn();
    render(
      <>
        <button type="button">Outside</button>
        <RowDetails columns={columns} row={row} onClose={onClose} />
      </>,
    );
    const sheet = screen.getByRole('dialog');
    expect(sheet.contains(document.activeElement)).toBe(true);

    screen.getByRole('button', { name: 'Outside' }).focus();
    expect(sheet.contains(document.activeElement)).toBe(true);

    fireEvent.keyDown(sheet, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('row_details_says_when_copy_fails', async () => {
    Reflect.deleteProperty(navigator, 'clipboard');
    render(<RowDetails columns={columns} row={row} onClose={() => undefined} />);

    fireEvent.click(screen.getByRole('button', { name: 'Copy displayName' }));

    expect((await screen.findByRole('alert')).textContent).toBe('Couldn’t copy: the clipboard isn’t available here.');
  });
});
