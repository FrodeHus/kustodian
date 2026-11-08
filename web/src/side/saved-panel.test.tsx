import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTabs } from '../tabs/tab-store';
import type { LibraryList, SavedQuery, WorkbookList } from '../wire';
import { newWorkbook } from '../workbooks/model';
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

  it('saved_folds_queries_sharing_a_name_prefix_under_it', async () => {
    library = {
      queries: [
        query('a', 'Break glass / Role assignments', 'Identity'),
        query('b', 'Break glass / Sign-ins', 'Identity'),
        query('c', 'MFA / Adoption', 'Identity'),
        query('d', 'Break glass / Loose', null),
      ],
      folders: ['Identity'],
      skipped: 0,
    };
    render(<SavedPanel />);

    const group = await screen.findByRole('button', { name: 'Break glass', expanded: true });
    const rows = group.nextElementSibling as HTMLElement;
    // Shown without the prefix, still named in full.
    expect(within(rows).getByRole('button', { name: 'Break glass / Sign-ins' }).textContent).toBe('Sign-ins');
    expect(within(rows).queryByRole('button', { name: 'Break glass / Loose' })).toBeNull();
    // A prefix no other query in the folder shares stays in the name.
    expect(screen.getByRole('button', { name: 'MFA / Adoption' }).textContent).toBe('MFA / Adoption');
    expect(screen.queryByRole('button', { name: 'MFA' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Break glass / Loose' }).textContent).toBe('Break glass / Loose');

    fireEvent.click(group);
    expect(screen.queryByRole('button', { name: 'Break glass / Sign-ins' })).toBeNull();
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

  it('panels_follow_active_source_with_all_toggle', async () => {
    library = {
      ...library,
      queries: [...library.queries, { ...query('q3', 'TOR sign-ins', null, 'AADSignInEventsBeta'), source: 'hunting' }],
    };
    const view = render(<SavedPanel source="hunting" />);

    // A hunting tab's panel lists the hunting queries only.
    await screen.findByRole('button', { name: 'TOR sign-ins' });
    expect(screen.queryByRole('button', { name: 'All apps' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Identity' })).toBeNull();

    // "All sources" lists every query, each with its source's badge.
    const all = screen.getByRole('button', { name: 'All sources' });
    expect(all.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(all);
    expect(all.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'All apps' })).toBeTruthy();
    expect(within(screen.getByRole('button', { name: 'TOR sign-ins' })).getByText('AH')).toBeTruthy();

    // The Graph tab's panel, without the toggle, lists Graph's.
    fireEvent.click(all);
    view.rerender(<SavedPanel source="graph" />);
    expect(await screen.findByRole('button', { name: 'All apps' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'TOR sign-ins' })).toBeNull();
  });

  it('saved_lists_workbooks_opens_one_in_a_workbook_tab_and_deletes_after_asking', async () => {
    const doc = { ...newWorkbook('Hygiene'), modifiedAt: '2026-11-01T00:00:00Z' };
    const workbooks: WorkbookList = { workbooks: [{ id: doc.id, name: 'Hygiene', folder: null, modifiedAt: doc.modifiedAt, widgets: 0 }], folders: [], skipped: 0 };
    const answer = bridge.call.getMockImplementation()!;
    bridge.call.mockImplementation((method: string, params?: { id?: string }) => {
      switch (method) {
        case 'workbook.list':
          return Promise.resolve(workbooks);
        case 'workbook.get':
          return Promise.resolve({ workbook: params?.id === doc.id ? doc : null });
        case 'workbook.delete':
          workbooks.workbooks = [];
          return Promise.resolve(null);
        default:
          return answer(method, params);
      }
    });
    render(<SavedPanel />);

    fireEvent.click(await screen.findByRole('tab', { name: /Workbooks/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Hygiene' }));
    await waitFor(() => expect(useTabs.getState().tabs).toHaveLength(1));
    expect(bridge.call).toHaveBeenCalledWith('workbook.get', { id: doc.id });
    expect(useTabs.getState().tabs[0]).toMatchObject({ source: 'workbook', title: 'Hygiene', savedId: doc.id, workbook: doc, dirty: false });

    fireEvent.click(screen.getByRole('button', { name: 'More for Hygiene' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    fireEvent.click(within(screen.getByRole('group', { name: 'Delete “Hygiene”?' })).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(bridge.call).toHaveBeenCalledWith('workbook.delete', { id: doc.id }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Hygiene' })).toBeNull());
    // The open tab stays, as an unsaved workbook: its next save asks for a name and folder instead of writing the file back.
    expect(useTabs.getState().tabs[0]).toMatchObject({ source: 'workbook', title: 'Hygiene', dirty: true });
    expect(useTabs.getState().tabs[0]?.savedId).toBeUndefined();
  });

  it('saved_groups_workbooks_by_their_folder_in_the_workbooks_tab', async () => {
    library = { queries: [], folders: [], skipped: 0 };
    const summary = (id: string, name: string, folder: string | null) => ({ id, name, folder, modifiedAt: '2026-11-01T00:00:00Z', widgets: 0 });
    // "Identity" is also a query folder name elsewhere; the workbook folder folds on its own.
    const workbooks: WorkbookList = { workbooks: [summary('w1', 'Hygiene', 'Identity'), summary('w2', 'Costs', null)], folders: ['Identity'], skipped: 0 };
    const answer = bridge.call.getMockImplementation()!;
    bridge.call.mockImplementation((method: string, params?: { id?: string }) => (method === 'workbook.list' ? Promise.resolve(workbooks) : answer(method, params)));
    render(<SavedPanel />);
    expect(await screen.findByText(/No saved queries yet/)).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: /Workbooks/ }));

    const group = await screen.findByRole('button', { name: 'Identity', expanded: true });
    const folderList = group.nextElementSibling as HTMLElement;
    expect(within(folderList).getByRole('button', { name: 'Hygiene' })).toBeTruthy();
    expect(within(folderList).queryByRole('button', { name: 'Costs' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Costs' })).toBeTruthy();
    expect(screen.queryByText(/No workbooks yet/)).toBeNull();

    fireEvent.click(group);
    expect(screen.getByRole('button', { name: 'Identity', expanded: false })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Hygiene' })).toBeNull();
  });

  it('saved_import_button_asks_for_a_workbook_file_and_shows_a_refusal', async () => {
    library = { queries: [], folders: [], skipped: 0 };
    const answer = bridge.call.getMockImplementation()!;
    bridge.call.mockImplementation((method: string, params?: { id?: string }) =>
      method === 'file.open' ? Promise.resolve({ path: '/x/a.json', name: 'a.json', text: 'not json' }) : answer(method, params),
    );
    render(<SavedPanel />);

    fireEvent.click(await screen.findByRole('tab', { name: /Workbooks/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Import workbook…' }));

    expect(bridge.call).toHaveBeenCalledWith('file.open', { filters: [{ name: 'Kustodian workbook', extensions: ['json'] }] });
    expect((await screen.findByRole('alert')).textContent).toContain('The workbook couldn’t be imported: ');
  });
});
