import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTabs } from '../tabs/tab-store';
import type { LibraryList, SavedQuery } from '../wire';
import { SavedPanel } from './saved-panel';

const bridge = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../bridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../bridge')>()),
  call: bridge.call,
  on: () => () => undefined,
}));

const query = (id: string, name: string, folder: string | null, text = 'users'): SavedQuery => ({
  version: 1,
  id,
  name,
  folder,
  source: 'graph',
  text,
  parameters: [{ name: 'days', type: 'number', value: '90', required: true, choices: null }],
  createdAt: '2026-10-01T00:00:00Z',
  modifiedAt: '2026-10-01T00:00:00Z',
});

let library: LibraryList;

beforeEach(() => {
  library = {
    queries: [query('q1', 'Stale guests', 'Identity', 'users | where userType == "Guest"'), query('q2', 'All apps', null, 'applications')],
    folders: ['Identity'],
    skipped: 0,
  };
  bridge.call.mockReset();
  bridge.call.mockImplementation((method: string, params?: { query?: SavedQuery; id?: string }) => {
    switch (method) {
      case 'library.list':
        return Promise.resolve(library);
      case 'library.save': {
        const saved = { ...(params?.query as SavedQuery) };
        library = { ...library, queries: library.queries.map((q) => (q.id === saved.id ? saved : q)) };
        return Promise.resolve(saved);
      }
      case 'library.delete':
        library = { ...library, queries: library.queries.filter((q) => q.id !== params?.id) };
        return Promise.resolve(null);
      default:
        return Promise.resolve(null);
    }
  });
  useTabs.setState({ tabs: [], activeId: null, cursors: {} });
});

describe('SavedPanel', () => {
  it('saved_open_creates_tab_from_query', async () => {
    render(<SavedPanel />);

    expect(await screen.findByRole('button', { name: 'Identity', expanded: true })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Stale guests' }));

    const { tabs, activeId } = useTabs.getState();
    expect(tabs).toHaveLength(1);
    expect(tabs[0]).toMatchObject({
      id: activeId,
      title: 'Stale guests',
      text: 'users | where userType == "Guest"',
      savedId: 'q1',
      source: 'graph',
      dirty: false,
      parameters: [{ name: 'days', type: 'number', value: '90', required: true, choices: null }],
    });

    // Opening it again goes to the tab already open.
    fireEvent.click(screen.getByRole('button', { name: 'Stale guests' }));
    expect(useTabs.getState().tabs).toHaveLength(1);
  });

  it('saved_folders_collapse_and_search_filters', async () => {
    render(<SavedPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Identity', expanded: true }));
    expect(screen.queryByRole('button', { name: 'Stale guests' })).toBeNull();
    expect(screen.getByRole('button', { name: 'All apps' })).toBeTruthy();

    fireEvent.change(screen.getByRole('searchbox', { name: 'Find a saved query' }), { target: { value: 'stale' } });
    // A search shows matches in folders too.
    expect(screen.getByRole('button', { name: 'Stale guests' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'All apps' })).toBeNull();
  });

  it('saved_rename_saves_and_retitles_open_tabs', async () => {
    render(<SavedPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'All apps' }));
    const tabId = useTabs.getState().activeId!;

    fireEvent.click(screen.getByRole('button', { name: 'More for All apps' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
    const input = screen.getByRole('textbox', { name: 'New name for All apps' });
    fireEvent.change(input, { target: { value: 'Every app' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(bridge.call).toHaveBeenCalledWith('library.save', { query: expect.objectContaining({ id: 'q2', name: 'Every app', text: 'applications' }) }));
    expect(await screen.findByRole('button', { name: 'Every app' })).toBeTruthy();
    expect(useTabs.getState().tabs.find((t) => t.id === tabId)?.title).toBe('Every app');
  });

  it('saved_delete_asks_first', async () => {
    render(<SavedPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'More for All apps' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));

    const confirm = screen.getByRole('group', { name: 'Delete “All apps”?' });
    expect(bridge.call).not.toHaveBeenCalledWith('library.delete', expect.anything());
    fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'All apps' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'More for All apps' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    fireEvent.click(within(screen.getByRole('group', { name: 'Delete “All apps”?' })).getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(bridge.call).toHaveBeenCalledWith('library.delete', { id: 'q2' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'All apps' })).toBeNull());
  });

  it('saved_says_when_files_were_skipped', async () => {
    library = { ...library, skipped: 2 };
    render(<SavedPanel />);
    expect(await screen.findByText('2 saved queries couldn’t be read and were moved aside.')).toBeTruthy();
  });
});
