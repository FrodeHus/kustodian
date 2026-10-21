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
    fireEvent.click(screen.getByRole('button', { name: 'Back to permissions' }));
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: /^User.Read.All/ }).checked).toBe(false);
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: /^Directory.Read.All/ }).checked).toBe(true);
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
});
