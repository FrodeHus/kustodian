import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BridgeError } from '../bridge';
import type { ArgScope, ArmManagementGroupsAnswer, ArmSubscriptionsAnswer } from '../wire';
import { ScopePicker } from './scope-picker';

const call = vi.hoisted(() => vi.fn());
vi.mock('../bridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../bridge')>()),
  call,
  on: () => () => undefined,
}));

const PROD = '00000000-0000-0000-0000-000000000011';
const DEV = '00000000-0000-0000-0000-000000000012';
const subscriptions: ArmSubscriptionsAnswer = {
  subscriptions: [
    { id: PROD, name: 'Contoso Production', tenantId: 't1', state: 'Enabled' },
    { id: DEV, name: 'Contoso Dev/Test', tenantId: 't1', state: 'Enabled' },
  ],
};
const groups: ArmManagementGroupsAnswer = {
  groups: [{ name: 'contoso-platform', displayName: 'Platform' }],
  note: 'Only the management groups you can read are listed.',
};

let answers: Record<string, () => Promise<unknown>>;

beforeEach(() => {
  answers = {
    'arm.subscriptions': () => Promise.resolve(subscriptions),
    'arm.managementGroups': () => Promise.resolve(groups),
    'account.consent': () => Promise.resolve({}),
  };
  call.mockReset();
  call.mockImplementation((method: string) => answers[method]?.() ?? Promise.resolve(null));
});

function Picker({ initial = null, onChange }: { initial?: ArgScope | null; onChange: (scope: ArgScope) => void }) {
  const [scope, setScope] = useState<ArgScope | null>(initial);
  const [open, setOpen] = useState(false);
  return (
    <>
      <ScopePicker
        scope={scope}
        accountKey="k1"
        open={open}
        onOpenChange={setOpen}
        onChange={(s) => {
          setScope(s);
          onChange(s);
        }}
      />
      <button type="button">Elsewhere</button>
    </>
  );
}

describe('ScopePicker', () => {
  it('scope_picker_lists_subscriptions_and_groups_with_note', async () => {
    const onChange = vi.fn();
    render(<Picker onChange={onChange} />);
    // Nothing asks ARM before the picker opens.
    expect(call).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Scope: all I can see' }));
    const dialog = screen.getByRole('dialog', { name: 'Query scope' });
    expect(within(dialog).getByRole('radio', { name: 'All I can see' }).getAttribute('aria-checked')).toBe('true');

    fireEvent.click(within(dialog).getByRole('radio', { name: 'Subscriptions' }));
    await within(dialog).findByRole('checkbox', { name: /Contoso Production/ });
    expect(within(dialog).getAllByRole('checkbox').map((c) => c.getAttribute('aria-label'))).toEqual(['Contoso Production', 'Contoso Dev/Test']);
    // The search finds by name.
    fireEvent.change(within(dialog).getByRole('searchbox', { name: 'Find a subscription' }), { target: { value: 'dev' } });
    expect(within(dialog).getAllByRole('checkbox').map((c) => c.getAttribute('aria-label'))).toEqual(['Contoso Dev/Test']);
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Contoso Dev/Test' }));
    expect(onChange).toHaveBeenLastCalledWith({ kind: 'subscriptions', ids: [DEV] });
    expect(screen.getByRole('button', { name: 'Scope: 1 subscription' })).toBeTruthy();

    fireEvent.click(within(dialog).getByRole('radio', { name: 'Management group' }));
    expect(within(dialog).getByText(groups.note!)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('radio', { name: /Platform/ }));
    expect(onChange).toHaveBeenLastCalledWith({ kind: 'managementGroup', ids: ['contoso-platform'] });
    expect(screen.getByRole('button', { name: 'Scope: contoso-platform' })).toBeTruthy();

    fireEvent.click(within(dialog).getByRole('radio', { name: 'All I can see' }));
    expect(onChange).toHaveBeenLastCalledWith({ kind: 'all', ids: [] });
    expect(call.mock.calls.map((c) => c[0]).sort()).toEqual(['arm.managementGroups', 'arm.subscriptions']);
  });

  it('scope_menu_click_lands_without_focus', async () => {
    const onChange = vi.fn();
    render(<Picker initial={{ kind: 'subscriptions', ids: [PROD] }} onChange={onChange} />);
    const trigger = screen.getByRole('button', { name: 'Scope: 1 subscription' });
    expect(fireEvent.mouseDown(trigger)).toBe(false);
    fireEvent.click(trigger);
    const dev = await screen.findByRole('checkbox', { name: 'Contoso Dev/Test' });
    expect((screen.getByRole('checkbox', { name: 'Contoso Production' }) as HTMLInputElement).checked).toBe(true);

    // macOS WebKit doesn't focus what is clicked: the mousedown keeps focus where it is, focus leaving doesn't close the
    // picker, and the click lands.
    expect(fireEvent.mouseDown(dev)).toBe(false);
    fireEvent.blur(trigger);
    fireEvent.click(dev);
    expect(onChange).toHaveBeenLastCalledWith({ kind: 'subscriptions', ids: [PROD, DEV] });
    // A multi-select stays open; the search box still takes focus.
    expect(screen.getByRole('dialog', { name: 'Query scope' })).toBeTruthy();
    expect(fireEvent.mouseDown(screen.getByRole('searchbox', { name: 'Find a subscription' }))).toBe(true);

    fireEvent.mouseDown(screen.getByRole('button', { name: 'Elsewhere' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Scope: 2 subscriptions' }));
    await screen.findByRole('checkbox', { name: 'Contoso Dev/Test' });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('scope_picker_offers_consent_and_reloads_after_it', async () => {
    answers['arm.subscriptions'] = () => Promise.reject(new BridgeError('consentNeeded', 'Azure needs your consent for this account.'));
    render(<Picker onChange={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: 'Scope: all I can see' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Subscriptions' }));

    expect(await screen.findByText('Azure needs your consent for this account.')).toBeTruthy();
    answers['arm.subscriptions'] = () => Promise.resolve(subscriptions);
    fireEvent.click(screen.getByRole('button', { name: 'Grant Azure access' }));

    await screen.findByRole('checkbox', { name: 'Contoso Production' });
    expect(call).toHaveBeenCalledWith('account.consent', { key: 'k1', audience: 'arm' });
    expect(screen.queryByText('Azure needs your consent for this account.')).toBeNull();
    await waitFor(() => expect(call.mock.calls.filter((c) => c[0] === 'arm.subscriptions')).toHaveLength(2));
  });
});
