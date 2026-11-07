import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BridgeError } from '../bridge';
import { useTabs } from '../tabs/tab-store';
import { newWorkbook } from './model';
import { SaveWorkbookDialog } from './save-workbook-dialog';
import { useWorkbooks } from './workbook-store';

const bridge = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../bridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../bridge')>()),
  call: bridge.call,
  on: () => () => undefined,
}));

beforeEach(() => {
  bridge.call.mockReset();
  bridge.call.mockImplementation((method: string) => {
    switch (method) {
      case 'workbook.list':
        return Promise.resolve({ workbooks: [], folders: ['Ops'], skipped: 0 });
      case 'library.list':
        return Promise.resolve({ queries: [], folders: [], skipped: 0 });
      case 'workbook.save':
        return Promise.reject(new BridgeError('bad_request', 'A folder can’t contain /.'));
      default:
        return Promise.resolve(null);
    }
  });
  useTabs.setState({ tabs: [], activeId: null, cursors: {} });
  useWorkbooks.setState({ byTab: {} });
});

describe('SaveWorkbookDialog', () => {
  it('shows the host’s refusal and stays open', async () => {
    const id = useTabs.getState().openWorkbook(newWorkbook('Workbook 1'));
    useWorkbooks.setState({ byTab: { [id]: { doc: useTabs.getState().tabs[0]!.workbook!, values: { workbook: {}, widgets: {} }, runs: {}, editing: false, undo: [], redo: [], dirty: true, selections: {}, history: {}, since: {} } } });
    const onClose = vi.fn();
    render(<SaveWorkbookDialog tab={useTabs.getState().tabs[0]!} onClose={onClose} />);

    fireEvent.change(screen.getByLabelText('Folder'), { target: { value: 'a/b' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('A folder can’t contain /.'));
    await waitFor(() => expect(bridge.call).toHaveBeenCalledWith('workbook.save', { workbook: expect.objectContaining({ name: 'Workbook 1', folder: 'a/b' }) }));
    expect(onClose).not.toHaveBeenCalled();
  });
});
