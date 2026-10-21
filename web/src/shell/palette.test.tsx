import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTabs } from '../tabs/tab-store';
import type { LibraryList, SavedQuery, Snippet } from '../wire';
import { registerCommands } from './commands';
import { Palette } from './palette';

const bridge = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../bridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../bridge')>()),
  call: bridge.call,
  on: () => () => undefined,
}));

const staleGuests: SavedQuery = {
  version: 1,
  id: 's1',
  name: 'Stale guests',
  folder: null,
  source: 'graph',
  text: 'users | where userType == "Guest"',
  parameters: [{ name: 'days', type: 'number', value: '90', required: true, choices: null }],
  createdAt: '2026-10-01T00:00:00Z',
  modifiedAt: '2026-10-01T00:00:00Z',
};

const expiredCreds: Snippet = {
  id: 'n1',
  source: 'graph',
  name: 'Expired app credentials',
  description: '',
  text: 'applications | mv-expand passwordCredentials',
  builtIn: true,
  group: null,
  parameters: [],
};

let unregister: () => void = () => undefined;
const explain = vi.fn();
const runAll = vi.fn();

beforeEach(() => {
  explain.mockReset();
  runAll.mockReset();
  bridge.call.mockReset();
  bridge.call.mockImplementation((method: string) =>
    Promise.resolve(
      method === 'library.list' ? ({ queries: [staleGuests], folders: [], skipped: 0 } satisfies LibraryList) : { snippets: [expiredCreds] },
    ),
  );
  useTabs.setState({ tabs: [], activeId: null, cursors: {} });
  useTabs.getState().open('graph');
  unregister = registerCommands([
    { id: 'query.explain', title: 'Explain the query', group: 'Query', shortcut: 'Mod+E', run: explain },
    { id: 'run.all', title: 'Run all', group: 'Run', shortcut: 'Shift+Enter', run: runAll },
    { id: 'export.csv', title: 'Export results as CSV', group: 'Results', run: () => undefined },
    { id: 'palette', title: 'Command palette', group: 'Window', shortcut: 'Mod+K, Mod+Shift+P', run: () => undefined },
  ]);
});

afterEach(() => unregister());

const rows = () => screen.getAllByRole('option');
const titles = () => rows().map((r) => r.querySelector('[data-title]')?.textContent);

describe('Palette', () => {
  it('palette_filters_by_subsequence_and_runs_on_enter', async () => {
    const onClose = vi.fn();
    render(<Palette onClose={onClose} onInsert={() => false} />);
    const input = screen.getByRole('combobox', { name: 'Type a command' });
    await screen.findByText('Snippet: Expired app credentials');

    fireEvent.change(input, { target: { value: 'exp' } });
    expect(titles()).toEqual(['Explain the query', 'Export results as CSV', 'Snippet: Expired app credentials']);
    expect(rows()[0]?.getAttribute('aria-selected')).toBe('true');

    // Letters needn't be next to each other.
    fireEvent.change(input, { target: { value: 'rnall' } });
    expect(titles()).toEqual(['Run all']);

    fireEvent.change(input, { target: { value: 'exp' } });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(explain).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('palette_lists_shortcuts', async () => {
    render(<Palette onClose={() => undefined} onInsert={() => false} />);
    await screen.findByText('Saved: Stale guests');

    const explainRow = rows().find((r) => r.textContent?.includes('Explain the query'))!;
    expect(within(explainRow).getAllByText(/Ctrl/).map((k) => k.textContent)).toEqual(['Ctrl E']);
    const paletteRow = rows().find((r) => r.textContent?.includes('Command palette'))!;
    expect(within(paletteRow).getAllByText(/Ctrl/).map((k) => k.textContent)).toEqual(['Ctrl K', 'Ctrl Shift P']);
    // Each row names its group.
    expect(within(explainRow).getByText('Query')).toBeTruthy();
    expect(within(rows().find((r) => r.textContent?.includes('Stale guests'))!).getByText('Saved')).toBeTruthy();
    expect(within(rows().find((r) => r.textContent?.includes('Expired app'))!).getByText('Snippets')).toBeTruthy();
  });

  it('escape_closes_and_arrow_keys_move', async () => {
    const onClose = vi.fn();
    render(<Palette onClose={onClose} onInsert={() => false} />);
    const input = screen.getByRole('combobox', { name: 'Type a command' });
    await screen.findByText('Saved: Stale guests');

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(rows()[1]?.getAttribute('aria-selected')).toBe('true');
    expect(input.getAttribute('aria-activedescendant')).toBe(rows()[1]?.id);
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('a_saved_query_opens_in_a_new_tab', async () => {
    render(<Palette onClose={() => undefined} onInsert={() => false} />);
    const input = screen.getByRole('combobox', { name: 'Type a command' });
    await screen.findByText('Saved: Stale guests');

    fireEvent.change(input, { target: { value: 'stale' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    const { tabs, activeId } = useTabs.getState();
    expect(tabs).toHaveLength(2);
    expect(tabs[1]).toMatchObject({ id: activeId, title: 'Stale guests', text: staleGuests.text, savedId: 's1', dirty: false, parameters: staleGuests.parameters });
  });

  it('a_snippet_inserts_at_the_cursor_or_opens_with_shift_enter', async () => {
    const onInsert = vi.fn();
    render(<Palette onClose={() => undefined} onInsert={onInsert} />);
    const input = screen.getByRole('combobox', { name: 'Type a command' });
    await screen.findByText('Snippet: Expired app credentials');

    fireEvent.change(input, { target: { value: 'expired' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onInsert).toHaveBeenCalledWith(expiredCreds.text);
    expect(useTabs.getState().tabs).toHaveLength(1);

    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(onInsert).toHaveBeenCalledTimes(1);
    expect(useTabs.getState().tabs[1]).toMatchObject({ title: 'Expired app credentials', text: expiredCreds.text, savedId: undefined });
  });

  it('a_saved_query_already_open_switches_to_its_tab', async () => {
    const open = useTabs.getState().openWith({ source: 'graph', title: 'Stale guests', text: 'edited', savedId: 's1' });
    useTabs.getState().open('graph');
    render(<Palette onClose={() => undefined} onInsert={() => false} />);
    const input = screen.getByRole('combobox', { name: 'Type a command' });
    await screen.findByText('Saved: Stale guests');

    fireEvent.change(input, { target: { value: 'stale' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    const { tabs, activeId } = useTabs.getState();
    expect(tabs).toHaveLength(3);
    expect(activeId).toBe(open);
    expect(tabs.find((t) => t.id === open)?.text).toBe('edited');
  });

  it('a_snippet_merges_its_parameters_only_when_it_went_in', async () => {
    const withParams: Snippet = {
      ...expiredCreds,
      text: 'applications | where createdDateTime > ago({days})',
      parameters: [{ name: 'days', type: 'timespan', value: '30d', required: true, choices: null }],
    };
    bridge.call.mockImplementation((method: string) =>
      Promise.resolve(method === 'library.list' ? { queries: [], folders: [], skipped: 0 } : { snippets: [withParams] }),
    );
    const onInsert = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    const onProblem = vi.fn();
    render(<Palette onClose={() => undefined} onInsert={onInsert} onProblem={onProblem} />);
    const input = screen.getByRole('combobox', { name: 'Type a command' });
    await screen.findByText('Snippet: Expired app credentials');
    const tab = () => useTabs.getState().tabs[0]!;

    // The editor wasn't ready: nothing went in, so no parameters either, and the palette says so.
    fireEvent.change(input, { target: { value: 'expired' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(tab().parameters).toEqual([]);
    expect(onProblem).toHaveBeenCalledWith('The editor isn’t ready yet. Try again in a moment.');

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onInsert).toHaveBeenCalledTimes(2);
    expect(tab().parameters).toEqual(withParams.parameters);
  });

  it('palette_is_modal_and_keeps_focus', async () => {
    const outside = document.createElement('button');
    document.body.append(outside);
    render(<Palette onClose={() => undefined} onInsert={() => false} />);
    const dialog = screen.getByRole('dialog', { name: 'Command palette' });
    const input = screen.getByRole('combobox', { name: 'Type a command' });
    await screen.findByText('Saved: Stale guests');

    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(document.activeElement).toBe(input);

    // Tab doesn't leave it, and focus moved outside comes back.
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    input.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true);
    outside.focus();
    expect(document.activeElement).toBe(input);

    // Clicking a row doesn't take focus from the input.
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    rows()[0]!.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    outside.remove();
  });

  it('closing_lets_focus_go_where_the_caller_puts_it', async () => {
    const editor = document.createElement('textarea');
    document.body.append(editor);
    render(<Palette onClose={() => editor.focus()} onInsert={() => false} />);
    await screen.findByText('Saved: Stale guests');

    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Type a command' }), { key: 'Escape' });

    expect(document.activeElement).toBe(editor);
    editor.remove();
  });

  it('palette_shows_each_saved_query_and_snippet_source', async () => {
    bridge.call.mockImplementation((method: string) =>
      Promise.resolve(
        method === 'library.list'
          ? ({ queries: [{ ...staleGuests, source: 'hunting' }], folders: [], skipped: 0 } satisfies LibraryList)
          : { snippets: [expiredCreds, { ...expiredCreds, id: 'a1', source: 'arg', name: 'Public storage accounts' }] },
      ),
    );
    render(<Palette onClose={() => undefined} onInsert={() => false} />);
    await screen.findByText('Snippet: Public storage accounts');

    const row = (text: string) => rows().find((r) => r.textContent?.includes(text))!;
    expect(within(row('Stale guests')).getByTitle('Defender advanced hunting').textContent).toBe('AH');
    expect(within(row('Public storage')).getByTitle('Azure Resource Graph').textContent).toBe('ARG');
    expect(within(row('Expired app')).getByTitle('Microsoft Graph').textContent).toBe('GR');
    // Commands have no source.
    expect(within(row('Run all')).queryByTitle(/Graph|hunting/)).toBeNull();
  });
});
