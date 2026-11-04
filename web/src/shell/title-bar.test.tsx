import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TitleBar } from './title-bar';

describe('TitleBar', () => {
  it('title_bar_pill_shows_the_tenant_and_its_menu_shows_the_user_and_opens_accounts', () => {
    const onAccount = vi.fn();
    render(
      <TitleBar
        account={{
          key: 'k',
          username: 'kari@contoso.com',
          tenantName: 'Contoso Ltd',
          tenantId: 't',
          clientId: 'c',
          clientKind: 'own',
          active: true,
          expired: false,
          scopes: [],
        }}
        onAccount={onAccount}
        onSettings={() => undefined}
      />,
    );

    const pill = screen.getByRole('button', { name: 'Contoso Ltd' });
    expect(pill.textContent).toBe('Contoso Ltd');
    fireEvent.click(pill);
    expect(within(screen.getByRole('menu')).getByText('kari@contoso.com')).toBeTruthy();
    expect(within(screen.getByRole('menu')).getByText('Signed in')).toBeTruthy();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Accounts and sign-in' }));
    expect(onAccount).toHaveBeenCalledOnce();
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('title_bar_without_account_says_not_signed_in', () => {
    render(<TitleBar account={undefined} onAccount={() => undefined} onSettings={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: 'Not signed in' }));
    expect(screen.getByRole('menuitem', { name: 'Sign in' })).toBeTruthy();
  });

  it('title_bar_account_menu_opens_settings', () => {
    const onSettings = vi.fn();
    render(<TitleBar account={undefined} onAccount={() => undefined} onSettings={onSettings} />);

    fireEvent.click(screen.getByRole('button', { name: 'Not signed in' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /^Settings/ }));
    expect(onSettings).toHaveBeenCalledOnce();
  });
});
