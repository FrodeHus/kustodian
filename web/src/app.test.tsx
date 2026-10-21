import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './app';
import { BridgeError } from './bridge';
import schema from './fixtures/graph-schema.json';
import { runCommand } from './shell/commands';
import { applyTheme } from './shell/theme';
import { useTabs } from './tabs/tab-store';
import type { AccountInfo, AccountList, RunResult, SavedQuery, Session, SettingsAnswer } from './wire';

const bridge = vi.hoisted(() => ({ call: vi.fn(), handlers: new Map<string, Set<(data: unknown) => void>>() }));
vi.mock('./bridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./bridge')>()),
  call: bridge.call,
  on: (event: string, handler: (data: unknown) => void) => {
    const set = bridge.handlers.get(event) ?? new Set();
    bridge.handlers.set(event, set);
    set.add(handler);
    return () => set.delete(handler);
  },
}));

/** Sends a host event to the page, as the bridge does. */
const emit = (event: string, data: unknown) => act(() => bridge.handlers.get(event)?.forEach((h) => h(data)));

// Monaco doesn't run in jsdom: a text area stands in for the editor, wired to the store the same way.
vi.mock('./editor/kql-editor', async () => {
  const { useTabs: tabs } = await import('./tabs/tab-store');
  return {
    default: function FakeEditor() {
      const id = tabs((s) => s.activeId);
      const text = tabs((s) => s.tabs.find((t) => t.id === id)?.text ?? '');
      return <textarea aria-label="KQL query" value={text} onChange={(e) => id && tabs.getState().setText(id, e.target.value)} />;
    },
  };
});

const kari: AccountInfo = {
  key: 'k1',
  username: 'kari@contoso.com',
  tenantName: 'Contoso Ltd',
  tenantId: 't1',
  clientId: '04b07795-8ddb-461a-bbee-02f9e1bf7b46',
  active: true,
  expired: false,
  scopes: ['Application.Read.All'],
};

const rows: RunResult = {
  outcome: 'ok',
  message: null,
  error: null,
  columns: [{ name: 'displayName', type: 'string' }],
  rows: [['Contoso Portal']],
  total: 1,
  tables: [],
  durationMs: 40,
  droppedValues: 0,
  runId: 'run-1',
  diagnostics: [],
};

const settings: SettingsAnswer = {
  settings: { version: 1, theme: 'dark', rawDefaultVersion: 'beta', signIn: { clientId: null, tenant: null }, limits: {} },
  restartNeeded: false,
  corrupt: false,
};

/** Answers for methods a test sets up itself, consulted before {@link host}'s own. */
let answers: Record<string, (params: unknown) => unknown> = {};

function host(list: AccountList, run: RunResult | Promise<RunResult> = rows, session: Session | null = null) {
  bridge.call.mockImplementation((method: string, params?: { settings?: unknown }) => {
    const answer = answers[method];
    if (answer) {
      return Promise.resolve(answer(params));
    }
    switch (method) {
      case 'session.get':
        return Promise.resolve(session && { session, corrupt: false });
      case 'settings.get':
        return Promise.resolve(settings);
      case 'settings.set':
        return Promise.resolve({ ...settings, settings: params?.settings });
      case 'account.list':
        return Promise.resolve(list);
      case 'schema.get':
        return Promise.resolve(schema);
      case 'query.run':
        return Promise.resolve(run);
      case 'library.list':
        return Promise.resolve({ queries: [], folders: [], skipped: 0 });
      case 'recent.list':
        return Promise.resolve({ runs: [] });
      case 'snippets.list':
        return Promise.resolve({ snippets: [] });
      default:
        return Promise.resolve(null);
    }
  });
}

beforeEach(() => {
  answers = {};
  bridge.call.mockReset();
  useTabs.setState({ tabs: [], activeId: null, cursors: {} });
});

afterEach(() => applyTheme('dark'));

describe('App', () => {
  it('app_without_an_active_account_shows_sign_in', async () => {
    host({ accounts: [], cache: 'persistent' });
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Sign in to Microsoft Graph' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Not signed in' })).toBeTruthy();
  });

  it('app_when_accounts_cannot_be_read_shows_sign_in_with_the_error', async () => {
    bridge.call.mockImplementation((method: string) => {
      if (method === 'account.list') {
        return Promise.reject(new BridgeError('failed', 'The keychain is locked.'));
      }
      return method === 'schema.get' ? Promise.resolve(schema) : Promise.resolve(kari);
    });
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Sign in to Microsoft Graph' })).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toBe('The accounts couldn’t be read: The keychain is locked.');

    // Signing in works, but the accounts still can't be read: the screen stays.
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with your browser' }));
    await waitFor(() => expect(bridge.call.mock.calls.filter((c) => c[0] === 'account.list')).toHaveLength(2));
    expect(screen.getByRole('heading', { name: 'Sign in to Microsoft Graph' })).toBeTruthy();
  });

  it('app_opens_a_graph_tab_runs_it_and_shows_rows', async () => {
    host({ accounts: [kari], cache: 'persistent' });
    render(<App />);

    expect(await screen.findByRole('tab', { name: /Query 1/ })).toBeTruthy();
    expect(await screen.findByRole('searchbox', { name: 'Find a table or column' })).toHaveProperty('placeholder', 'Find among 5 tables');
    fireEvent.change(await screen.findByRole('textbox', { name: 'KQL query' }), { target: { value: 'applications' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run all Shift Enter' }));

    await waitFor(() => expect(screen.getByRole('tab', { name: 'Rows · 1' })).toBeTruthy());
    expect(within(screen.getByRole('table')).getByText('Contoso Portal')).toBeTruthy();
    expect(bridge.call).toHaveBeenCalledWith('query.run', expect.objectContaining({ kql: 'applications', source: 'graph' }), expect.any(AbortSignal));
  });

  it('app_export_command_saves_the_result_and_pin_adds_compare', async () => {
    host({ accounts: [kari], cache: 'persistent' });
    answers['file.saveAs'] = () => ({ path: '/tmp/Query 1.json', name: 'Query 1.json' });
    render(<App />);

    fireEvent.change(await screen.findByRole('textbox', { name: 'KQL query' }), { target: { value: 'applications' } });
    // Before a run there is nothing to export.
    expect(runCommand('results.export.json')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Run all Shift Enter' }));
    await screen.findByRole('tab', { name: 'Rows · 1' });

    expect(runCommand('results.export.json')).toBe(true);
    await waitFor(() =>
      expect(bridge.call).toHaveBeenCalledWith('file.saveAs', {
        suggestedName: 'Query 1.json',
        filters: [{ name: 'JSON', extensions: ['json'] }],
        content: JSON.stringify([{ displayName: 'Contoso Portal' }], null, 2),
      }),
    );

    act(() => {
      runCommand('results.pin');
    });
    expect(screen.getByRole('tab', { name: 'Compare' })).toBeTruthy();
    act(() => {
      runCommand('results.unpin');
    });
    expect(screen.queryByRole('tab', { name: 'Compare' })).toBeNull();
  });

  it('app_palette_opens_over_row_details_and_keeps_focus', async () => {
    host({ accounts: [kari], cache: 'persistent' });
    render(<App />);
    fireEvent.change(await screen.findByRole('textbox', { name: 'KQL query' }), { target: { value: 'applications' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run all Shift Enter' }));
    await screen.findByRole('tab', { name: 'Rows · 1' });

    fireEvent.doubleClick(within(screen.getByRole('region', { name: 'Result rows' })).getByText('Contoso Portal'));
    const close = screen.getByRole('button', { name: 'Close row details' });
    expect(document.activeElement).toBe(close);

    fireEvent.keyDown(close, { key: 'k', code: 'KeyK', ctrlKey: true });

    const input = screen.getByRole('combobox', { name: 'Type a command' });
    expect(screen.queryByRole('dialog', { name: /Row details/ })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(input));
  });

  it('app_sign_in_needed_opens_sign_in_and_keeps_the_query', async () => {
    host({ accounts: [kari], cache: 'persistent' }, { ...rows, outcome: 'signInNeeded', message: 'Sign in again to run this query.', rows: [], columns: [], total: 0 });
    render(<App />);

    fireEvent.change(await screen.findByRole('textbox', { name: 'KQL query' }), { target: { value: 'users | count' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run all Shift Enter' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in' }));
    expect(screen.getByRole('heading', { name: 'Sign in to Microsoft Graph' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '← Back to queries' }));
    expect(screen.getByRole('textbox', { name: 'KQL query' })).toHaveProperty('value', 'users | count');
  });

  it('app_restores_the_last_session', async () => {
    host({ accounts: [kari], cache: 'persistent' }, rows, {
      version: 1,
      activeId: 'b',
      tabs: [
        { id: 'a', source: 'graph', title: 'Apps', text: 'applications', dirty: false, savedId: null, parameters: [], filePath: null },
        { id: 'b', source: 'graph', title: 'Draft', text: 'users | take 3', dirty: true, savedId: null, parameters: [], filePath: null },
      ],
    });
    render(<App />);

    expect(await screen.findByRole('tab', { name: /Draft/, selected: true })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Apps/ })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'KQL query' })).toHaveProperty('value', 'users | take 3');
    expect(screen.queryByRole('tab', { name: /Query 1/ })).toBeNull();
  });

  it('app_progress_for_the_current_run_shows_and_a_stale_one_does_not', async () => {
    let answer: (r: RunResult) => void = () => undefined;
    host({ accounts: [kari], cache: 'persistent' }, new Promise<RunResult>((resolve) => (answer = resolve)));
    render(<App />);

    fireEvent.change(await screen.findByRole('textbox', { name: 'KQL query' }), { target: { value: 'users' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run all Shift Enter' }));
    const tabId = useTabs.getState().activeId;
    const runId = useTabs.getState().tabs[0]?.run?.runId;

    emit('query.progress', { tabId, runId: '00000000-0000-0000-0000-000000000000', stage: 'fetching', detail: 'groups' });
    expect(screen.queryByText('Fetching groups')).toBeNull();
    emit('query.progress', { tabId, runId, stage: 'fetching', detail: 'users' });
    expect(screen.getByText('Fetching users')).toBeTruthy();
    await act(async () => answer(rows));
  });

  it('app_palette_opens_with_ctrl_k_and_switches_the_theme', async () => {
    host({ accounts: [kari], cache: 'persistent' });
    render(<App />);
    await screen.findByRole('tab', { name: /Query 1/ });
    expect(screen.getByRole('contentinfo').textContent).toContain('Dark');

    fireEvent.keyDown(window, { key: 'k', code: 'KeyK', ctrlKey: true });
    const input = screen.getByRole('combobox', { name: 'Type a command' });
    fireEvent.change(input, { target: { value: 'theme light' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(screen.queryByRole('dialog', { name: 'Command palette' })).toBeNull();
    expect(document.documentElement.classList.contains('theme-light')).toBe(true);
    expect(screen.getByRole('contentinfo').textContent).toContain('Light');
    await waitFor(() => expect(bridge.call).toHaveBeenCalledWith('settings.set', { settings: { ...settings.settings, theme: 'light' } }));
  });

  it('app_ctrl_t_opens_a_graph_tab', async () => {
    host({ accounts: [kari], cache: 'persistent' });
    render(<App />);
    await screen.findByRole('tab', { name: /Query 1/ });

    fireEvent.keyDown(window, { key: 't', code: 'KeyT', ctrlKey: true });

    expect(await screen.findByRole('tab', { name: /Query 2/, selected: true })).toBeTruthy();
  });

  it('app_shortcuts_do_nothing_while_sign_in_covers_the_workspace', async () => {
    host({ accounts: [], cache: 'persistent' });
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Sign in to Microsoft Graph' })).toBeTruthy();
    await waitFor(() => expect(useTabs.getState().tabs).toHaveLength(1));

    fireEvent.keyDown(window, { key: 't', code: 'KeyT', ctrlKey: true });
    fireEvent.keyDown(window, { key: 'k', code: 'KeyK', ctrlKey: true });

    expect(useTabs.getState().tabs).toHaveLength(1);
    expect(screen.queryByRole('dialog', { name: 'Command palette' })).toBeNull();
  });

  it('app_while_the_palette_is_open_only_escape_works', async () => {
    host({ accounts: [kari], cache: 'persistent' });
    render(<App />);
    await screen.findByRole('tab', { name: /Query 1/ });

    fireEvent.keyDown(window, { key: 'k', code: 'KeyK', ctrlKey: true });
    const input = screen.getByRole('combobox', { name: 'Type a command' });
    // Not from a text field, so only the open palette stops these.
    fireEvent.keyDown(window, { key: 't', code: 'KeyT', ctrlKey: true });
    fireEvent.keyDown(window, { key: 'f', code: 'KeyF', shiftKey: true, altKey: true });
    expect(useTabs.getState().tabs).toHaveLength(1);
    expect(screen.getAllByRole('dialog', { name: 'Command palette' })).toHaveLength(1);

    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Command palette' })).toBeNull();
  });
  it('rail_switches_panels_and_marks_pressed', async () => {
    host({ accounts: [kari], cache: 'persistent' });
    render(<App />);
    await screen.findByRole('tab', { name: /Query 1/ });
    const rail = screen.getByRole('navigation', { name: 'Side panels' });
    const pressed = () => within(rail).getAllByRole('button', { pressed: true }).map((b) => b.getAttribute('aria-label'));
    expect(within(rail).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['Schema', 'Saved queries', 'Recent runs', 'Snippets']);
    expect(pressed()).toEqual(['Schema']);
    expect(screen.getByRole('complementary', { name: 'Schema' })).toBeTruthy();

    fireEvent.click(within(rail).getByRole('button', { name: 'Recent runs' }));
    expect(pressed()).toEqual(['Recent runs']);
    expect(await screen.findByRole('complementary', { name: 'Recent' })).toBeTruthy();
    expect(screen.queryByRole('complementary', { name: 'Schema' })).toBeNull();

    // The palette's commands show a panel too.
    fireEvent.keyDown(window, { key: 'k', code: 'KeyK', ctrlKey: true });
    const input = screen.getByRole('combobox', { name: 'Type a command' });
    fireEvent.change(input, { target: { value: 'show snippets' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(pressed()).toEqual(['Snippets']);
    expect(await screen.findByRole('complementary', { name: 'Snippets' })).toBeTruthy();
  });

  it('save_on_library_tab_updates_without_dialog', async () => {
    const saved: SavedQuery = {
      version: 1,
      id: 'q1',
      name: 'Apps',
      folder: 'Inventory',
      source: 'graph',
      text: 'applications',
      parameters: [],
      createdAt: '2026-10-01T00:00:00Z',
      modifiedAt: '2026-10-01T00:00:00Z',
    };
    answers = {
      'library.list': () => ({ queries: [saved], folders: ['Inventory'], skipped: 0 }),
      'library.save': (p) => ({ ...saved, ...(p as { query: SavedQuery }).query }),
    };
    host({ accounts: [kari], cache: 'persistent' }, rows, {
      version: 1,
      activeId: 'a',
      tabs: [{ id: 'a', source: 'graph', title: 'Apps', text: 'applications | take 5', dirty: true, savedId: 'q1', parameters: [], filePath: null }],
    });
    render(<App />);
    const editor = await screen.findByRole('textbox', { name: 'KQL query' });
    await waitFor(() => expect(editor).toHaveProperty('value', 'applications | take 5'));

    // Mod+S works from a text field.
    fireEvent.keyDown(editor, { key: 's', code: 'KeyS', ctrlKey: true });

    await waitFor(() =>
      expect(bridge.call).toHaveBeenCalledWith('library.save', {
        query: { id: 'q1', name: 'Apps', folder: 'Inventory', source: 'graph', text: 'applications | take 5', parameters: [] },
      }),
    );
    await waitFor(() => expect(useTabs.getState().tabs[0]?.dirty).toBe(false));
    expect(screen.queryByRole('dialog', { name: 'Save the query' })).toBeNull();
  });

  it('save_on_new_tab_opens_dialog', async () => {
    host({ accounts: [kari], cache: 'persistent' });
    render(<App />);
    await screen.findByRole('tab', { name: /Query 1/ });

    fireEvent.keyDown(window, { key: 's', code: 'KeyS', ctrlKey: true });

    expect(await screen.findByRole('dialog', { name: 'Save the query' })).toBeTruthy();
    expect(bridge.call).not.toHaveBeenCalledWith('library.save', expect.anything());
    expect(bridge.call).not.toHaveBeenCalledWith('file.saveAs', expect.anything());
  });

  it('save_on_file_tab_writes_the_file', async () => {
    answers = { 'file.saveAs': (p) => ({ path: (p as { path: string }).path, name: 'apps.kql' }) };
    host({ accounts: [kari], cache: 'persistent' }, rows, {
      version: 1,
      activeId: 'a',
      tabs: [{ id: 'a', source: 'graph', title: 'apps.kql', text: 'applications', dirty: true, savedId: null, parameters: [], filePath: '/q/apps.kql' }],
    });
    render(<App />);
    await screen.findByRole('tab', { name: /apps\.kql/ });

    fireEvent.keyDown(window, { key: 's', code: 'KeyS', ctrlKey: true });

    await waitFor(() =>
      expect(bridge.call).toHaveBeenCalledWith('file.saveAs', {
        suggestedName: 'apps.kql',
        filters: [{ name: 'KQL', extensions: ['kql'] }],
        content: 'applications',
        path: '/q/apps.kql',
      }),
    );
    await waitFor(() => expect(useTabs.getState().tabs[0]?.dirty).toBe(false));
  });

  it('open_kql_opens_tab_with_its_path', async () => {
    answers = { 'file.open': () => ({ path: '/q/guests.kql', name: 'guests.kql', text: 'users | where userType == "Guest"' }) };
    host({ accounts: [kari], cache: 'persistent' });
    render(<App />);
    await screen.findByRole('tab', { name: /Query 1/ });

    fireEvent.keyDown(window, { key: 'o', code: 'KeyO', ctrlKey: true });

    expect(await screen.findByRole('tab', { name: /guests\.kql/, selected: true })).toBeTruthy();
    expect(bridge.call).toHaveBeenCalledWith('file.open', { filters: [{ name: 'KQL', extensions: ['kql'] }] });
    expect(useTabs.getState().tabs[1]).toMatchObject({ filePath: '/q/guests.kql', text: 'users | where userType == "Guest"', dirty: false });
  });

  it('drop_kql_opens_tab', async () => {
    host({ accounts: [kari], cache: 'persistent' });
    render(<App />);
    await screen.findByRole('tab', { name: /Query 1/ });

    const file = new File(['groups | take 3'], 'groups.kql', { type: '' });
    fireEvent.dragOver(document.body, { dataTransfer: { files: [file], types: ['Files'] } });
    fireEvent.drop(document.body, { dataTransfer: { files: [file], types: ['Files'] } });

    expect(await screen.findByRole('tab', { name: /groups\.kql/, selected: true })).toBeTruthy();
    const opened = useTabs.getState().tabs[1];
    expect(opened).toMatchObject({ title: 'groups.kql', text: 'groups | take 3', dirty: false });
    // A dropped file has no path the host approved: its first Save asks where.
    expect(opened?.filePath).toBeUndefined();
  });

  it('drop_on_the_editor_opens_one_tab_and_leaves_the_query_alone', async () => {
    host({ accounts: [kari], cache: 'persistent' });
    render(<App />);
    const editor = await screen.findByRole('textbox', { name: 'KQL query' });
    fireEvent.change(editor, { target: { value: 'users' } });
    const first = useTabs.getState().activeId;

    const file = new File(['groups | take 3'], 'groups.kql');
    fireEvent.dragOver(editor, { dataTransfer: { files: [file], types: ['Files'] } });
    fireEvent.drop(editor, { dataTransfer: { files: [file], types: ['Files'] } });

    expect(await screen.findByRole('tab', { name: /groups\.kql/, selected: true })).toBeTruthy();
    const { tabs } = useTabs.getState();
    expect(tabs).toHaveLength(2);
    expect(tabs.find((t) => t.id === first)).toMatchObject({ text: 'users' });
  });

  it('drop_of_another_file_says_only_kql_opens', async () => {
    host({ accounts: [kari], cache: 'persistent' });
    render(<App />);
    await screen.findByRole('tab', { name: /Query 1/ });

    fireEvent.drop(document.body, { dataTransfer: { files: [new File(['x'], 'notes.txt')], types: ['Files'] } });

    expect((await screen.findByRole('alert')).textContent).toContain('Only .kql files can be opened; notes.txt isn’t one.');
    expect(useTabs.getState().tabs).toHaveLength(1);
  });

  it('toolbar_shows_parameter_count', async () => {
    host({ accounts: [kari], cache: 'persistent' });
    render(<App />);
    const editor = await screen.findByRole('textbox', { name: 'KQL query' });
    expect(screen.queryByRole('button', { name: /^Parameters/ })).toBeNull();

    fireEvent.change(editor, { target: { value: 'users | where a == {first} and b == "{inString}" and c == {second} and d == {first}' } });

    const button = screen.getByRole('button', { name: 'Parameters · 2' });
    expect(button.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(button);
    expect(button.getAttribute('aria-pressed')).toBe('true');
    const form = screen.getByRole('region', { name: 'Parameters' });
    expect(within(form).getByRole('group', { name: 'first' })).toBeTruthy();
    expect(within(form).getByRole('group', { name: 'second' })).toBeTruthy();
  });
});
