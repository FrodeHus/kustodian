import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './app';
import { BridgeError } from './bridge';
import schema from './fixtures/graph-schema.json';
import { useTabs } from './tabs/tab-store';
import type { AccountInfo, AccountList, RunResult } from './wire';

const bridge = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('./bridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./bridge')>()),
  call: bridge.call,
  on: () => () => undefined,
}));

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
};

function host(list: AccountList, run: RunResult = rows) {
  bridge.call.mockImplementation((method: string) => {
    switch (method) {
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
});
