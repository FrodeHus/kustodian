import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GRAPH_CLI_CLIENT_ID, type AccountInfo, type AccountList } from '../wire';
import { SignIn } from './sign-in';

const bridge = vi.hoisted(() => ({ call: vi.fn(), events: new Map<string, (data: unknown) => void>() }));
vi.mock('../bridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../bridge')>()),
  call: bridge.call,
  on: (event: string, handler: (data: unknown) => void) => {
    bridge.events.set(event, handler);
    return () => bridge.events.delete(event);
  },
}));
// The section reads the tenant's licenses from the bridge; it has tests of its own.
vi.mock('./tenant-licenses', () => ({ TenantLicenses: () => null }));

const kari: AccountInfo = {
  key: 'k1',
  username: 'kari@contoso.com',
  tenantName: 'Contoso Ltd',
  tenantId: 't1',
  clientId: '04b07795-8ddb-461a-bbee-02f9e1bf7b46',
  clientKind: 'azureCli',
  active: true,
  expired: false,
  scopes: ['Application.Read.All', 'User.Read.All'],
};

const none: AccountList = { accounts: [], cache: 'persistent' };

beforeEach(() => {
  bridge.call.mockReset();
  bridge.events.clear();
});

describe('SignIn', () => {
  it('sign_in_defaults_to_azure_cli_and_disables_client_fields', async () => {
    bridge.call.mockResolvedValue(kari);
    const onChanged = vi.fn();
    render(<SignIn list={none} onChanged={onChanged} />);

    expect(screen.getByRole('radio', { name: /^Azure CLI/ })).toHaveProperty('checked', true);
    expect(screen.getByLabelText('Client ID')).toHaveProperty('disabled', true);
    expect(screen.getByLabelText('Tenant')).toHaveProperty('disabled', true);

    // The default client signs in with no client ID or tenant: the host fills in its defaults.
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with your browser' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(bridge.call).toHaveBeenCalledWith('account.signIn', { deviceCode: false });

    fireEvent.click(screen.getByRole('radio', { name: /My own app registration/ }));
    expect(screen.getByLabelText('Client ID')).toHaveProperty('disabled', false);
    expect(screen.getByLabelText('Tenant')).toHaveProperty('disabled', false);
  });

  it('device_code_shows_the_message_from_the_host', async () => {
    let finish: (a: AccountInfo) => void = () => undefined;
    bridge.call.mockReturnValue(new Promise<AccountInfo>((resolve) => (finish = resolve)));
    render(<SignIn list={none} onChanged={() => undefined} />);

    fireEvent.click(screen.getByRole('radio', { name: /My own app registration/ }));
    fireEvent.change(screen.getByLabelText('Client ID'), { target: { value: ' 11111111-2222-3333-4444-555555555555 ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Use a device code instead' }));
    expect(bridge.call).toHaveBeenCalledWith('account.signIn', { clientId: '11111111-2222-3333-4444-555555555555', deviceCode: true });

    bridge.events.get('account.deviceCode')?.({ message: 'To sign in, open https://microsoft.com/devicelogin and enter ABCD1234.' });
    expect(await screen.findByText(/ABCD1234/)).toBeTruthy();
    finish(kari);
  });

  it('accounts_scopes_and_memory_only_notice', async () => {
    bridge.call.mockResolvedValue(null);
    const other: AccountInfo = { ...kari, key: 'k2', username: 'admin@fabrikam.example', tenantName: 'Fabrikam', active: false, clientId: '7d1f0000-0000-0000-0000-00000000c20a' };
    const onChanged = vi.fn();
    render(
      <SignIn list={{ accounts: [kari, other], cache: 'memoryOnly', cacheReason: 'libsecret is not available.' }} onChanged={onChanged} />,
    );

    expect(screen.getByText('Application.Read.All')).toBeTruthy();
    expect(screen.getByText(/libsecret is not available\./)).toBeTruthy();
    expect(screen.getByText(/Fabrikam · client 7d1f…c20a/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Use admin@fabrikam.example' }));
    await waitFor(() => expect(bridge.call).toHaveBeenCalledWith('account.use', { key: 'k2' }));
    fireEvent.click(screen.getByRole('button', { name: 'Sign out kari@contoso.com' }));
    await waitFor(() => expect(bridge.call).toHaveBeenCalledWith('account.signOut', { key: 'k1' }));
    expect(onChanged).toHaveBeenCalledTimes(2);
  });

  it('offers three clients and signs in with graph cli', async () => {
    bridge.call.mockResolvedValue(kari);
    const onChanged = vi.fn();
    render(<SignIn list={none} onChanged={onChanged} />);

    expect(screen.getByRole('radio', { name: /^Azure CLI/ })).toBeTruthy();
    expect(screen.getByRole('radio', { name: /My own app registration/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: /Microsoft Graph Command Line Tools/ }));
    expect(screen.getByText(/Reaches what your tenant has granted Graph PowerShell\. Azure queries use your Azure CLI sign-in\./)).toBeTruthy();
    // The client is fixed; only the tenant can be typed.
    expect(screen.getByLabelText('Client ID')).toHaveProperty('disabled', true);
    expect(screen.getByLabelText('Client ID')).toHaveProperty('value', GRAPH_CLI_CLIENT_ID);
    expect(screen.getByLabelText('Tenant')).toHaveProperty('disabled', false);

    fireEvent.click(screen.getByRole('button', { name: 'Sign in with your browser' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(bridge.call).toHaveBeenCalledWith('account.signIn', { clientId: GRAPH_CLI_CLIENT_ID, deviceCode: false });

    fireEvent.change(screen.getByLabelText('Tenant'), { target: { value: ' contoso.example ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Use a device code instead' }));
    expect(bridge.call).toHaveBeenCalledWith('account.signIn', { clientId: GRAPH_CLI_CLIENT_ID, tenant: 'contoso.example', deviceCode: true });
  });

  it('a saved graph cli default starts on graph cli, not own app', () => {
    render(<SignIn list={none} onChanged={vi.fn()} defaults={{ clientId: GRAPH_CLI_CLIENT_ID.toUpperCase(), tenant: null }} />);
    expect(screen.getByRole('radio', { name: /Microsoft Graph Command Line Tools/ })).toHaveProperty('checked', true);
    expect(screen.getByRole('radio', { name: /My own app registration/ })).toHaveProperty('checked', false);
    expect(screen.getByLabelText('Client ID')).toHaveProperty('disabled', true);
  });

  it('without a saved default, starts on the client the account in use signed in with', () => {
    const graph: AccountInfo = { ...kari, clientId: GRAPH_CLI_CLIENT_ID, clientKind: 'graphCli' };
    const { unmount } = render(<SignIn list={{ accounts: [graph], cache: 'persistent' }} onChanged={vi.fn()} />);
    expect(screen.getByRole('radio', { name: /Microsoft Graph Command Line Tools/ })).toHaveProperty('checked', true);
    unmount();

    const mine: AccountInfo = { ...kari, clientId: 'c0ffee00-0000-0000-0000-000000000001', clientKind: 'own' };
    render(<SignIn list={{ accounts: [mine], cache: 'persistent' }} onChanged={vi.fn()} />);
    expect(screen.getByRole('radio', { name: /My own app registration/ })).toHaveProperty('checked', true);
    expect(screen.getByLabelText('Client ID')).toHaveProperty('value', 'c0ffee00-0000-0000-0000-000000000001');
    expect(screen.getByLabelText('Tenant')).toHaveProperty('value', 't1');
  });

  it('a saved default wins over the account in use', () => {
    const graph: AccountInfo = { ...kari, clientId: GRAPH_CLI_CLIENT_ID, clientKind: 'graphCli' };
    render(
      <SignIn
        list={{ accounts: [graph], cache: 'persistent' }}
        onChanged={vi.fn()}
        defaults={{ clientId: 'c0ffee00-0000-0000-0000-000000000001', tenant: null }}
      />,
    );
    expect(screen.getByRole('radio', { name: /My own app registration/ })).toHaveProperty('checked', true);
  });

  it('labels a graph cli account and says azure queries use azure cli', async () => {
    bridge.call.mockResolvedValue(null);
    const graph: AccountInfo = { ...kari, clientId: GRAPH_CLI_CLIENT_ID, clientKind: 'graphCli', expired: true };
    render(<SignIn list={{ accounts: [graph], cache: 'persistent' }} onChanged={vi.fn()} />);

    expect(screen.getByText(/Contoso Ltd · Graph Command Line Tools client/)).toBeTruthy();
    expect(screen.getByText('Azure queries use your Azure CLI sign-in.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in again as kari@contoso.com' }));
    await waitFor(() =>
      expect(bridge.call).toHaveBeenCalledWith('account.signIn', { clientId: GRAPH_CLI_CLIENT_ID, tenant: 't1', deviceCode: false }),
    );
  });

  it('sign_in_prefills_default_client', async () => {
    bridge.call.mockResolvedValue(kari);
    const onChanged = vi.fn();
    const { rerender } = render(<SignIn list={none} onChanged={onChanged} defaults={{ clientId: null, tenant: null }} />);
    // No default client: the Azure CLI stays chosen.
    expect(screen.getByRole('radio', { name: /^Azure CLI/ })).toHaveProperty('checked', true);

    // The settings arrive with a default client ID and tenant: "My own app registration" is chosen and filled in.
    rerender(<SignIn list={none} onChanged={onChanged} defaults={{ clientId: 'c0ffee00-0000-0000-0000-000000000001', tenant: 'contoso.example' }} />);
    expect(screen.getByRole('radio', { name: /My own app registration/ })).toHaveProperty('checked', true);
    expect(screen.getByLabelText('Client ID')).toHaveProperty('value', 'c0ffee00-0000-0000-0000-000000000001');
    expect(screen.getByLabelText('Tenant')).toHaveProperty('value', 'contoso.example');

    fireEvent.click(screen.getByRole('button', { name: 'Sign in with your browser' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(bridge.call).toHaveBeenCalledWith('account.signIn', {
      clientId: 'c0ffee00-0000-0000-0000-000000000001',
      tenant: 'contoso.example',
      deviceCode: false,
    });
  });

  it('sign_in_prefill_leaves_what_the_user_typed', () => {
    const { rerender } = render(<SignIn list={none} onChanged={vi.fn()} />);
    fireEvent.click(screen.getByRole('radio', { name: /My own app registration/ }));
    fireEvent.change(screen.getByLabelText('Client ID'), { target: { value: 'typed' } });

    rerender(<SignIn list={none} onChanged={vi.fn()} defaults={{ clientId: 'from-settings', tenant: null }} />);
    expect(screen.getByLabelText('Client ID')).toHaveProperty('value', 'typed');
  });

  describe('create button', () => {
    const list = (a: Partial<AccountInfo>): AccountList => ({ accounts: [{ ...kari, ...a }], cache: 'persistent' });
    const planAnswer = (over: object = {}) => ({ canCreate: true, defaultName: 'n', tenantId: 't1', tenantName: 'T', groups: [], tablesWithData: 0, tablesWithoutData: 0, writeOnlyTables: 0, ...over });
    const button = () => screen.queryByRole('button', { name: 'Create Entra ID application…' });

    const creator = { scopes: ['Application.ReadWrite.All', 'User.Read.All'] };

    it('button_hidden_for_own_client_and_expired_account', () => {
      const { unmount } = render(<SignIn list={list({ ...creator, clientId: 'c0ffee00-0000-0000-0000-000000000001' })} onChanged={vi.fn()} />);
      expect(button()).toBeNull();
      unmount();
      render(<SignIn list={list({ ...creator, expired: true })} onChanged={vi.fn()} />);
      expect(button()).toBeNull();
      expect(bridge.call).not.toHaveBeenCalledWith('entraApp.plan');
    });

    it('button_enabled_and_opens_the_dialog', async () => {
      bridge.call.mockResolvedValue(planAnswer());
      render(<SignIn list={list(creator)} onChanged={vi.fn()} />);
      expect(button()?.hasAttribute('disabled')).toBe(false);
      expect(bridge.call).not.toHaveBeenCalledWith('entraApp.plan');
      fireEvent.click(button() as HTMLElement);
      expect(await screen.findByRole('dialog', { name: 'Create Entra ID application' })).toBeTruthy();
    });

    it('button_disabled_with_reason', () => {
      render(<SignIn list={list({})} onChanged={vi.fn()} />);
      expect(screen.getByText("This sign-in can't create app registrations (it needs Application.ReadWrite.All).")).toBeTruthy();
      expect(button()?.hasAttribute('disabled')).toBe(true);
      expect(bridge.call).not.toHaveBeenCalledWith('entraApp.plan');
    });

    it('dialog_opened_by_the_command_shows', async () => {
      bridge.call.mockResolvedValue(planAnswer());
      render(<SignIn list={list(creator)} onChanged={vi.fn()} createAppOpen onCreateAppOpen={vi.fn()} />);
      expect(await screen.findByRole('dialog', { name: 'Create Entra ID application' })).toBeTruthy();
    });
    it('just_show_keeps_a_note_with_copy_until_the_screen_is_left', async () => {
      const writeText = vi.fn(() => Promise.resolve());
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
      const appId = '11111111-2222-3333-4444-555555555555';
      bridge.call.mockImplementation((method: string) => {
        if (method === 'entraApp.plan') {
          return Promise.resolve({ ...planAnswer(), defaultName: 'Kustodian (kari)', groups: [{ id: 'g', title: 'Graph', subgroups: [{ title: 'Dir', permissions: [{ resource: 'Microsoft Graph', resourceAppId: 'g', name: 'A.Read.All', adminConsent: false, description: '', tables: ['x'], unlocks: null, ticked: true }] }] }] });
        }
        if (method === 'entraApp.create') {
          return Promise.resolve({ appId, objectId: 'o', servicePrincipalId: 's', tenantId: 't1', ownerAdded: true, ownerMessage: null, dropped: [], servicePrincipalMessage: null, adminScopes: [] });
        }
        return Promise.resolve({});
      });
      const { unmount } = render(<SignIn list={list(creator)} onChanged={vi.fn()} />);
      await waitFor(() => expect(button()?.hasAttribute('disabled')).toBe(false));
      fireEvent.click(button() as HTMLElement);
      fireEvent.click(await screen.findByRole('button', { name: 'Create' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Just show me the client ID' }));
      expect(screen.queryByRole('dialog')).toBeNull();
      const note = screen.getByRole('note', { name: 'Created app' });
      expect(note.textContent).toContain(appId);
      fireEvent.click(screen.getByRole('button', { name: 'Copy client ID' }));
      await waitFor(() => expect(writeText).toHaveBeenCalledWith(appId));
      unmount();
      render(<SignIn list={list(creator)} onChanged={vi.fn()} />);
      expect(screen.queryByRole('note', { name: 'Created app' })).toBeNull();
    });
  });
});
