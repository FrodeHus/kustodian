import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { AccountInfo } from '../wire';
import { MOD } from './keys';
import logo from './logo.png';

/**
 * The window's top bar: the app's name, the open tabs (`children`), and the account button (tenant and user), whose menu opens
 * accounts and sign-in, and settings. The OS draws the window's own controls, so the mockup's dots are left out.
 */
export function TitleBar({
  account,
  onAccount,
  onSettings,
  children,
}: {
  account: AccountInfo | undefined;
  onAccount: () => void;
  onSettings: () => void;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Closes on a click outside it or Esc, as the tab strip's menus do.
  useEffect(() => {
    if (!open) {
      return;
    }
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    const onDown = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const choose = (run: () => void) => {
    setOpen(false);
    run();
  };

  return (
    <header className="titlebar">
      <span className="brand">
        <img src={logo} width={16} height={16} alt="" />
        Kustodian
      </span>
      <div className="flex min-w-0 grow self-stretch">{children}</div>
      <div className="relative" ref={menuRef}>
        {/* Named by its visible text (WCAG 2.5.3); the title says what it does. */}
        <button type="button" className="pill" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)} title="Account and settings">
          {account ? (
            <>
              <span className={account.expired ? 'dot-off' : 'dot-ok'} aria-hidden="true" />
              <b>{account.tenantName}</b> · {account.username}
            </>
          ) : (
            'Not signed in'
          )}
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
        {open && (
          <div className="menu" role="menu" aria-label="Account and settings" style={{ right: 0, top: 30, width: 260 }} onMouseDown={(e) => e.preventDefault()}>
            <button type="button" role="menuitem" onClick={() => choose(onAccount)}>
              {account ? 'Accounts and sign-in' : 'Sign in'}
            </button>
            <button type="button" role="menuitem" onClick={() => choose(onSettings)}>
              Settings
              <span className="grow" />
              <span className="kbd">{MOD} ,</span>
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
