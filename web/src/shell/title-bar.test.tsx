import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TitleBar } from './title-bar';

describe('TitleBar', () => {
  it('title_bar_pill_shows_tenant_and_user_and_opens_accounts', () => {
    const onAccount = vi.fn();
    render(
      <TitleBar
        account={{
          key: 'k',
          username: 'kari@contoso.com',
          tenantName: 'Contoso Ltd',
          tenantId: 't',
          clientId: 'c',
          active: true,
          expired: false,
          scopes: [],
        }}
        onAccount={onAccount}
        onSettings={() => undefined}
      />,
    );

    const pill = screen.getByRole('button', { name: 'Contoso Ltd · kari@contoso.com' });
    expect(pill.textContent).toBe('Contoso Ltd · kari@contoso.com');
    fireEvent.click(pill);
    expect(onAccount).toHaveBeenCalledOnce();
  });

  it('title_bar_without_account_says_not_signed_in', () => {
    render(<TitleBar account={undefined} onAccount={() => undefined} onSettings={() => undefined} />);
    expect(screen.getByRole('button', { name: 'Not signed in' })).toHaveProperty('title', 'Sign in');
  });

  it('title_bar_settings_button_opens_settings', () => {
    const onSettings = vi.fn();
    render(<TitleBar account={undefined} onAccount={() => undefined} onSettings={onSettings} />);

    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(onSettings).toHaveBeenCalledOnce();
  });
});
