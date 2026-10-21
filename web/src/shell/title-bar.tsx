import type { AccountInfo } from '../wire';
import { MOD } from './keys';

/**
 * The window's top bar: the app's name, the source, the settings button, and the account pill (tenant and user), which opens
 * sign-in and accounts. The OS draws the window's own controls, so the mockup's dots are left out.
 */
export function TitleBar({ account, onAccount, onSettings }: { account: AccountInfo | undefined; onAccount: () => void; onSettings: () => void }) {
  return (
    <header className="titlebar">
      <span className="brand">Kustodian</span>
      <span className="faint text-[12px]">Microsoft Graph beta</span>
      <div className="grow" />
      <button type="button" className="btn ghost" aria-label="Settings" title={`Settings (${MOD} ,)`} onClick={onSettings}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </button>
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
