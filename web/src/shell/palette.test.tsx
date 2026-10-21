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
    render(<Palette onClose={onClose} onInsert={() => undefined} />);
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
    render(<Palette onClose={() => undefined} onInsert={() => undefined} />);
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
    render(<Palette onClose={onClose} onInsert={() => undefined} />);
    const input = screen.getByRole('combobox', { name: 'Type a command' });
    await screen.findByText('Saved: Stale guests');

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(rows()[1]?.getAttribute('aria-selected')).toBe('true');
    expect(input.getAttribute('aria-activedescendant')).toBe(rows()[1]?.id);
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('a_saved_query_opens_in_a_new_tab', async () => {
    render(<Palette onClose={() => undefined} onInsert={() => undefined} />);
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
});
