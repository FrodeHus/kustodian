import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useRevisions } from '../library/saving';
import type { Catalog } from '../wire';
import { solution } from './fixtures';
import { useSolutionDialog } from './solution-store';
import { SolutionsPanel } from './solutions-panel';

const bridge = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../bridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../bridge')>()),
  call: bridge.call,
  on: () => () => undefined,
}));

const fetchedAt = '2026-11-07T10:42:00Z';
const when = new Date(fetchedAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

let catalog: Catalog;

beforeEach(() => {
  catalog = {
    solutions: [
      solution(),
      solution(
        { id: 'vm-power', name: 'VM power hygiene', support: 'community', sources: ['arg'], content: { queries: ['a'], workbooks: [], tools: [] } },
        { installedVersion: '1.0.0' },
      ),
      solution({ id: 'ca-gaps', name: 'Conditional Access gaps', support: 'community', minAppVersion: '1.1.0' }, { compatible: false }),
      solution({ id: 'old-one', name: 'Installed but outgrown', minAppVersion: '9.0.0' }, { compatible: false, installedVersion: '1.0.0' }),
    ],
    fetchedAt,
    offline: false,
  };
  bridge.call.mockReset();
  bridge.call.mockImplementation((method: string) => (method === 'solution.list' ? Promise.resolve(catalog) : Promise.resolve(null)));
  useSolutionDialog.setState({ id: null });
});

describe('SolutionsPanel', () => {
  it('rows show name, support, item counts and state', async () => {
    render(<SolutionsPanel />);

    const risky = await screen.findByRole('button', { name: /Entra risky users/ });
    expect(risky.textContent).toContain('Kustodian');
    expect(risky.textContent).toContain('2 queries · 1 workbook');
    const vms = screen.getByRole('button', { name: /VM power hygiene/ });
    expect(vms.textContent).toContain('Community');
    expect(vms.textContent).toContain('1 query');
    expect(vms.textContent).toContain('Installed');
    expect(screen.getByRole('button', { name: /Conditional Access gaps/ }).textContent).toContain('Needs Kustodian 1.1.0');
    // Installed wins over incompatible: the user has it.
    const outgrown = screen.getByRole('button', { name: /Installed but outgrown/ }).textContent;
    expect(outgrown).toContain('Installed');
    expect(outgrown).not.toContain('Needs Kustodian');
    expect(screen.getByText(`Catalog fetched ${when}`)).toBeTruthy();
    expect(bridge.call).toHaveBeenCalledWith('solution.list', { refresh: false });
  });

  it('offline shows the time of the cached catalog', async () => {
    catalog.offline = true;
    render(<SolutionsPanel />);

    expect(await screen.findByText(`Showing the catalog from ${when}. Kustodian couldn't reach GitHub.`)).toBeTruthy();
  });

  it('a failed list shows the error, and Refresh asks again with refresh', async () => {
    bridge.call.mockRejectedValueOnce(new Error('No network.'));
    render(<SolutionsPanel />);

    expect((await screen.findByRole('alert')).textContent).toContain('No network.');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

    expect(bridge.call).toHaveBeenLastCalledWith('solution.list', { refresh: true });
    expect(await screen.findByRole('button', { name: /Entra risky users/ })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('the filters narrow the list', async () => {
    render(<SolutionsPanel />);
    await screen.findByRole('button', { name: /Entra risky users/ });

    fireEvent.change(screen.getByRole('combobox', { name: 'Show' }), { target: { value: 'installed' } });
    expect(screen.queryByRole('button', { name: /Entra risky users/ })).toBeNull();
    expect(screen.getByRole('button', { name: /VM power hygiene/ })).toBeTruthy();

    fireEvent.change(screen.getByRole('combobox', { name: 'Show' }), { target: { value: '' } });
    fireEvent.change(screen.getByRole('searchbox', { name: 'Find a solution' }), { target: { value: 'conditional' } });
    expect(screen.getAllByRole('button', { name: /gaps|hygiene|risky/ })).toHaveLength(1);
  });

  it('a library change reloads the list, so an install shows', async () => {
    render(<SolutionsPanel />);
    expect((await screen.findByRole('button', { name: /Entra risky users/ })).textContent).not.toContain('Installed');

    catalog = { ...catalog, solutions: catalog.solutions.map((s, i) => (i === 0 ? { ...s, installedVersion: '1.2.0' } : s)) };
    act(() => useRevisions.getState().bump('library'));

    await waitFor(() => expect(screen.getByRole('button', { name: /Entra risky users/ }).textContent).toContain('Installed'));
  });

  it('clicking a row opens its dialog', async () => {
    render(<SolutionsPanel />);

    fireEvent.click(await screen.findByRole('button', { name: /VM power hygiene/ }));

    expect(useSolutionDialog.getState().id).toBe('vm-power');
  });
});
