import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useRevisions } from '../library/saving';
import type { SolutionDetails } from '../wire';
import { solution } from './fixtures';
import { SolutionDialog } from './solution-dialog';
import { useSolutionDialog } from './solution-store';

const bridge = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../bridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../bridge')>()),
  call: bridge.call,
  on: () => () => undefined,
}));

let details: SolutionDetails;

const caveat = 'Not maintained by Kustodian. Review before running.';

beforeEach(() => {
  details = { manifest: solution().manifest, readme: '# What it answers\n\nWhich users are risky.', installed: null, modified: [] };
  bridge.call.mockReset();
  bridge.call.mockImplementation((method: string) => (method === 'solution.get' ? Promise.resolve(details) : Promise.resolve(null)));
  useSolutionDialog.setState({ id: null, compatible: true });
});

const open = async (compatible = true) => {
  render(<SolutionDialog />);
  useSolutionDialog.getState().open(details.manifest.id, compatible);
  return screen.findByRole('dialog', { name: details.manifest.name });
};

describe('SolutionDialog', () => {
  it('shows the README, the items ticked and no caveat for a Kustodian solution', async () => {
    await open();

    expect(await screen.findByRole('heading', { name: 'What it answers' })).toBeTruthy();
    expect(bridge.call).toHaveBeenCalledWith('solution.get', { id: 'entra-risky-users' });
    expect(screen.getByText('Installs into “Entra risky users”')).toBeTruthy();
    const boxes = screen.getAllByRole('checkbox');
    expect(boxes).toHaveLength(3);
    expect(boxes.every((b) => (b as HTMLInputElement).checked)).toBe(true);
    expect(screen.getByRole('checkbox', { name: /weekly-review/ })).toBeTruthy();
    expect(screen.getByText('Nothing runs on install. Queries and the workbook run when you open them.')).toBeTruthy();
    expect(screen.getByText('3 of 3 items')).toBeTruthy();
    expect(screen.queryByText(caveat)).toBeNull();
  });

  it('a community solution carries the caveat', async () => {
    details.manifest = { ...details.manifest, support: 'community' };
    await open();

    expect(await screen.findByText(caveat)).toBeTruthy();
  });

  it('Install skips the unticked items, bumps the library and closes', async () => {
    const before = useRevisions.getState().library;
    await open();

    fireEvent.click(await screen.findByRole('checkbox', { name: /weekly-review/ }));
    expect(screen.getByText('2 of 3 items')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Install' }));

    expect(bridge.call).toHaveBeenCalledWith('solution.install', { id: 'entra-risky-users', skip: ['weekly-review'] });
    await waitFor(() => expect(useSolutionDialog.getState().id).toBeNull());
    expect(useRevisions.getState().library).toBe(before + 1);
  });

  it('a failed install shows why and stays open', async () => {
    bridge.call.mockImplementation((method: string) =>
      method === 'solution.get' ? Promise.resolve(details) : Promise.reject(new Error('The catalog has no such file.')),
    );
    await open();

    fireEvent.click(await screen.findByRole('button', { name: 'Install' }));

    expect((await screen.findByRole('alert')).textContent).toContain('The catalog has no such file.');
    expect(useSolutionDialog.getState().id).toBe('entra-risky-users');
  });

  it('Install is disabled when the solution needs a newer Kustodian', async () => {
    await open(false);

    expect(((await screen.findByRole('button', { name: 'Install' })) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Needs Kustodian 1.0.0')).toBeTruthy();
  });

  const installedItems = () => ({
    id: 'entra-risky-users',
    solutionVersion: '1.2.0',
    installedAt: '2026-11-01T00:00:00Z',
    items: [
      { kind: 'query' as const, itemId: 'risky-users', libraryId: 'lib-1' },
      { kind: 'query' as const, itemId: 'risky-sign-ins', libraryId: 'lib-2' },
      { kind: 'workbook' as const, itemId: 'weekly-review', libraryId: 'lib-3' },
    ],
  });

  it('Uninstall lists the changed items as staying and sends every one as keep', async () => {
    details.installed = installedItems();
    details.modified = ['lib-1', 'lib-3'];
    const before = useRevisions.getState().library;
    await open();

    expect(await screen.findByText('These stay in Saved as your own.')).toBeTruthy();
    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual(['risky-usersquery', 'weekly-reviewworkbook']);
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Install' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Uninstall' }));

    expect(bridge.call).toHaveBeenCalledWith('solution.uninstall', { id: 'entra-risky-users', keep: ['lib-1', 'lib-3'] });
    await waitFor(() => expect(useSolutionDialog.getState().id).toBeNull());
    expect(useRevisions.getState().library).toBe(before + 1);
  });

  it('Uninstall with nothing changed has no staying line and keeps nothing', async () => {
    details.installed = installedItems();
    await open();

    fireEvent.click(await screen.findByRole('button', { name: 'Uninstall' }));

    expect(screen.queryByText('These stay in Saved as your own.')).toBeNull();
    expect(bridge.call).toHaveBeenCalledWith('solution.uninstall', { id: 'entra-risky-users', keep: [] });
  });

  it('an installed solution without its README says so and still uninstalls', async () => {
    details.installed = installedItems();
    details.readme = '';
    await open();

    expect(await screen.findByText('Kustodian couldn’t load the README.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Uninstall' }));
    expect(bridge.call).toHaveBeenCalledWith('solution.uninstall', { id: 'entra-risky-users', keep: [] });
  });

  it('takes focus and gives it back on close', async () => {
    render(
      <>
        <button type="button">Row</button>
        <SolutionDialog />
      </>,
    );
    screen.getByRole('button', { name: 'Row' }).focus();
    useSolutionDialog.getState().open('entra-risky-users');

    const cancel = await screen.findByRole('button', { name: 'Cancel' });
    expect(document.activeElement).toBe(cancel);
    fireEvent.click(cancel);

    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Row' })));
  });

  it('Cancel and Escape close it', async () => {
    await open();
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(useSolutionDialog.getState().id).toBeNull();

    useSolutionDialog.getState().open('entra-risky-users');
    fireEvent.keyDown(await screen.findByRole('dialog'), { key: 'Escape' });
    expect(useSolutionDialog.getState().id).toBeNull();
  });
});
