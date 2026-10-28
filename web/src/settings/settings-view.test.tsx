import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEffect, useState } from 'react';
import { BridgeError } from '../bridge';
import { registerCommands } from '../shell/commands';
import { applyTheme, useTheme } from '../shell/theme';
import type { AccountInfo, AppSettings, SettingsAnswer } from '../wire';
import { SettingsView } from './settings-view';

const creator: AccountInfo = {
  key: 'k1',
  username: 'kari@contoso.com',
  tenantName: 'Contoso',
  tenantId: 't0',
  clientId: '04b07795-8ddb-461a-bbee-02f9e1bf7b46',
  clientKind: 'azureCli',
  active: true,
  expired: false,
  scopes: ['Application.ReadWrite.All', 'User.Read.All'],
};

/** Settings as the app hosts them: the command opens the dialog, which the app keeps the state of. */
function Hosted({ account }: { account?: AccountInfo }) {
  const [open, setOpen] = useState(false);
  useEffect(() => registerCommands([{ id: 'account.createEntraApp', title: 'Create Entra ID application', group: 'Account', run: () => setOpen(true) }]), []);
  return <SettingsView onClose={vi.fn()} onChange={vi.fn()} account={account} createAppOpen={open} onCreateAppOpen={setOpen} />;
}

const createButton = () => screen.getByRole<HTMLButtonElement>('button', { name: 'Create Entra ID application…' });
const REASON = "This sign-in can't create app registrations (it needs Application.ReadWrite.All).";

const bridge = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../bridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../bridge')>()),
  call: bridge.call,
  on: () => () => undefined,
}));

const defaults: AppSettings = {
  version: 1,
  theme: 'dark',
  rawDefaultVersion: 'beta',
  signIn: { clientId: null, tenant: null },
  limits: {
    graphObjectsPerTable: 50000,
    fetchBudgetMb: 512,
    engineTimeoutSeconds: 120,
    engineHeapMb: 1024,
    engineWorkers: 2,
    perObjectReadsPerTable: 2000,
    perObjectCacheMinutes: 30,
    graphRowsPerRun: 50000,
    argRowsPerRun: 50000,
  },
};

let stored: AppSettings;
/** What `settings.set` does with the next settings it is sent; by default it stores them. */
let onSet: (settings: AppSettings) => SettingsAnswer | Promise<SettingsAnswer>;

beforeEach(() => {
  stored = defaults;
  onSet = (settings) => ({ settings, restartNeeded: false, corrupt: false, unreadable: false });
  bridge.call.mockReset();
  bridge.call.mockImplementation((method: string, params?: { settings: AppSettings }) => {
    switch (method) {
      case 'settings.get':
        return Promise.resolve({ settings: stored, restartNeeded: false, corrupt: false, unreadable: false });
      case 'settings.set':
        return Promise.resolve(onSet(params!.settings)).then((answer) => {
          stored = answer.settings;
          return answer;
        });
      default:
        return Promise.resolve(null);
    }
  });
});

afterEach(() => applyTheme('dark'));

const field = (label: string) => screen.getByLabelText(label).closest('.field') as HTMLElement;

describe('SettingsView', () => {
  it('settings_shows_arg_rows_per_run_with_its_range_and_the_hosts_message', async () => {
    render(<SettingsView onClose={vi.fn()} onChange={vi.fn()} />);

    const rows = await screen.findByLabelText('ARG rows per run');
    expect((rows as HTMLInputElement).value).toBe('50000');
    expect(within(field('ARG rows per run')).getByText('1,000 to 1,000,000')).toBeTruthy();

    fireEvent.change(rows, { target: { value: '999' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(within(field('ARG rows per run')).getByRole('alert').textContent).toBe('ARG rows per run must be between 1,000 and 1,000,000.');
  });

  it('settings_shows_restart_notice_and_validation_error', async () => {
    const onChange = vi.fn();
    render(<SettingsView onClose={vi.fn()} onChange={onChange} />);

    const workers = await screen.findByLabelText('Engine workers');
    expect(within(field('Engine workers')).getByText('1 to 8')).toBeTruthy();
    expect(screen.queryByText('Limits apply the next time Kustodian starts.')).toBeNull();

    // Out of range is caught before sending, huge numbers too, in the host's words.
    fireEvent.change(workers, { target: { value: '99999999999999999999' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(within(field('Engine workers')).getByRole('alert').textContent).toBe('Engine workers must be between 1 and 8.');
    expect(workers.getAttribute('aria-invalid')).toBe('true');
    expect(bridge.call).not.toHaveBeenCalledWith('settings.set', expect.anything());

    // The host's own message finds its field too.
    onSet = () => Promise.reject(new BridgeError('bad_request', 'Engine timeout (seconds) must be between 10 and 3,600.'));
    fireEvent.change(workers, { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const error = await within(field('Engine timeout (seconds)')).findByRole('alert');
    expect(error.textContent).toBe('Engine timeout (seconds) must be between 10 and 3,600.');
    expect(within(field('Engine workers')).queryByRole('alert')).toBeNull();

    onSet = (settings) => ({ settings, restartNeeded: true, corrupt: false, unreadable: false });
    fireEvent.change(workers, { target: { value: '4' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Limits apply the next time Kustodian starts.')).toBeTruthy();
    expect(within(field('Engine workers')).queryByRole('alert')).toBeNull();
    expect(stored.limits.engineWorkers).toBe(4);
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ restartNeeded: true }));
  });

  it('settings_saves_version_and_sign_in_defaults', async () => {
    render(<SettingsView onClose={vi.fn()} onChange={vi.fn()} />);

    fireEvent.change(await screen.findByLabelText('Raw request version'), { target: { value: 'v1.0' } });
    fireEvent.change(screen.getByLabelText('Default client ID'), { target: { value: ' 11111111-2222-3333-4444-555555555555 ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(stored.rawDefaultVersion).toBe('v1.0'));
    // An empty tenant is no tenant.
    expect(stored.signIn).toEqual({ clientId: '11111111-2222-3333-4444-555555555555', tenant: null });
    expect(await screen.findByText('Settings saved.')).toBeTruthy();
  });

  it('theme_change_applies_immediately', async () => {
    render(<SettingsView onClose={vi.fn()} onChange={vi.fn()} />);

    fireEvent.change(await screen.findByLabelText('Theme'), { target: { value: 'light' } });

    // No Save needed: the window turns light at once, and the theme is kept.
    expect(document.documentElement.classList.contains('theme-light')).toBe(true);
    expect(useTheme.getState().theme).toBe('light');
    await waitFor(() => expect(stored.theme).toBe('light'));
    expect(stored.limits).toEqual(defaults.limits);
  });

  it('settings_clear_cache', async () => {
    render(<SettingsView onClose={vi.fn()} onChange={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Clear cached Graph objects' }));

    expect(await screen.findByText('Cached Graph objects cleared.')).toBeTruthy();
    expect(bridge.call).toHaveBeenCalledWith('cache.clear');
  });

  it('settings_says_when_the_file_was_set_aside', async () => {
    bridge.call.mockImplementation(() => Promise.resolve({ settings: defaults, restartNeeded: false, corrupt: true, unreadable: false }));
    render(<SettingsView onClose={vi.fn()} onChange={vi.fn()} />);

    expect(await screen.findByText(/settings file couldn’t be read/)).toBeTruthy();
  });

  it('settings_says_when_the_file_could_not_be_read_at_all', async () => {
    bridge.call.mockImplementation(() => Promise.resolve({ settings: defaults, restartNeeded: false, corrupt: false, unreadable: true }));
    render(<SettingsView onClose={vi.fn()} onChange={vi.fn()} />);

    expect(await screen.findByText('The settings file couldn’t be read, so the defaults are in use. Saving writes over it.')).toBeTruthy();
  });

  it('settings_takes_focus_as_it_opens_so_escape_closes_it', async () => {
    const onClose = vi.fn();
    render(<SettingsView onClose={onClose} onChange={vi.fn()} />);

    const back = screen.getByRole('button', { name: '← Back to queries' });
    expect(document.activeElement).toBe(back);
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('settings_theme_and_save_never_undo_each_other', async () => {
    render(<SettingsView onClose={vi.fn()} onChange={vi.fn()} />);
    const workers = await screen.findByLabelText('Engine workers');

    // The theme is written while Save is about to go out: whichever reaches the host last mustn't undo the other.
    fireEvent.change(screen.getByLabelText('Theme'), { target: { value: 'light' } });
    fireEvent.change(workers, { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Settings saved.')).toBeTruthy();
    await waitFor(() => expect(bridge.call.mock.calls.filter((c) => c[0] === 'settings.set')).toHaveLength(2));
    expect(stored.theme).toBe('light');
    expect(stored.limits.engineWorkers).toBe(3);
  });

  it('settings_closes_on_escape_and_back', async () => {
    const onClose = vi.fn();
    render(<SettingsView onClose={onClose} onChange={vi.fn()} />);

    fireEvent.keyDown(await screen.findByLabelText('Theme'), { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: '← Back to queries' }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('settings_shows_create_app_button_enabled_when_allowed', async () => {
    render(<Hosted account={creator} />);
    await screen.findByLabelText('Default client ID');
    expect(createButton().disabled).toBe(false);
    expect(screen.queryByText(REASON)).toBeNull();
  });

  it('settings_shows_create_app_button_disabled_with_the_reason_when_not_allowed', async () => {
    const { unmount } = render(<Hosted account={{ ...creator, scopes: ['User.Read.All'] }} />);
    await screen.findByLabelText('Default client ID');
    expect(createButton().disabled).toBe(true);
    expect(screen.getByText(REASON)).toBeTruthy();
    unmount();
    render(<Hosted />);
    await screen.findByLabelText('Default client ID');
    expect(createButton().disabled).toBe(true);
    expect(screen.getByText(REASON)).toBeTruthy();
  });

  it('settings_create_app_opens_the_dialog_and_use_as_default_fills_client_and_tenant', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const appId = '11111111-2222-3333-4444-555555555555';
    const base = bridge.call.getMockImplementation()!;
    bridge.call.mockImplementation((method: string, params?: unknown) => {
      if (method === 'entraApp.plan') {
        return Promise.resolve({
          canCreate: true,
          defaultName: 'Kustodian (kari)',
          tenantId: 't1',
          tenantName: 'Contoso',
          tablesWithData: 1,
          tablesWithoutData: 0,
          writeOnlyTables: 0,
          groups: [{ id: 'g', title: 'Graph', subgroups: [{ title: 'Dir', permissions: [{ resource: 'Microsoft Graph', resourceAppId: 'g', name: 'A.Read.All', adminConsent: false, description: '', tables: ['x'], unlocks: null, ticked: true }] }] }],
        });
      }
      if (method === 'entraApp.create') {
        return Promise.resolve({ appId, objectId: 'o', servicePrincipalId: 's', tenantId: 't1', ownerAdded: true, ownerMessage: null, dropped: [], servicePrincipalMessage: null, adminScopes: [] });
      }
      return base(method, params);
    });
    render(<Hosted account={creator} />);
    await screen.findByLabelText('Default client ID');

    fireEvent.click(createButton());
    expect(await screen.findByRole('dialog', { name: 'Create Entra ID application' })).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'Create' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Just show me the client ID' }));
    expect(screen.queryByRole('dialog')).toBeNull();

    const note = screen.getByRole('note', { name: 'Created app' });
    expect(note.textContent).toContain(appId);
    fireEvent.click(within(note).getByRole('button', { name: 'Copy client ID' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(appId));

    fireEvent.click(within(note).getByRole('button', { name: 'Use as default client ID' }));
    expect((screen.getByLabelText('Default client ID') as HTMLInputElement).value).toBe(appId);
    expect((screen.getByLabelText('Default tenant') as HTMLInputElement).value).toBe('t1');
    // Only the draft changed: it is kept with Save.
    expect(bridge.call).not.toHaveBeenCalledWith('settings.set', expect.anything());
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(stored.signIn).toEqual({ clientId: appId, tenant: 't1' }));
  });
});
