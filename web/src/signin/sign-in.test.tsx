import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountInfo, AccountList } from '../wire';
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

const kari: AccountInfo = {
  key: 'k1',
  username: 'kari@contoso.com',
  tenantName: 'Contoso Ltd',
  tenantId: 't1',
  clientId: '04b07795-8ddb-461a-bbee-02f9e1bf7b46',
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

    expect(screen.getByRole('radio', { name: /Azure CLI/ })).toHaveProperty('checked', true);
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

  it('sign_in_prefills_default_client', async () => {
    bridge.call.mockResolvedValue(kari);
    const onChanged = vi.fn();
    const { rerender } = render(<SignIn list={none} onChanged={onChanged} defaults={{ clientId: null, tenant: null }} />);
    // No default client: the Azure CLI stays chosen.
    expect(screen.getByRole('radio', { name: /Azure CLI/ })).toHaveProperty('checked', true);

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
});
