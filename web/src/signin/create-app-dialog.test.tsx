import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BridgeError } from '../bridge';
import type { EntraAppCreateResult, EntraAppPlan, PlannedPermission } from '../wire';
import { CreateAppDialog } from './create-app-dialog';

const bridge = vi.hoisted(() => ({ call: vi.fn(), events: new Map<string, (data: unknown) => void>() }));
vi.mock('../bridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../bridge')>()),
  call: bridge.call,
  on: (event: string, handler: (data: unknown) => void) => {
    bridge.events.set(event, handler);
    return () => bridge.events.delete(event);
  },
}));

function perm(name: string, tables: string[], ticked: boolean, extra: Partial<PlannedPermission> = {}): PlannedPermission {
  return { resource: 'Microsoft Graph', resourceAppId: 'g', name, adminConsent: true, description: '', tables, unlocks: null, ticked, ...extra };
}

const plan: EntraAppPlan = {
  canCreate: true,
  defaultName: 'Kustodian (kari@contoso.com)',
  tenantId: 't1',
  tenantName: 'Contoso Ltd',
  tablesWithData: 6,
  tablesWithoutData: 3,
  writeOnlyTables: 1,
  groups: [
    {
      id: 'graph',
      title: 'Graph',
      subgroups: [
        { title: 'Directory', permissions: [perm('Directory.Read.All', ['users', 'groups', 'devices'], true), perm('User.Read.All', ['users'], true)] },
        { title: 'Mail', permissions: [perm('Mail.Read', ['messages'], false, { adminConsent: false })] },
      ],
    },
    { id: 'security', title: 'Security', subgroups: [{ title: 'Advanced hunting', permissions: [perm('ThreatHunting.Read.All', ['DeviceInfo'], true)] }] },
  ],
};

const created: EntraAppCreateResult = {
  appId: '11111111-2222-3333-4444-555555555555',
  objectId: 'o1',
  servicePrincipalId: 'sp1',
  tenantId: 't1',
  ownerAdded: true,
  ownerMessage: null,
  dropped: [],
  servicePrincipalMessage: null,
  adminScopes: [],
};

function answer(create: () => Promise<unknown>, thePlan: EntraAppPlan = plan) {
  bridge.call.mockImplementation((method: string) => (method === 'entraApp.plan' ? Promise.resolve(thePlan) : create()));
}

async function open() {
  const onClose = vi.fn();
  render(<CreateAppDialog onClose={onClose} onSwitched={vi.fn()} />);
  await screen.findByRole('checkbox', { name: 'Security' });
  // The plan's render can land before its effects (focus, the group checkboxes' mixed state) run; open is done once they have.
  await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Name')));
  return onClose;
}

const createButton = () => screen.getByRole<HTMLButtonElement>('button', { name: 'Create' });

beforeEach(() => {
  bridge.call.mockReset();
  bridge.events.clear();
});

describe('CreateAppDialog', () => {
  it('groups_render_with_spec_defaults', async () => {
    answer(() => Promise.resolve(created));
    await open();
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: 'Mail' }).checked).toBe(false);
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: 'Security' }).checked).toBe(true);
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: 'Directory' }).checked).toBe(true);
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: 'Graph' }).indeterminate).toBe(true);
    expect(screen.getByLabelText<HTMLInputElement>('Name').value).toBe('Kustodian (kari@contoso.com)');
  });

  it('group_checkbox_is_mixed_when_partly_ticked', async () => {
    answer(() => Promise.resolve(created));
    await open();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Directory' }));
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: 'Directory' }).checked).toBe(false);
    fireEvent.click(screen.getByRole('checkbox', { name: /^User.Read.All/ }));
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: 'Directory' }).indeterminate).toBe(true);
  });

  it('unticking_the_only_cover_shows_you_lose', async () => {
    answer(() => Promise.resolve(created));
    await open();
    fireEvent.click(screen.getByRole('checkbox', { name: /^User.Read.All/ }));
    expect(screen.queryByText(/You lose .*users/)).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: /^Directory.Read.All/ }));
    expect(screen.getByText(/You lose 3 tables: users, groups, devices/)).toBeTruthy();
  });

  it('footer_totals_update', async () => {
    answer(() => Promise.resolve(created));
    await open();
    expect(screen.getByText('3 permissions · 4 of 6 tables · 3 need admin consent')).toBeTruthy();
    expect(screen.getByText(/3 more tables have no published delegated permission; 1 are reachable only with write permissions/)).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', { name: /^Directory.Read.All/ }));
    expect(screen.getByText('2 permissions · 2 of 6 tables · 2 need admin consent')).toBeTruthy();
  });

  it('create_disabled_for_blank_name', async () => {
    answer(() => Promise.resolve(created));
    await open();
    expect(createButton().disabled).toBe(false);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: '   ' } });
    expect(createButton().disabled).toBe(true);
  });

  it('create_is_disabled_when_the_plan_says_it_cannot_create', async () => {
    answer(() => Promise.resolve(created), { ...plan, canCreate: false, reason: "This sign-in can't create app registrations." });
    await open();
    expect(screen.getByText("This sign-in can't create app registrations.")).toBeTruthy();
    expect(createButton().disabled).toBe(true);
  });

  it('create_sends_ticked_permissions_and_shows_steps', async () => {
    let finish: (r: EntraAppCreateResult) => void = () => undefined;
    answer(() => new Promise<EntraAppCreateResult>((resolve) => (finish = resolve)));
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(bridge.call).toHaveBeenCalledWith('entraApp.create', {
      name: 'Kustodian (kari@contoso.com)',
      permissions: [
        { resource: 'Microsoft Graph', name: 'Directory.Read.All' },
        { resource: 'Microsoft Graph', name: 'User.Read.All' },
        { resource: 'Microsoft Graph', name: 'ThreatHunting.Read.All' },
      ],
    });
    act(() => bridge.events.get('entraApp.step')?.({ step: 'createApp' }));
    expect(screen.getByRole('status').textContent).toMatch(/Creating the app registration/);
    await act(async () => finish(created));
    expect(await screen.findByText(created.appId)).toBeTruthy();
  });

  it('does_not_close_while_creating', async () => {
    let finish: (r: EntraAppCreateResult) => void = () => undefined;
    answer(() => new Promise<EntraAppCreateResult>((resolve) => (finish = resolve)));
    const onClose = await open();
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    fireEvent.keyDown(document.body, { key: 'Escape' });
    fireEvent.click(screen.getByTestId('create-app-scrim'));
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => finish(created));
  });

  it('nothing_created_failure_keeps_ticks', async () => {
    answer(() => Promise.reject(new BridgeError('failed', 'Graph said no.')));
    await open();
    fireEvent.click(screen.getByRole('checkbox', { name: /^User.Read.All/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/Graph said no\./);
    expect(screen.getByText('Nothing was created.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Back to permissions' }));
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: /^User.Read.All/ }).checked).toBe(false);
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: /^Directory.Read.All/ }).checked).toBe(true);
  });

  it('a_failure_after_the_create_request_says_the_app_may_exist', async () => {
    answer(() => Promise.reject(new BridgeError('mayHaveCreated', "Kustodian couldn't reach Microsoft Graph to create the application.")));
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/couldn't reach Microsoft Graph/);
    expect(screen.getByText('The app may have been created. Check App registrations in Entra before trying again.')).toBeTruthy();
    expect(screen.queryByText('Nothing was created.')).toBeNull();
    expect(screen.getByRole('button', { name: 'Back to permissions' })).toBeTruthy();
  });

  it('esc_and_click_outside_close_when_idle', async () => {
    answer(() => Promise.resolve(created));
    const onClose = await open();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId('create-app-scrim'));
    expect(onClose).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(createButton()).toBeTruthy());
  });

  it('focuses_the_name_field_on_open_and_traps_tab', async () => {
    answer(() => Promise.resolve(created));
    await open();
    expect(document.activeElement).toBe(screen.getByLabelText('Name'));
    const dialog = screen.getByRole('dialog');
    const items = [...dialog.querySelectorAll<HTMLElement>('button, input')];
    const last = items[items.length - 1];
    last?.focus();
    fireEvent.keyDown(last as HTMLElement, { key: 'Tab' });
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(items[0]);
  });

  it('summary_names_tenant_with_id', async () => {
    answer(() => Promise.resolve(created));
    await open();
    expect(screen.getByText('Only Contoso Ltd (t1)')).toBeTruthy();
  });

  it('sign_in_needed_shows_close_not_back', async () => {
    answer(() => Promise.reject(new BridgeError('signInNeeded', 'Sign in again.')));
    const onClose = await open();
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/Sign in again/);
    expect(screen.queryByRole('button', { name: 'Back to permissions' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalled();
  });
});

describe('CreateAppDialog created view', () => {
  const adminCreated: EntraAppCreateResult = { ...created, adminScopes: ['A.Read.All', 'B.Read.All', 'C.Read.All'] };
  const calls = (method: string) => bridge.call.mock.calls.filter((c) => c[0] === method);

  function route(over: Record<string, () => Promise<unknown>> = {}, result: EntraAppCreateResult = adminCreated) {
    const handlers: Record<string, () => Promise<unknown>> = {
      'entraApp.plan': () => Promise.resolve(plan),
      'entraApp.create': () => Promise.resolve(result),
      'entraApp.canGrant': () => Promise.resolve({ canGrant: null }),
      'entraApp.consentStatus': () => Promise.resolve({ granted: ['A.Read.All', 'B.Read.All'], missing: ['C.Read.All'] }),
      'entraApp.openConsent': () => Promise.resolve({}),
      'entraApp.consentLink': () => Promise.resolve({ url: 'https://login.example/consent' }),
      'entraApp.openPortal': () => Promise.resolve({}),
      'settings.get': () => Promise.resolve({ settings: { version: 1, signIn: { clientId: null, tenant: null }, other: 1 } }),
      'settings.set': () => Promise.resolve({}),
      'account.signIn': () => Promise.resolve({}),
      ...over,
    };
    bridge.call.mockImplementation((method: string) => (handlers[method] ?? (() => Promise.resolve({})))());
  }

  async function toCreated(onSwitched = vi.fn(), onClose = vi.fn()) {
    render(<CreateAppDialog onClose={onClose} onSwitched={onSwitched} />);
    await screen.findByRole('checkbox', { name: 'Security' });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await screen.findByText(result_id);
    return { onSwitched, onClose };
  }
  const result_id = created.appId;

  it('primary_consent_button_follows_can_grant', async () => {
    for (const [canGrant, primary, other] of [
      [true, 'Open admin consent page', 'Copy link for an admin'],
      [false, 'Copy link for an admin', 'Open admin consent page'],
      [null, null, null],
    ] as const) {
      bridge.call.mockReset();
      route({ 'entraApp.canGrant': () => Promise.resolve({ canGrant }) });
      const { unmount } = render(<CreateAppDialog onClose={vi.fn()} onSwitched={vi.fn()} />);
      await screen.findByRole('checkbox', { name: 'Security' });
      fireEvent.click(screen.getByRole('button', { name: 'Create' }));
      await screen.findByText(result_id);
      await waitFor(() => expect(calls('entraApp.canGrant').length).toBe(1));
      await act(async () => undefined);
      const open = screen.getByRole('button', { name: 'Open admin consent page' });
      const copy = screen.getByRole('button', { name: 'Copy link for an admin' });
      if (primary === null) {
        expect(open.className).not.toMatch(/primary/);
        expect(copy.className).not.toMatch(/primary/);
      } else {
        expect(screen.getByRole('button', { name: primary }).className).toMatch(/primary/);
        expect(screen.getByRole('button', { name: other }).className).not.toMatch(/primary/);
      }
      if (canGrant === false) {
        expect(screen.getByText(/You can’t grant this yourself/)).toBeTruthy();
      }
      expect(screen.getByText(/Until an admin grants them/)).toBeTruthy();
      unmount();
    }
  });

  it('shows_owner_and_dropped_messages', async () => {
    route({}, { ...adminCreated, ownerAdded: false, ownerMessage: 'Could not add you as owner.', dropped: ['Old.Read.All'] });
    await toCreated();
    expect(screen.getByText('Could not add you as owner.')).toBeTruthy();
    expect(screen.getByText(/Not in your tenant: Old\.Read\.All/)).toBeTruthy();
  });

  it('check_again_lists_missing_scopes', async () => {
    route();
    await toCreated();
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    expect(await screen.findByText(/Granted for the tenant: 2 of 3/)).toBeTruthy();
    expect(screen.getByText(/missing C\.Read\.All/)).toBeTruthy();
    expect(bridge.call).toHaveBeenCalledWith('entraApp.consentStatus', { appId: created.appId, adminScopes: adminCreated.adminScopes });
  });

  it('open_and_copy_use_the_bridge_and_clipboard', async () => {
    route();
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await toCreated();
    fireEvent.click(screen.getByRole('button', { name: 'Open admin consent page' }));
    await waitFor(() => expect(bridge.call).toHaveBeenCalledWith('entraApp.openConsent', { appId: created.appId }));
    fireEvent.click(screen.getByRole('button', { name: 'Copy link for an admin' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('https://login.example/consent'));
    fireEvent.click(screen.getByRole('button', { name: 'Open in Entra admin center' }));
    await waitFor(() => expect(bridge.call).toHaveBeenCalledWith('entraApp.openPortal', { appId: created.appId }));
    fireEvent.click(screen.getByRole('button', { name: 'Copy Client ID' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(created.appId));
  });

  it('switch_writes_settings_then_signs_in', async () => {
    route();
    const { onSwitched } = await toCreated();
    fireEvent.click(screen.getByRole('button', { name: 'Switch and sign in' }));
    await waitFor(() => expect(onSwitched).toHaveBeenCalled());
    const order = bridge.call.mock.calls.map((c) => c[0]).filter((m) => m === 'settings.get' || m === 'settings.set' || m === 'account.signIn');
    expect(order).toEqual(['settings.get', 'settings.set', 'account.signIn']);
    expect(bridge.call).toHaveBeenCalledWith('settings.set', { settings: { version: 1, signIn: { clientId: created.appId, tenant: 't1' }, other: 1 } });
    expect(bridge.call).toHaveBeenCalledWith('account.signIn', { clientId: created.appId, tenant: 't1', deviceCode: false });
  });

  it('just_show_closes_without_settings_set', async () => {
    route();
    const { onClose } = await toCreated();
    fireEvent.click(screen.getByRole('button', { name: 'Just show me the client ID' }));
    expect(onClose).toHaveBeenCalled();
    expect(calls('settings.set')).toHaveLength(0);
  });

  it('consent_error_on_switch_returns_to_grant_step', async () => {
    route({ 'account.signIn': () => Promise.reject(new BridgeError('failed', 'AADSTS65001: The user has not consented.')) });
    const { onSwitched } = await toCreated();
    fireEvent.click(screen.getByRole('button', { name: 'Switch and sign in' }));
    const message = await screen.findByText('This app still needs an admin to grant its permissions');
    expect(onSwitched).not.toHaveBeenCalled();
    // It is shown in step 1, and that step's primary button has the focus.
    expect(message.closest('.card')?.textContent).toMatch(/1\. Grant for the whole tenant/);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Open admin consent page' })));
  });

  it('other_switch_errors_are_shown_as_they_are', async () => {
    route({ 'account.signIn': () => Promise.reject(new BridgeError('failed', 'Browser closed.')) });
    await toCreated();
    fireEvent.click(screen.getByRole('button', { name: 'Switch and sign in' }));
    expect(await screen.findByText('Browser closed.')).toBeTruthy();
  });

  it('retry_service_principal', async () => {
    const partial = { ...adminCreated, servicePrincipalId: null, servicePrincipalMessage: 'Graph said 403 Forbidden.' };
    route({
      'entraApp.retryServicePrincipal': () =>
        Promise.resolve({ ...partial, servicePrincipalId: 'sp9', servicePrincipalMessage: null, ownerAdded: false, dropped: [], adminScopes: [] }),
    }, partial);
    await toCreated();
    expect(screen.getByText(/Graph said 403 Forbidden/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open in Entra' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open admin consent page' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull());
    expect(bridge.call).toHaveBeenCalledWith('entraApp.retryServicePrincipal', { appId: created.appId, objectId: 'o1' });
    // The earlier result's other fields are kept.
    expect(screen.getByRole('button', { name: 'Open admin consent page' })).toBeTruthy();
    expect(screen.queryByText(/Could not add you/)).toBeNull();
  });

  it('open_in_entra_in_the_missing_principal_block_is_disabled_while_busy_and_shows_its_own_error', async () => {
    const partial = { ...adminCreated, servicePrincipalId: null, servicePrincipalMessage: 'Graph said 403 Forbidden.' };
    let reject: (e: unknown) => void = () => undefined;
    route({ 'entraApp.openPortal': () => new Promise((_, r) => (reject = r)) }, partial);
    await toCreated();
    const open = screen.getByRole<HTMLButtonElement>('button', { name: 'Open in Entra' });
    fireEvent.click(open);
    await waitFor(() => expect(open.disabled).toBe(true));
    reject(new BridgeError('failed', "Kustodian couldn't open your browser."));
    const message = await screen.findByText("Kustodian couldn't open your browser.");
    expect(screen.getByText(/1\. Grant for the whole tenant/).closest('.card')?.contains(message)).toBe(false);
    expect(message.parentElement?.textContent).toMatch(/Try again/);
    expect(open.disabled).toBe(false);
  });

  it('clipboard_missing_shows_a_note', async () => {
    route();
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    await toCreated();
    fireEvent.click(screen.getByRole('button', { name: 'Copy Client ID' }));
    expect(await screen.findByText(/Couldn’t copy client id/)).toBeTruthy();
  });

  it('does_not_close_while_switching', async () => {
    let finish: (v: unknown) => void = () => undefined;
    route({ 'account.signIn': () => new Promise((resolve) => (finish = resolve)) });
    const { onClose } = await toCreated();
    fireEvent.click(screen.getByRole('button', { name: 'Switch and sign in' }));
    await waitFor(() => expect(calls('account.signIn')).toHaveLength(1));
    fireEvent.keyDown(document.body, { key: 'Escape' });
    fireEvent.click(screen.getByTestId('create-app-scrim'));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Just show me the client ID' }).disabled).toBe(true);
    await act(async () => finish({}));
  });

  it('nothing_needing_an_admin_hides_check_again', async () => {
    route({}, { ...created, adminScopes: [] });
    await toCreated();
    expect(screen.getByText('No permissions need an admin’s consent.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Check again' })).toBeNull();
    expect(screen.queryByText(/0 of 0/)).toBeNull();
  });

  it('just_show_hands_the_app_to_the_caller', async () => {
    route();
    const onClientId = vi.fn();
    render(<CreateAppDialog onClose={vi.fn()} onSwitched={vi.fn()} onClientId={onClientId} />);
    await screen.findByRole('checkbox', { name: 'Security' });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await screen.findByText(created.appId);
    fireEvent.click(screen.getByRole('button', { name: 'Just show me the client ID' }));
    expect(onClientId).toHaveBeenCalledWith({ name: 'Kustodian (kari@contoso.com)', appId: created.appId, tenantId: created.tenantId });
  });
});
