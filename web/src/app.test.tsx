import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './app';
import { BridgeError } from './bridge';
import schema from './fixtures/graph-schema.json';
import { applyTheme } from './shell/theme';
import { useTabs } from './tabs/tab-store';
import type { AccountInfo, AccountList, RunResult, Session, SettingsAnswer } from './wire';

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

function host(list: AccountList, run: RunResult | Promise<RunResult> = rows, session: Session | null = null) {
  bridge.call.mockImplementation((method: string, params?: { settings?: unknown }) => {
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
      default:
        return Promise.resolve(null);
    }
  });
}

beforeEach(() => {
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
});
