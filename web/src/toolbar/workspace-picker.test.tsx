import { fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BridgeError } from '../bridge';
import type { ArmSubscriptionsAnswer, ArmWorkspacesAnswer, QueryWorkspace } from '../wire';
import { WorkspacePicker } from './workspace-picker';

const call = vi.hoisted(() => vi.fn());
vi.mock('../bridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../bridge')>()),
  call,
  on: () => () => undefined,
}));

const PROD = '00000000-0000-0000-0000-000000000011';
const OTHER = '00000000-0000-0000-0000-000000000012';
const subscriptions: ArmSubscriptionsAnswer = { subscriptions: [{ id: PROD, name: 'Contoso Production', tenantId: 't1', state: 'Enabled' }] };
const workspaces: ArmWorkspacesAnswer = {
  workspaces: [
    { customerId: 'c-sentinel', name: 'contoso-sentinel', resourceId: '/r/sentinel', resourceGroup: 'rg-security', subscriptionId: PROD, location: 'westeurope' },
    { customerId: 'c-logs', name: 'contoso-logs', resourceId: '/r/logs', resourceGroup: 'rg-logging', subscriptionId: OTHER, location: 'northeurope' },
  ],
};
const sentinel: QueryWorkspace = { customerId: 'c-sentinel', name: 'contoso-sentinel', resourceId: '/r/sentinel' };

let answers: Record<string, () => Promise<unknown>>;

beforeEach(() => {
  answers = {
    'arm.subscriptions': () => Promise.resolve(subscriptions),
    'arm.workspaces': () => Promise.resolve(workspaces),
    'account.consent': () => Promise.resolve({}),
  };
  call.mockReset();
  call.mockImplementation((method: string) => answers[method]?.() ?? Promise.resolve(null));
});

function Picker({ initial = null, onChange, onSignIn = () => undefined }: { initial?: QueryWorkspace[] | null; onChange: (w: QueryWorkspace[] | null) => void; onSignIn?: () => void }) {
  const [value, setValue] = useState<QueryWorkspace[] | null>(initial);
  const [open, setOpen] = useState(false);
  return (
    <WorkspacePicker
      workspaces={value}
      accountKey="k1"
      onSignIn={onSignIn}
      open={open}
      onOpenChange={setOpen}
      onChange={(w) => {
        setValue(w);
        onChange(w);
      }}
    />
  );
}

describe('WorkspacePicker', () => {
  it('shows_primary_workspace_first_and_checked_when_none', async () => {
    render(<Picker onChange={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: 'Workspace: Primary workspace' }));
    const dialog = screen.getByRole('dialog', { name: 'Workspace' });
    const primary = within(dialog).getAllByRole('radio')[0] as HTMLInputElement;
    expect(primary.checked).toBe(true);
    expect(within(dialog).getByText('Primary workspace')).toBeTruthy();
    expect(within(dialog).getByText("Default. Defender's tables, plus your primary Sentinel workspace if one is connected.")).toBeTruthy();
    expect(
      within(dialog).getByText(
        "Defender reaches a workspace's tables when it's onboarded to the Defender portal and you have Microsoft Sentinel Reader on it. The workspace is saved with the query.",
      ),
    ).toBeTruthy();
    await within(dialog).findByText('contoso-sentinel');
  });

  it('lists_workspaces_with_group_subscription_and_location', async () => {
    render(<Picker onChange={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: /Workspace:/ }));
    await screen.findByText('rg-security · Contoso Production · westeurope');
    // A subscription the account's list lacks shows by its id.
    expect(screen.getByText(`rg-logging · ${OTHER} · northeurope`)).toBeTruthy();
  });

  it('picking_a_workspace_reports_one_entry', async () => {
    const onChange = vi.fn();
    render(<Picker onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: /Workspace:/ }));
    fireEvent.click(await screen.findByRole('radio', { name: /contoso-sentinel/ }));
    expect(onChange).toHaveBeenCalledWith([sentinel]);
    expect(screen.getByRole('button', { name: 'Workspace: contoso-sentinel' })).toBeTruthy();
  });

  it('picking_primary_reports_null', async () => {
    const onChange = vi.fn();
    render(<Picker initial={[sentinel]} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Workspace: contoso-sentinel' }));
    fireEvent.click(screen.getAllByRole('radio')[0]!);
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('a_saved_workspace_missing_from_the_list_shows_not_available', async () => {
    const gone = { customerId: 'c-gone', name: 'contoso-sentinel', resourceId: '/r/gone' };
    answers['arm.workspaces'] = () => Promise.resolve({ workspaces: [] });
    render(<Picker initial={[gone]} onChange={() => undefined} />);
    expect(screen.getByRole('button', { name: 'Workspace: contoso-sentinel' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Workspace:/ }));
    const trigger = await screen.findByRole('button', { name: 'Workspace: contoso-sentinel · not available' });
    expect(trigger.className).toContain('border-bad');
    expect(trigger.className).toContain('text-bad');
  });

  it('the_trigger_prefers_the_lists_name_to_the_saved_one', async () => {
    const relabelled = { customerId: 'C-SENTINEL', name: 'someone else', resourceId: '/r/sentinel' };
    render(<Picker initial={[relabelled]} onChange={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: /Workspace:/ }));
    expect(await screen.findByRole('button', { name: 'Workspace: contoso-sentinel' })).toBeTruthy();
  });

  it('a_saved_workspace_in_the_list_keeps_the_normal_tone', async () => {
    render(<Picker initial={[sentinel]} onChange={() => undefined} />);
    const trigger = screen.getByRole('button', { name: 'Workspace: contoso-sentinel' });
    fireEvent.click(trigger);
    await screen.findByRole('radio', { name: /contoso-logs/ });
    expect(trigger.className).not.toContain('bad');
    expect(trigger.textContent).not.toContain('not available');
  });

  it('the_trigger_forgets_the_list_when_the_account_changes', async () => {
    const gone = { customerId: 'c-gone', name: 'contoso-sentinel', resourceId: '/r/gone' };
    answers['arm.workspaces'] = () => Promise.resolve({ workspaces: [] });
    const props = { workspaces: [gone], onChange: () => undefined, onSignIn: () => undefined, open: false, onOpenChange: () => undefined };
    const { rerender } = render(<WorkspacePicker {...props} accountKey="k1" />);
    rerender(<WorkspacePicker {...props} open accountKey="k1" />);
    await screen.findByRole('button', { name: 'Workspace: contoso-sentinel · not available' });
    rerender(<WorkspacePicker {...props} accountKey="k2" />);
    expect(screen.getByRole('button', { name: 'Workspace: contoso-sentinel' }).className).not.toContain('bad');
  });

  it('the_chosen_radio_is_checked_ignoring_case', async () => {
    render(<Picker initial={[{ ...sentinel, customerId: 'C-SENTINEL' }]} onChange={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: /Workspace:/ }));
    expect(((await screen.findByRole('radio', { name: /contoso-sentinel/ })) as HTMLInputElement).checked).toBe(true);
  });

  it('focus_moves_to_the_chosen_radio_once_the_list_has_rendered', async () => {
    render(<Picker initial={[sentinel]} onChange={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: /Workspace:/ }));
    const radio = await screen.findByRole('radio', { name: /contoso-sentinel/ });
    await vi.waitFor(() => expect(document.activeElement).toBe(radio));
  });

  it('consent_and_sign_in_states_match_the_scope_picker', async () => {
    const onSignIn = vi.fn();
    answers['arm.workspaces'] = () => Promise.reject(new BridgeError('consentNeeded', 'Azure needs your consent for this account.'));
    render(<Picker onChange={() => undefined} onSignIn={onSignIn} />);
    fireEvent.click(screen.getByRole('button', { name: /Workspace:/ }));
    expect(await screen.findByText('Azure needs your consent for this account.')).toBeTruthy();
    answers['arm.workspaces'] = () => Promise.resolve(workspaces);
    fireEvent.click(screen.getByRole('button', { name: 'Grant Azure access' }));
    await screen.findByRole('radio', { name: /contoso-sentinel/ });
    expect(call).toHaveBeenCalledWith('account.consent', { key: 'k1', audience: 'arm' });

    answers['arm.workspaces'] = () => Promise.reject(new BridgeError('signInNeeded', 'Sign in again to list workspaces.'));
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: /Workspace:/ }));
    expect(await screen.findByText('Sign in again to list workspaces.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(onSignIn).toHaveBeenCalledOnce();
  });
});
