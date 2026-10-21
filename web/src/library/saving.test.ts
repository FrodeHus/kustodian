import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTabs } from '../tabs/tab-store';
import { MAX_OPEN_BYTES, openDroppedFile, save, saveToFile, saveToLibrary } from './saving';

const bridge = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../bridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../bridge')>()),
  call: bridge.call,
  on: () => () => undefined,
}));

beforeEach(() => {
  bridge.call.mockReset();
  useTabs.setState({ tabs: [], activeId: null, cursors: {} });
});

describe('saving', () => {
  it('save_of_a_tab_whose_saved_query_was_deleted_asks_for_the_dialog', async () => {
    bridge.call.mockResolvedValue({ queries: [], folders: [], skipped: 0 });
    const id = useTabs.getState().openWith({ source: 'graph', title: 'Gone', text: 'users', savedId: 'deleted' });

    expect(await save(id)).toBe('dialog');
    expect(bridge.call).not.toHaveBeenCalledWith('library.save', expect.anything());
  });

  it('save_to_file_cancelled_keeps_the_tab_unsaved', async () => {
    bridge.call.mockResolvedValue(null);
    const id = useTabs.getState().open('graph');
    useTabs.getState().setText(id, 'users');

    expect(await saveToFile(id)).toBe(false);
    expect(bridge.call).toHaveBeenCalledWith('file.saveAs', { suggestedName: 'Query 1.kql', filters: [{ name: 'KQL', extensions: ['kql'] }], content: 'users' });
    expect(useTabs.getState().tabs[0]).toMatchObject({ title: 'Query 1', dirty: true });
  });

  it('save_keeps_the_tab_dirty_when_it_was_typed_into_during_the_save', async () => {
    let answer: (v: unknown) => void = () => undefined;
    bridge.call.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
    const id = useTabs.getState().open('graph');
    useTabs.getState().setText(id, 'users');

    const saving = saveToLibrary(id, 'Users', null);
    useTabs.getState().setText(id, 'users | take 1');
    answer({ id: 'q1', name: 'Users', folder: null, source: 'graph', text: 'users', parameters: [], version: 1, createdAt: '', modifiedAt: '' });
    await saving;

    expect(useTabs.getState().tabs[0]).toMatchObject({ savedId: 'q1', title: 'Users', dirty: true, text: 'users | take 1' });
  });

  it('save_to_file_of_a_library_tab_makes_the_file_where_save_goes', async () => {
    bridge.call.mockImplementation((method: string) =>
      Promise.resolve(method === 'file.saveAs' ? { path: '/q/u.kql', name: 'u.kql' } : { id: 'q1', name: 'Users', folder: null, source: 'graph', text: 'users', parameters: [] }),
    );
    const id = useTabs.getState().openWith({ source: 'graph', title: 'Users', text: 'users', savedId: 'q1' });

    await saveToFile(id);
    expect(useTabs.getState().tabs[0]).toMatchObject({ savedId: undefined, filePath: '/q/u.kql' });

    await saveToLibrary(id, 'Users', null);
    expect(useTabs.getState().tabs[0]).toMatchObject({ savedId: 'q1', filePath: undefined });
  });

  it('dropped_file_over_the_size_limit_is_refused', async () => {
    const big = new File(['x'], 'big.kql');
    Object.defineProperty(big, 'size', { value: MAX_OPEN_BYTES + 1 });

    await expect(openDroppedFile(big)).rejects.toThrow('Files over 5 MB can’t be opened.');
    expect(useTabs.getState().tabs).toHaveLength(0);
  });
});
