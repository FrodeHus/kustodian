import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BridgeError } from '../bridge';
import { useTabs } from '../tabs/tab-store';
import type { LibraryList, SavedQuery } from '../wire';
import { SaveDialog } from './save-dialog';

const bridge = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../bridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../bridge')>()),
  call: bridge.call,
  on: () => () => undefined,
}));

let tabId: string;

beforeEach(() => {
  bridge.call.mockReset();
  bridge.call.mockImplementation((method: string, params?: { query?: SavedQuery }) => {
    switch (method) {
      case 'library.list':
        return Promise.resolve({ queries: [], folders: ['Identity', 'Apps'], skipped: 0 } satisfies LibraryList);
      case 'library.save':
        return Promise.resolve({ ...params?.query, id: 'new-id', version: 1, createdAt: '', modifiedAt: '' });
      case 'file.saveAs':
        return Promise.resolve({ path: '/tmp/stale.kql', name: 'stale.kql' });
      default:
        return Promise.resolve(null);
    }
  });
  useTabs.setState({ tabs: [], activeId: null, cursors: {} });
  tabId = useTabs.getState().open('graph');
  useTabs.getState().setText(tabId, 'users | take {n}');
  useTabs.getState().setParameters(tabId, [{ name: 'n', type: 'number', value: '3', required: false, choices: null }]);
});

const tab = () => useTabs.getState().tabs.find((t) => t.id === tabId)!;

describe('SaveDialog', () => {
  it('save_dialog_saves_to_library_with_a_new_folder', async () => {
    const onClose = vi.fn();
    render(<SaveDialog tab={tab()} onClose={onClose} />);
    const dialog = screen.getByRole('dialog', { name: 'Save the query' });
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveProperty('value', 'Query 1');
    // The existing folders are offered; a new one can be typed.
    await waitFor(() => expect([...dialog.querySelectorAll('datalist option')].map((o) => o.getAttribute('value'))).toEqual(['Identity', 'Apps']));

    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'Few users' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Folder' }), { target: { value: 'Mine' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save to library' }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(bridge.call).toHaveBeenCalledWith('library.save', {
      query: {
        id: null,
        name: 'Few users',
        folder: 'Mine',
        source: 'graph',
        text: 'users | take {n}',
        parameters: [{ name: 'n', type: 'number', value: '3', required: false, choices: null }],
      },
    });
    expect(tab()).toMatchObject({ title: 'Few users', savedId: 'new-id', dirty: false });
  });

  it('save_dialog_saves_to_file', async () => {
    const onClose = vi.fn();
    render(<SaveDialog tab={tab()} onClose={onClose} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'stale' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save to file' }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(bridge.call).toHaveBeenCalledWith('file.saveAs', {
      suggestedName: 'stale.kql',
      filters: [{ name: 'KQL', extensions: ['kql'] }],
      content: 'users | take {n}',
    });
    expect(tab()).toMatchObject({ title: 'stale.kql', filePath: '/tmp/stale.kql', dirty: false });
  });

  it('save_dialog_shows_why_the_host_refused', async () => {
    bridge.call.mockImplementation((method: string) =>
      method === 'library.save'
        ? Promise.reject(new BridgeError('bad_request', 'The folder must be 1 to 64 characters and have no /.'))
        : Promise.resolve({ queries: [], folders: [], skipped: 0 }),
    );
    const onClose = vi.fn();
    render(<SaveDialog tab={tab()} onClose={onClose} />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Folder' }), { target: { value: 'a/b' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save to library' }));

    expect((await screen.findByRole('alert')).textContent).toBe('The folder must be 1 to 64 characters and have no /.');
    expect(onClose).not.toHaveBeenCalled();
    expect(tab().dirty).toBe(true);
  });
});
