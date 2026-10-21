import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTabs } from '../tabs/tab-store';
import type { Snippet } from '../wire';
import { SnippetPanel } from './snippet-panel';

const bridge = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../bridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../bridge')>()),
  call: bridge.call,
  on: () => () => undefined,
}));

const builtIn: Snippet = {
  id: 'b1',
  source: 'graph',
  name: 'Expired app credentials',
  description: 'Secrets that ended.',
  text: 'applications | where x < now() - {graceDays}',
  builtIn: true,
  group: 'Identity checks',
  parameters: [{ name: 'graceDays', type: 'timespan', value: '0d', required: false, choices: ['0d', '7d'] }],
};

const mine: Snippet = {
  id: 'm1',
  source: 'graph',
  name: 'Owners of an app',
  description: '',
  text: 'applications | where appId == {appId}',
  builtIn: false,
  group: null,
  parameters: [],
};

let snippets: Snippet[];

beforeEach(() => {
  snippets = [builtIn, mine];
  bridge.call.mockReset();
  bridge.call.mockImplementation((method: string, params?: { snippet?: Snippet; id?: string }) => {
    switch (method) {
      case 'snippets.list':
        return Promise.resolve({ snippets });
      case 'snippets.save': {
        const saved = { ...(params?.snippet as Snippet), id: 'm2', builtIn: false };
        snippets = [...snippets, saved];
        return Promise.resolve(saved);
      }
      case 'snippets.delete':
        snippets = snippets.filter((s) => s.id !== params?.id);
        return Promise.resolve(null);
      default:
        return Promise.resolve(null);
    }
  });
  useTabs.setState({ tabs: [], activeId: null, cursors: {} });
  useTabs.getState().open('graph');
});

describe('SnippetPanel', () => {
  it('snippet_click_inserts_at_cursor', async () => {
    const onInsert = vi.fn(() => true);
    render(<SnippetPanel onInsert={onInsert} />);

    expect(await screen.findByRole('heading', { name: 'Built in · Identity checks' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Mine' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Expired app credentials' }));

    expect(onInsert).toHaveBeenCalledWith('applications | where x < now() - {graceDays}');
    expect(useTabs.getState().tabs).toHaveLength(1);
    // The snippet's parameter definitions come along.
    expect(useTabs.getState().tabs[0]?.parameters).toEqual(builtIn.parameters);
  });

  it('snippet_click_before_the_editor_is_ready_changes_nothing', async () => {
    render(<SnippetPanel onInsert={() => false} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Expired app credentials' }));

    expect(screen.getByRole('alert').textContent).toBe('The editor isn’t ready yet. Try again in a moment.');
    expect(useTabs.getState().tabs).toHaveLength(1);
    expect(useTabs.getState().tabs[0]?.parameters).toEqual([]);
  });

  it('snippet_open_in_new_tab_uses_its_parameters', async () => {
    render(<SnippetPanel onInsert={() => true} />);
    fireEvent.click(await screen.findByRole('button', { name: 'More for Expired app credentials' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open in new tab' }));

    const { tabs, activeId } = useTabs.getState();
    expect(tabs).toHaveLength(2);
    expect(tabs[1]).toMatchObject({ id: activeId, title: 'Expired app credentials', text: builtIn.text, parameters: builtIn.parameters });
  });

  it('snippet_search_filters', async () => {
    render(<SnippetPanel onInsert={() => true} />);
    await screen.findByRole('button', { name: 'Owners of an app' });
    fireEvent.change(screen.getByRole('searchbox', { name: 'Find a snippet' }), { target: { value: 'owner' } });
    expect(screen.queryByRole('button', { name: 'Expired app credentials' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Owners of an app' })).toBeTruthy();
  });

  it('snippet_save_selection_saves_a_snippet', async () => {
    const id = useTabs.getState().activeId!;
    useTabs.getState().setText(id, 'users | where id == {userId}');
    useTabs.getState().setParameters(id, [{ name: 'userId', type: 'text', value: 'abc', required: true, choices: null }]);
    render(<SnippetPanel onInsert={() => true} />);
    const save = await screen.findByRole('button', { name: 'Save the selection as a snippet' });
    expect(save).toHaveProperty('disabled', true);

    useTabs.getState().setCursor(id, { line: 1, column: 1, selection: 'where id == {userId}', selectionLine: 1, selectionColumn: 9 });
    await waitFor(() => expect(save).toHaveProperty('disabled', false));
    fireEvent.click(save);
    const form = screen.getByRole('form', { name: 'New snippet' });
    fireEvent.change(within(form).getByRole('textbox', { name: 'Snippet name' }), { target: { value: 'By user' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save snippet' }));

    await waitFor(() =>
      expect(bridge.call).toHaveBeenCalledWith('snippets.save', {
        snippet: {
          id: null,
          source: 'graph',
          name: 'By user',
          description: '',
          text: 'where id == {userId}',
          group: null,
          parameters: [{ name: 'userId', type: 'text', value: 'abc', required: true, choices: null }],
        },
      }),
    );
    expect(await screen.findByRole('button', { name: 'By user' })).toBeTruthy();
  });

  it('snippet_delete_of_mine_asks_first', async () => {
    render(<SnippetPanel onInsert={() => true} />);
    fireEvent.click(await screen.findByRole('button', { name: 'More for Owners of an app' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    fireEvent.click(within(screen.getByRole('group', { name: 'Delete “Owners of an app”?' })).getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(bridge.call).toHaveBeenCalledWith('snippets.delete', { id: 'm1' }));
    // A built-in snippet can't be deleted.
    fireEvent.click(screen.getByRole('button', { name: 'More for Expired app credentials' }));
    expect(screen.queryByRole('menuitem', { name: 'Delete' })).toBeNull();
  });
});
