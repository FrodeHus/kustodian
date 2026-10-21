import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './app';
import { BridgeError } from './bridge';
import schema from './fixtures/graph-schema.json';
import { useSchemas } from './schema/schema-store';
import { runCommand } from './shell/commands';
import { applyTheme } from './shell/theme';
import { useTabs } from './tabs/tab-store';
import type { AccountInfo, AccountList, RunResult, SavedQuery, SchemaView, Session, SettingsAnswer } from './wire';

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
  unreadable: false,
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
  useSchemas.getState().reset();
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

  it('app_footer_panel_and_refresh_follow_the_active_source', async () => {
    host({ accounts: [kari], cache: 'persistent' });
    const other = (source: string, origin: SchemaView['origin'], fallbackReason: string | null): SchemaView => ({
      source,
      origin,
      fallbackReason,
      generatedAt: '2026-10-21T00:00:00Z',
      complexTypes: {},
      functions: [],
      tables: [{ name: source === 'arg' ? 'Resources' : 'DeviceInfo', path: null, area: null, description: '', docsUrl: null, permissions: null, columns: [] }],
    });
    answers['schema.get'] = (p) => {
      const { source } = p as { source: string };
      if (source === 'hunting') {
        return other('hunting', 'builtIn', "Sign in again to read the tenant's schema. The built-in schema is shown.");
      }
      return source === 'arg' ? other('arg', 'builtIn', null) : schema;
    };
    answers['arm.resourceTypes'] = () => ({ types: ['microsoft.compute/virtualmachines', 'microsoft.storage/storageaccounts'] });
    render(<App />);

    const footer = () => document.querySelector('footer.statusbar')?.textContent ?? '';
    await waitFor(() => expect(footer()).toContain('Schema: '));
    expect(footer()).toContain('KQL');
    // Nothing asks ARM for anything before a Resource Graph tab opens.
    expect(bridge.call.mock.calls.some(([m]) => m === 'arm.resourceTypes')).toBe(false);

    act(() => {
      runCommand('tab.newHunting');
    });
    expect(await screen.findByRole('complementary', { name: 'Advanced hunting schema' })).toBeTruthy();
    await waitFor(() => expect(footer()).toContain("Built-in schema (Sign in again to read the tenant's schema)"));
    expect(footer()).toContain('KQL · advanced hunting');
    expect(screen.queryByRole('button', { name: /Explain/ })).toBeNull();

    act(() => {
      runCommand('schema.refresh');
    });
    await waitFor(() => expect(bridge.call).toHaveBeenCalledWith('schema.get', { source: 'hunting', refresh: true }));

    act(() => {
      runCommand('tab.newArg');
    });
    expect(await screen.findByRole('complementary', { name: 'Resource Graph tables' })).toBeTruthy();
    await waitFor(() => expect(footer()).toContain('Resource Graph tables · 2 resource types'));
  });

  it('app_opens_a_graph_tab_runs_it_and_shows_rows', async () => {
    host({ accounts: [kari], cache: 'persistent' });
    render(<App />);

    expect(await screen.findByRole('tab', { name: /Query 1/ })).toBeTruthy();
    expect(await screen.findByRole('searchbox', { name: 'Find a table or column' })).toHaveProperty('placeholder', 'Find among 7 tables');
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
        query: { id: 'q1', name: 'Apps', folder: 'Inventory', source: 'graph', text: 'applications | take 5', parameters: [], options: null },
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

  it('parameters_take_the_editors_place_and_give_it_back', async () => {
    host({ accounts: [kari], cache: 'persistent' });
    render(<App />);
    const editor = await screen.findByRole('textbox', { name: 'KQL query' });
    fireEvent.change(editor, { target: { value: 'users | where displayName == {name}' } });
    const button = screen.getByRole('button', { name: 'Parameters · 1' });
    const editorHidden = () => screen.getByRole('textbox', { name: 'KQL query', hidden: true }).closest('[hidden]') !== null;

    // The parameters view replaces the editor, which stays mounted (its state and undo survive); the results stay below.
    fireEvent.click(button);
    expect(editorHidden()).toBe(true);
    const form = screen.getByRole('region', { name: 'Parameters' });
    expect(screen.getByText('No run yet')).toBeTruthy();
    expect(form.compareDocumentPosition(screen.getByText('No run yet')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // Pressing the button again brings the editor back.
    fireEvent.click(button);
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(editorHidden()).toBe(false);
    expect(screen.queryByRole('region', { name: 'Parameters' })).toBeNull();

    // So does Esc, and the command toggles it too.
    act(() => void runCommand('params.toggle'));
    expect(editorHidden()).toBe(true);
    fireEvent.keyDown(within(screen.getByRole('region', { name: 'Parameters' })).getAllByRole('textbox')[0]!, { key: 'Escape' });
    expect(editorHidden()).toBe(false);
    expect(screen.queryByRole('region', { name: 'Parameters' })).toBeNull();

    // "Run with these values" still runs, with the editor out of sight.
    fireEvent.click(button);
    fireEvent.click(screen.getByRole('button', { name: 'Run with these values' }));
    await waitFor(() => expect(bridge.call).toHaveBeenCalledWith('query.run', expect.objectContaining({ kql: 'users | where displayName == {name}' }), expect.anything()));
  });

  it('parameters_close_when_another_tab_comes_forward', async () => {
    host({ accounts: [kari], cache: 'persistent' });
    render(<App />);
    fireEvent.change(await screen.findByRole('textbox', { name: 'KQL query' }), { target: { value: 'users | where id == {id}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Parameters · 1' }));
    expect(screen.getByRole('region', { name: 'Parameters' })).toBeTruthy();

    act(() => {
      runCommand('tab.new');
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'KQL query', hidden: true }), { target: { value: 'groups | where id == {id}' } });

    expect(screen.queryByRole('region', { name: 'Parameters' })).toBeNull();
    expect(screen.getByRole('textbox', { name: 'KQL query' }).closest('[hidden]')).toBeNull();
  });

  it('app_explain_shows_what_the_query_would_send_on_graph_tabs_only', async () => {
    host({ accounts: [kari], cache: 'persistent' });
    answers['query.explain'] = () => ({
      error: null,
      refusal: null,
      tables: [
        {
          table: 'applications',
          url: 'applications?$select=id&$top=999',
          select: ['id'],
          filter: null,
          top: null,
          pushed: [],
          local: [],
          perObject: [],
          permissions: ['Application.Read.All'],
          docsUrl: 'https://learn.microsoft.com/graph/api/resources/application',
        },
      ],
      limits: { objectsPerTable: 50000, fetchBudgetMb: 512, perObjectReadsPerTable: 2000 },
    });
    render(<App />);
    fireEvent.change(await screen.findByRole('textbox', { name: 'KQL query' }), { target: { value: 'applications' } });

    act(() => void runCommand('explain'));
    expect(await screen.findByRole('region', { name: 'applications' })).toBeTruthy();
    expect(bridge.call).toHaveBeenCalledWith('query.explain', { source: 'graph', kql: 'applications', parameters: [] });
    expect(screen.getByRole('button', { name: 'Explain' }).getAttribute('aria-pressed')).toBe('true');

    // Open in a raw request tab: the plan's URL as the path, beta as Graph tabs use.
    fireEvent.click(screen.getByRole('button', { name: 'Open in a raw request tab' }));
    const raw = useTabs.getState().tabs.find((t) => t.source === 'raw');
    expect(raw).toMatchObject({ text: 'applications?$select=id&$top=999' });
    expect(screen.getByRole('combobox', { name: 'Request path' })).toHaveProperty('value', 'applications?$select=id&$top=999');
    // A raw tab has no explain, no run and no editor.
    expect(runCommand('explain')).toBe(false);
    expect(runCommand('run.all')).toBe(false);
    expect(screen.queryByRole('button', { name: 'Explain' })).toBeNull();
    expect(screen.getByRole('textbox', { name: 'KQL query', hidden: true }).closest('[hidden]')).not.toBeNull();
  });

  it('app_explain_closes_when_the_tab_leaves_graph', async () => {
    host({ accounts: [kari], cache: 'persistent' });
    answers['query.explain'] = () => ({ error: null, refusal: null, tables: [], limits: { objectsPerTable: 50000, fetchBudgetMb: 512, perObjectReadsPerTable: 2000 } });
    render(<App />);
    fireEvent.change(await screen.findByRole('textbox', { name: 'KQL query' }), { target: { value: 'applications' } });
    act(() => void runCommand('explain'));
    await waitFor(() => expect(bridge.call.mock.calls.filter(([m]) => m === 'query.explain')).toHaveLength(1));
    expect(screen.getByRole('button', { name: 'Explain' }).getAttribute('aria-pressed')).toBe('true');

    const id = useTabs.getState().activeId!;
    act(() => useTabs.getState().setSource(id, 'hunting'));
    expect(screen.queryByRole('button', { name: 'Explain' })).toBeNull();
    expect(screen.getByText(/Run a query with/)).toBeTruthy();

    // Back on Graph, Explain stays closed and nothing is explained again as Graph without asking.
    act(() => useTabs.getState().setSource(id, 'graph'));
    expect(screen.getByRole('button', { name: 'Explain' }).getAttribute('aria-pressed')).toBe('false');
    expect(bridge.call.mock.calls.filter(([m]) => m === 'query.explain')).toHaveLength(1);
  });

  it('app_pick_timespan_and_pick_scope_follow_the_source', async () => {
    host({ accounts: [kari], cache: 'persistent' });
    answers['arm.subscriptions'] = () => ({ subscriptions: [{ id: '00000000-0000-0000-0000-000000000011', name: 'Production', tenantId: 't1', state: 'Enabled' }] });
    answers['arm.managementGroups'] = () => ({ groups: [] });
    answers['arm.resourceTypes'] = () => ({ types: [] });
    render(<App />);
    await screen.findByRole('tab', { name: /Query 1/ });
    // A Graph tab has neither picker.
    expect(runCommand('toolbar.timespan')).toBe(false);
    expect(runCommand('toolbar.scope')).toBe(false);
    expect(screen.queryByRole('button', { name: /^Timespan:/ })).toBeNull();

    act(() => void runCommand('tab.newHunting'));
    expect(runCommand('toolbar.scope')).toBe(false);
    act(() => void runCommand('toolbar.timespan'));
    fireEvent.click(screen.getByRole('menuitemradio', { name: '1 day' }));
    expect(screen.getByRole('button', { name: 'Timespan: 1 day' })).toBeTruthy();
    expect(useTabs.getState().tabs.at(-1)?.options).toEqual({ timespan: 'P1D', scope: null });

    act(() => void runCommand('tab.newArg'));
    expect(runCommand('toolbar.timespan')).toBe(false);
    act(() => void runCommand('toolbar.scope'));
    fireEvent.click(screen.getByRole('radio', { name: 'Subscriptions' }));
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Production' }));
    expect(screen.getByRole('button', { name: 'Scope: 1 subscription' })).toBeTruthy();
    expect(useTabs.getState().tabs.at(-1)?.options).toEqual({ timespan: null, scope: { kind: 'subscriptions', ids: ['00000000-0000-0000-0000-000000000011'] } });
  });

  it('app_consent_needed_run_grants_access_for_the_active_account_and_runs_again', async () => {
    const consent = { ...rows, outcome: 'consentNeeded' as const, message: 'Grant Azure access to run this query.', rows: [], columns: [], total: 0 };
    let runs = 0;
    host({ accounts: [kari], cache: 'persistent' });
    answers['query.run'] = () => (++runs === 1 ? consent : rows);
    answers['account.consent'] = () => ({});
    answers['arm.resourceTypes'] = () => ({ types: [] });
    render(<App />);
    await screen.findByRole('tab', { name: /Query 1/ });
    act(() => void runCommand('tab.newArg'));
    fireEvent.change(await screen.findByRole('textbox', { name: 'KQL query' }), { target: { value: 'Resources' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run all Shift Enter' }));

    fireEvent.click(await screen.findByRole('button', { name: 'Grant Azure access' }));
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Rows · 1' })).toBeTruthy());
    expect(bridge.call).toHaveBeenCalledWith('account.consent', { key: 'k1', audience: 'arm' });
    expect(runs).toBe(2);
  });

  it('app_reads_every_open_sources_schema_again_for_another_account', async () => {
    const ola: AccountInfo = { ...kari, key: 'k2', username: 'ola@contoso.com', active: false };
    let list: AccountList = { accounts: [kari, ola], cache: 'persistent' };
    host(list);
    answers['account.list'] = () => list;
    answers['account.use'] = () => {
      list = { ...list, accounts: [{ ...kari, active: false }, { ...ola, active: true }] };
      return null;
    };
    render(<App />);
    await screen.findByRole('tab', { name: /Query 1/ });
    act(() => {
      runCommand('tab.newHunting');
    });
    const schemaGets = (source: string) => bridge.call.mock.calls.filter(([m, p]) => m === 'schema.get' && (p as { source: string }).source === source).length;
    await waitFor(() => expect(schemaGets('hunting')).toBe(1));
    expect(schemaGets('graph')).toBe(1);

    // Switching account through the accounts screen.
    fireEvent.click(screen.getByRole('button', { name: /kari@contoso.com/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Use ola@contoso.com' }));

    await waitFor(() => expect(schemaGets('hunting')).toBe(2));
    expect(schemaGets('graph')).toBe(2);
  });

  it('app_reloads_a_built_in_hunting_schema_after_signing_in_again', async () => {
    host({ accounts: [kari], cache: 'persistent' });
    let origin: SchemaView['origin'] = 'builtIn';
    answers['schema.get'] = (p) =>
      (p as { source: string }).source === 'hunting'
        ? { ...(schema as SchemaView), source: 'hunting', origin, fallbackReason: origin === 'builtIn' ? "Sign in again to read the tenant's schema. The built-in schema is shown." : null }
        : schema;
    answers['account.signIn'] = () => kari;
    render(<App />);
    await screen.findByRole('tab', { name: /Query 1/ });
    act(() => {
      runCommand('tab.newHunting');
    });
    const footer = () => document.querySelector('footer.statusbar')?.textContent ?? '';
    await waitFor(() => expect(footer()).toContain('Built-in schema (Sign in again'));

    // Signing in again with the same account reads the tenant's schema again.
    origin = 'tenant';
    fireEvent.click(screen.getByRole('button', { name: /kari@contoso.com/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in with your browser' }));
    await waitFor(() => expect(footer()).toContain('Schema from your tenant (getHuntingSchema)'));
    expect(bridge.call).toHaveBeenCalledWith('schema.get', { source: 'hunting', refresh: true });
  });

  it('app_reads_resource_types_again_after_signing_in_again_as_the_same_account', async () => {
    host({ accounts: [kari], cache: 'persistent' });
    let signedIn = false;
    answers['arm.resourceTypes'] = () =>
      signedIn ? { types: ['microsoft.keyvault/vaults'] } : Promise.reject(new BridgeError('signInNeeded', 'Sign in again to list your Azure subscriptions and resources.'));
    answers['account.signIn'] = () => kari;
    render(<App />);
    await screen.findByRole('tab', { name: /Query 1/ });
    act(() => {
      runCommand('tab.newArg');
    });
    const panel = await screen.findByRole('complementary', { name: 'Resource Graph tables' });
    await waitFor(() => expect(within(panel).getByText('Sign in again to list your Azure subscriptions and resources.')).toBeTruthy());

    // The panel's own "Sign in" opens sign-in; signing in as the same account lists the types.
    fireEvent.click(within(panel).getByRole('button', { name: 'Sign in' }));
    signedIn = true;
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in with your browser' }));
    const footer = () => document.querySelector('footer.statusbar')?.textContent ?? '';
    await waitFor(() => expect(footer()).toContain('Resource Graph tables · 1 resource types'));
    expect(within(screen.getByRole('list', { name: 'Resource types' })).getByText('microsoft.keyvault/vaults')).toBeTruthy();
  });

  it('app_hunting_footer_says_when_a_refresh_failed_and_signing_in_again_reads_it', async () => {
    host({ accounts: [kari], cache: 'persistent' });
    let reason: string | null = 'Sign in again to refresh the tenant’s schema. The schema read earlier is shown.';
    answers['schema.get'] = (p) =>
      (p as { source: string }).source === 'hunting' ? { ...(schema as SchemaView), source: 'hunting', origin: 'tenant', fallbackReason: reason } : schema;
    answers['account.signIn'] = () => kari;
    render(<App />);
    await screen.findByRole('tab', { name: /Query 1/ });
    act(() => {
      runCommand('tab.newHunting');
    });
    const footer = () => document.querySelector('footer.statusbar')?.textContent ?? '';
    await waitFor(() => expect(footer()).toContain('Schema from your tenant (getHuntingSchema) · '));
    expect(footer()).toContain('Sign in again to refresh the tenant’s schema');
    expect(footer()).not.toContain('The schema read earlier is shown');

    reason = null;
    fireEvent.click(screen.getByRole('button', { name: /kari@contoso.com/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in with your browser' }));
    await waitFor(() => expect(footer()).not.toContain('Sign in again'));
    expect(bridge.call).toHaveBeenCalledWith('schema.get', { source: 'hunting', refresh: true });
  });

  it('app_settings_open_from_the_title_bar_and_the_shortcut', async () => {
    host({ accounts: [kari], cache: 'persistent' });
    render(<App />);
    await screen.findByRole('tab', { name: /Query 1/ });

    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '← Back to queries' }));
    expect(screen.queryByRole('heading', { name: 'Settings' })).toBeNull();

    fireEvent.keyDown(window, { key: ',', code: 'Comma', ctrlKey: true });
    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeTruthy();
  });

  it('app_sign_in_prefills_the_default_client_from_settings', async () => {
    host({ accounts: [], cache: 'persistent' });
    answers['settings.get'] = () => ({ ...settings, settings: { ...settings.settings, signIn: { clientId: 'c-1', tenant: 't-1' } } });
    render(<App />);

    await waitFor(() => expect(screen.getByLabelText('Client ID')).toHaveProperty('value', 'c-1'));
    expect(screen.getByLabelText('Tenant')).toHaveProperty('value', 't-1');
  });

  it('app_settings_open_from_the_sign_in_screen_and_prefill_on_return', async () => {
    host({ accounts: [], cache: 'persistent' });
    const limits = {
      graphObjectsPerTable: 50000,
      fetchBudgetMb: 512,
      engineTimeoutSeconds: 120,
      engineHeapMb: 1024,
      engineWorkers: 2,
      perObjectReadsPerTable: 2000,
      perObjectCacheMinutes: 30,
      graphRowsPerRun: 50000,
      argRowsPerRun: 50000,
    };
    answers['settings.get'] = () => ({ ...settings, settings: { ...settings.settings, limits } });
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Sign in to Microsoft Graph' })).toBeTruthy();

    // The title bar's Settings button works on the sign-in screen, and settings cover it.
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Sign in to Microsoft Graph' })).toBeNull();
    fireEvent.change(await screen.findByLabelText('Default client ID'), { target: { value: 'c-2' } });
    fireEvent.change(screen.getByLabelText('Default tenant'), { target: { value: 't-2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Settings saved.')).toBeTruthy();

    // Back on the sign-in screen, which starts with what was just saved.
    fireEvent.click(screen.getByRole('button', { name: '← Back to queries' }));
    expect(screen.getByRole('heading', { name: 'Sign in to Microsoft Graph' })).toBeTruthy();
    expect(screen.getByLabelText('Client ID')).toHaveProperty('value', 'c-2');
    expect(screen.getByLabelText('Tenant')).toHaveProperty('value', 't-2');

    // The account pill closes settings.
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Not signed in' }));
    expect(screen.queryByRole('heading', { name: 'Settings' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Sign in to Microsoft Graph' })).toBeTruthy();
  });

  it('app_failed_run_with_diagnostics_shows_them', async () => {
    host({ accounts: [kari], cache: 'persistent' }, {
      ...rows,
      outcome: 'throttled',
      message: 'Graph is throttling requests. Try again in a minute.',
      rows: [],
      columns: [],
      total: 0,
      diagnostics: [{ atMs: 5, kind: 'throttled', detail: 'GET applications?$top=999', status: 429, durationMs: 80, bytes: 120 }],
    });
    render(<App />);

    fireEvent.change(await screen.findByRole('textbox', { name: 'KQL query' }), { target: { value: 'applications' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run all Shift Enter' }));

    const diagnostics = await screen.findByRole('region', { name: 'Diagnostics' });
    expect(within(diagnostics).getByRole('region', { name: 'Run statistics' })).toBeTruthy();
    expect(within(diagnostics).getByText('GET applications?$top=999')).toBeTruthy();
    expect(screen.queryByRole('tab', { name: /^Rows/ })).toBeNull();
  });

  it('app_announces_a_settings_file_that_could_not_be_read_at_startup', async () => {
    host({ accounts: [kari], cache: 'persistent' });
    answers['settings.get'] = () => ({ ...settings, corrupt: true });
    const view = render(<App />);
    expect(await screen.findByText('The settings file couldn’t be read, so it was set aside and the defaults are in use.')).toBeTruthy();
    view.unmount();

    answers['settings.get'] = () => ({ ...settings, unreadable: true });
    render(<App />);
    expect(await screen.findByText('The settings file couldn’t be read, so the defaults are in use.')).toBeTruthy();
  });

  it('app_palette_command_is_disabled_while_the_palette_is_open', async () => {
    host({ accounts: [kari], cache: 'persistent' });
    render(<App />);
    await screen.findByRole('tab', { name: /Query 1/ });
    expect(runCommand('palette')).toBe(true);
    const input = await screen.findByRole('combobox', { name: 'Type a command' });

    fireEvent.change(input, { target: { value: 'command palette' } });
    const option = screen.getAllByRole('option').find((o) => o.textContent?.includes('Command palette'));
    expect(option?.getAttribute('aria-disabled')).toBe('true');
    expect(runCommand('palette')).toBe(false);
  });

  it('app_shortcuts_are_off_while_the_close_confirmation_is_open', async () => {
    host({ accounts: [kari], cache: 'persistent' });
    render(<App />);
    fireEvent.change(await screen.findByRole('textbox', { name: 'KQL query' }), { target: { value: 'users' } });

    fireEvent.keyDown(window, { key: 'w', code: 'KeyW', ctrlKey: true });
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.keyDown(window, { key: 't', code: 'KeyT', ctrlKey: true });
    fireEvent.keyDown(window, { key: 'k', code: 'KeyK', ctrlKey: true });

    expect(useTabs.getState().tabs).toHaveLength(1);
    expect(screen.queryByRole('dialog', { name: 'Command palette' })).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep it open' }));
    fireEvent.keyDown(window, { key: 't', code: 'KeyT', ctrlKey: true });
    expect(await screen.findByRole('tab', { name: /Query 2/, selected: true })).toBeTruthy();
  });

  it('app_says_for_good_when_the_session_cannot_be_read', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      host({ accounts: [kari], cache: 'persistent' });
      answers['session.get'] = () => Promise.reject(new BridgeError('failed', 'The file is locked.'));
      render(<App />);
      await act(() => vi.advanceTimersByTimeAsync(3 * 5000));

      const notice = screen.getByText('Your session couldn’t be read; changes in this window won’t be saved.');
      expect(notice.getAttribute('role')).toBe('alert');
      expect(within(notice).queryByRole('button')).toBeNull();
      // Other notices still come and go below it.
      for (const dismiss of screen.queryAllByRole('button', { name: 'Dismiss' })) {
        fireEvent.click(dismiss);
      }
      expect(screen.getByText('Your session couldn’t be read; changes in this window won’t be saved.')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});
