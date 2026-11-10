import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Tab } from '../tabs/tab-store';
import { useTabs } from '../tabs/tab-store';
import type { RunResult, WorkbookSummary } from '../wire';
import { AddToWorkbookDialog } from './add-to-workbook-dialog';
import { MAX_WIDGETS } from './model';

const bridge = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../bridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../bridge')>()),
  call: bridge.call,
  on: () => () => undefined,
}));
const applyAdd = vi.hoisted(() => vi.fn());
vi.mock('./apply-add', () => ({ applyAdd }));

const summary = (id: string, name: string, folder: string | null, widgets = 1): WorkbookSummary => ({
  id,
  name,
  folder,
  modifiedAt: '2026-11-01T00:00:00Z',
  widgets,
});

const result = (columns: [string, string][], rows: unknown[][]): RunResult =>
  ({ outcome: 'ok', columns: columns.map(([name, type]) => ({ name, type })), rows }) as unknown as RunResult;

const tabOf = (over: Partial<Tab> = {}): Tab =>
  ({
    id: 'q1',
    source: 'graph',
    title: 'Sign-ins',
    text: 'SignIns | take 5',
    dirty: false,
    parameters: [],
    history: [],
    run: {
      state: 'done',
      runId: 'r',
      startedAt: 0,
      origin: { line: 1, column: 1 },
      kql: 'SignIns | take 5',
      result: result([['n', 'long']], [[1], [2]]),
    },
    ...over,
  }) as Tab;

const onClose = vi.fn();
const onNotice = vi.fn();
function open(tab = tabOf()) {
  return render(<AddToWorkbookDialog tab={tab} onClose={onClose} onNotice={onNotice} />);
}
const addButton = () => screen.getByRole('button', { name: 'Add' }) as HTMLButtonElement;

beforeEach(() => {
  onClose.mockReset();
  onNotice.mockReset();
  applyAdd.mockReset();
  bridge.call.mockReset();
  bridge.call.mockImplementation((method: string) =>
    method === 'workbook.list'
      ? Promise.resolve({
          workbooks: [
            summary('a', 'Ops', 'My Team'),
            summary('b', 'Audit', 'My Team'),
            summary('c', 'Loose', null),
            summary('d', 'Big', null, MAX_WIDGETS),
          ],
          folders: ['My Team'],
          skipped: 0,
        })
      : Promise.resolve(null),
  );
  useTabs.setState({ tabs: [], activeId: null, resultViews: {} });
});

describe('AddToWorkbookDialog', () => {
  it('is a labelled dialog with focus in the search box', async () => {
    open();
    expect(screen.getByRole('dialog', { name: 'Add to workbook' })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('searchbox', { name: 'Find a workbook' }));
    await screen.findByRole('radio', { name: 'Ops' });
  });

  it('lists the workbooks by folder, and searching narrows the list', async () => {
    open();
    const team = await screen.findByRole('group', { name: 'My Team' });
    expect(
      within(team)
        .getAllByRole('radio')
        .map((r) => r.closest('label')!.textContent),
    ).toEqual(['Audit', 'Ops']);
    // The first workbook shown that isn't full, not the host's first.
    expect((screen.getByRole('radio', { name: 'Loose' }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole('radio', { name: 'Loose' })).toBeTruthy();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Find a workbook' }), { target: { value: 'op' } });
    expect(screen.getByRole('radio', { name: 'Ops' })).toBeTruthy();
    expect(screen.queryByRole('radio', { name: 'Audit' })).toBeNull();
    expect(screen.queryByRole('radio', { name: 'Loose' })).toBeNull();
    expect(screen.getByRole('radio', { name: 'New workbook' })).toBeTruthy();
  });

  it('disables a full workbook and says why', async () => {
    open();
    const big = (await screen.findByRole('radio', { name: 'Big (full)' })) as HTMLInputElement;
    expect(big.disabled).toBe(true);
    expect(big.closest('label')!.title).toBe('This workbook is full');
  });

  it('adds nothing when the search hides the chosen workbook', async () => {
    open();
    await screen.findByRole('radio', { name: 'Ops' });
    fireEvent.change(screen.getByRole('searchbox', { name: 'Find a workbook' }), { target: { value: 'audit' } });
    expect(addButton().disabled).toBe(true);
    fireEvent.submit(screen.getByRole('dialog'));
    expect(applyAdd).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Find a workbook' }), { target: { value: '' } });
    expect((screen.getByRole('radio', { name: 'Loose' }) as HTMLInputElement).checked).toBe(true);
    expect(addButton().disabled).toBe(false);
  });

  it('defaults to New when every workbook is full', async () => {
    bridge.call.mockResolvedValue({ workbooks: [summary('d', 'Big', null, MAX_WIDGETS)], folders: [], skipped: 0 });
    open();
    await screen.findByRole('radio', { name: 'Big (full)' });
    expect((screen.getByRole('radio', { name: 'New workbook' }) as HTMLInputElement).checked).toBe(true);
  });

  it('needs a name for a new workbook before Add', async () => {
    open();
    fireEvent.click(await screen.findByRole('radio', { name: 'New workbook' }));
    expect(addButton().disabled).toBe(true);
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'Fresh' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Folder' }), { target: { value: 'Team' } });
    expect(addButton().disabled).toBe(false);
    applyAdd.mockResolvedValue({});
    fireEvent.click(addButton());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(applyAdd.mock.calls[0]![0]).toEqual({ kind: 'new', name: 'Fresh', folder: 'Team' });
  });

  it('defaults the widget to Chart when the tab shows its chart', async () => {
    useTabs.setState({ resultViews: { q1: { view: 'chart' } } });
    open();
    await screen.findByRole('radio', { name: 'Ops' });
    expect((screen.getByRole('radio', { name: 'Chart' }) as HTMLInputElement).checked).toBe(true);
  });

  it('defaults the widget to Stat for a single number, and Table otherwise', async () => {
    const { unmount } = open(tabOf({ run: { ...tabOf().run!, result: result([['n', 'long']], [[7]]) } }));
    expect((screen.getByRole('radio', { name: 'Stat' }) as HTMLInputElement).checked).toBe(true);
    await screen.findByRole('radio', { name: 'Ops' });
    unmount();
    open();
    expect((screen.getByRole('radio', { name: 'Table' }) as HTMLInputElement).checked).toBe(true);
    await screen.findByRole('radio', { name: 'Ops' });
  });

  it('falls back to the tab’s title when the title is left empty', async () => {
    applyAdd.mockResolvedValue({});
    open();
    fireEvent.click(await screen.findByRole('radio', { name: 'Ops' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), { target: { value: '   ' } });
    fireEvent.click(addButton());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(applyAdd.mock.calls[0]![1]).toMatchObject({ title: 'Sign-ins' });
  });

  it('defaults the title to the tab’s', async () => {
    open();
    expect((screen.getByRole('textbox', { name: 'Title' }) as HTMLInputElement).value).toBe('Sign-ins');
    await screen.findByRole('radio', { name: 'Ops' });
  });

  it('says to save a dirty saved query first to link it', async () => {
    const { unmount } = open(tabOf({ savedId: 's', dirty: true }));
    expect(screen.getByText('Save the query first to link it.')).toBeTruthy();
    await screen.findByRole('radio', { name: 'Ops' });
    unmount();
    open(tabOf({ savedId: 's' }));
    expect(screen.queryByText('Save the query first to link it.')).toBeNull();
    await screen.findByRole('radio', { name: 'Ops' });
  });

  it('says to save first, and copies the block, when the run was one of two blocks', async () => {
    applyAdd.mockResolvedValue({});
    open(tabOf({ savedId: 's', text: 'Other | take 1\n\nSignIns | take 5' }));
    expect(screen.getByText('Save the query first to link it.')).toBeTruthy();
    fireEvent.click(await screen.findByRole('radio', { name: 'Ops' }));
    fireEvent.click(addButton());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(applyAdd.mock.calls[0]![1]).toMatchObject({ query: { text: 'SignIns | take 5', saved: null } });
  });

  it('clears the last add’s notice when an add starts', async () => {
    applyAdd.mockResolvedValue({ notice: 'Added to your unsaved changes in Ops.' });
    open();
    fireEvent.click(await screen.findByRole('radio', { name: 'Ops' }));
    fireEvent.click(addButton());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onNotice.mock.calls).toEqual([[null], ['Added to your unsaved changes in Ops.']]);
  });

  it('cancels on Esc', async () => {
    open();
    await screen.findByRole('radio', { name: 'Ops' });
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
    expect(applyAdd).not.toHaveBeenCalled();
  });

  it('adds to the chosen workbook with the widget and closes', async () => {
    applyAdd.mockResolvedValue({});
    open(tabOf({ parameters: [{ name: 'p', type: 'text', value: '', required: false }] }));
    fireEvent.click(await screen.findByRole('radio', { name: 'Ops' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Stat' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), { target: { value: 'Count' } });
    fireEvent.click(addButton());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const [target, widget, params] = applyAdd.mock.calls[0]!;
    expect(target).toEqual({ kind: 'existing', id: 'a', name: 'Ops' });
    expect(widget).toMatchObject({ type: 'stat', title: 'Count', query: { text: 'SignIns | take 5' } });
    expect(params).toEqual([{ name: 'p', type: 'text', value: '', required: false }]);
  });

  it('shows why it couldn’t add and stays open', async () => {
    applyAdd.mockRejectedValue(new Error('Ops no longer exists.'));
    open();
    fireEvent.click(await screen.findByRole('radio', { name: 'Ops' }));
    fireEvent.click(addButton());
    expect((await screen.findByRole('alert')).textContent).toContain('The query couldn’t be added: Ops no longer exists.');
    expect(onClose).not.toHaveBeenCalled();
  });
});
