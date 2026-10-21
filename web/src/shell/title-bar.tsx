import type { AccountInfo } from '../wire';

/**
 * The window's top bar: the app's name, the source, and the account pill (tenant and user), which opens sign-in and accounts.
 * The OS draws the window's own controls, so the mockup's dots are left out.
 */
export function TitleBar({ account, onAccount }: { account: AccountInfo | undefined; onAccount: () => void }) {
  return (
    <header className="titlebar">
      <span className="brand">Kustodian</span>
      <span className="faint text-[12px]">Microsoft Graph beta</span>
      <div className="grow" />
      {/* Named by its visible text (WCAG 2.5.3); the title says what it does. */}
      <button type="button" className="pill" onClick={onAccount} title={account ? 'Accounts and sign-in' : 'Sign in'}>
        {account ? (
          <>
            <span className={account.expired ? 'dot-off' : 'dot-ok'} aria-hidden="true" />
            <b>{account.tenantName}</b> · {account.username}
          </>
        ) : (
          'Not signed in'
        )}
      </button>
    </header>
  );
}
