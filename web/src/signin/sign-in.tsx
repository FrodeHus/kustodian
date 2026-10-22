import { useEffect, useState, type ReactNode } from 'react';
import { call, on } from '../bridge';
import { AZURE_CLI_CLIENT_ID, type AccountInfo, type AccountList } from '../wire';
import { CreateAppDialog } from './create-app-dialog';
import { CANNOT_CREATE_REASON, canCreateApp, canOfferCreateApp } from './permission-plan';
import { TenantLicenses } from './tenant-licenses';

function clientLabel(clientId: string): string {
  return clientId === AZURE_CLI_CLIENT_ID ? 'Azure CLI client' : `client ${clientId.slice(0, 4)}…${clientId.slice(-4)}`;
}

interface SignInProps {
  list: AccountList | null;
  /** An account was signed in, chosen or signed out. `done`: the user has an account to work with now. */
  onChanged: (done: boolean) => void;
  /** Back to the queries, when the screen was opened from the account pill. */
  onBack?: () => void;
  /** Why the accounts couldn't be read, if they couldn't. */
  error?: string | null;
  /** The settings' default client ID and tenant: with a client ID, "My own app registration" starts chosen and filled in. */
  defaults?: { clientId: string | null; tenant: string | null };
  /** "Create Entra ID application" is open (the palette command opens the screen with it open). Kept here when not given. */
  createAppOpen?: boolean;
  onCreateAppOpen?: (open: boolean) => void;
}

/** Sign-in and accounts (spec 6.7, mockup SignIn). */
export function SignIn({ list, onChanged, onBack, error: listError = null, defaults, createAppOpen, onCreateAppOpen }: SignInProps) {
  /** The app "Just show me the client ID" left behind: its note stays in the account card until this screen is left. */
  const [shownApp, setShownApp] = useState<{ name: string; appId: string } | null>(null);
  const [copyNote, setCopyNote] = useState<string | null>(null);
  const [localCreateOpen, setLocalCreateOpen] = useState(false);
  const createOpen = createAppOpen ?? localCreateOpen;
  const setCreateOpen = onCreateAppOpen ?? setLocalCreateOpen;
  const [ownChoice, setOwn] = useState(false);
  const [typedClientId, setClientId] = useState('');
  const [typedTenant, setTenant] = useState('');
  // The settings' defaults show until the user changes the form; they may arrive after the screen opened.
  const [touched, setTouched] = useState(false);
  const defaultClient = defaults?.clientId ?? null;
  const prefilled = !touched && defaultClient !== null;
  const own = prefilled || ownChoice;
  const clientId = prefilled ? defaultClient : typedClientId;
  const tenant = prefilled ? (defaults?.tenant ?? '') : typedTenant;
  /** The user changes the form: from now on it holds what it shows, defaults included. */
  const touch = () => {
    if (prefilled) {
      setOwn(true);
      setClientId(clientId);
      setTenant(tenant);
    }
    setTouched(true);
  };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deviceCode, setDeviceCode] = useState<string | null>(null);

  useEffect(() => on('account.deviceCode', (data) => setDeviceCode((data as { message: string }).message)), []);

  const accounts = list?.accounts ?? [];
  const active = accounts.find((a) => a.active);
  const memoryOnly = list?.cache === 'memoryOnly';
  const offerCreate = canOfferCreateApp(active);
  /** Whether the active sign-in can also create app registrations (spec 6.1): decided here from its scopes, no host call. */
  const createAllowed = canCreateApp(active);

  async function act(work: () => Promise<unknown>, done: boolean) {
    setBusy(true);
    setError(null);
    try {
      await work();
      onChanged(done);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setDeviceCode(null);
    }
  }

  function signIn(params: { clientId?: string; tenant?: string; deviceCode: boolean }) {
    return act(() => call<AccountInfo>('account.signIn', params), true);
  }

  function signInHere(useDeviceCode: boolean) {
    const params: { clientId?: string; tenant?: string; deviceCode: boolean } = { deviceCode: useDeviceCode };
    if (own) {
      if (clientId.trim()) {
        params.clientId = clientId.trim();
      }
      if (tenant.trim()) {
        params.tenant = tenant.trim();
      }
    }
    void signIn(params);
  }

  const canSignIn = !busy && (!own || clientId.trim() !== '');

  return (
    <div className="flex min-h-0 flex-1 items-start gap-8 overflow-auto px-16 py-12">
      <section className="card flex w-[520px] shrink-0 flex-col gap-[18px] p-7" aria-label="Sign in">
        <div className="flex flex-col gap-1.5">
          <h1 className="m-0 text-[22px] leading-7 font-semibold">Sign in to Microsoft Graph</h1>
          <span className="muted">Queries run as you, with your delegated permissions, in the tenant you sign in to.</span>
        </div>
        <button type="button" className="btn primary h-10 justify-center text-[14px]" disabled={!canSignIn} onClick={() => signInHere(false)}>
          Sign in with your browser
        </button>
        <button type="button" className="btn h-10 justify-center" disabled={!canSignIn} onClick={() => signInHere(true)}>
          Use a device code instead
        </button>
        {deviceCode && (
          <div className="codeblock whitespace-pre-wrap" role="status">
            {deviceCode}
          </div>
        )}
        {busy && !deviceCode && (
          <span className="muted text-[12px]" role="status">
            Waiting for the sign-in to finish…
          </span>
        )}
        {(error ?? listError) && (
          <span className="text-[12px] text-bad" role="alert">
            {error ?? listError}
          </span>
        )}
        <div className="flex flex-col gap-1" role="radiogroup" aria-label="Signing in as">
          <span className="muted text-[12px]">Signing in as</span>
          <ClientChoice
            checked={!own}
            onChange={() => {
              touch();
              setOwn(false);
            }}
          >
            <b>Azure CLI</b> <span className="faint">(default)</span>
            <br />
            <span className="muted text-[12px]">
              Microsoft’s public client {AZURE_CLI_CLIENT_ID}. Most tenants have already consented to what it asks for.
            </span>
          </ClientChoice>
          <ClientChoice
            checked={own}
            onChange={() => {
              touch();
              setOwn(true);
            }}
          >
            <b>My own app registration</b>
            <br />
            <span className="muted text-[12px]">A public client with http://localhost as a redirect URI.</span>
          </ClientChoice>
        </div>
        <div className="grid grid-cols-2 gap-3" style={{ opacity: own ? 1 : 0.55 }}>
          <div className="field">
            <label htmlFor="client-id">Client ID</label>
            <input
              id="client-id"
              className="textbox mono"
              placeholder="00000000-0000-0000-0000-000000000000"
              disabled={!own}
              value={clientId}
              onChange={(e) => {
                touch();
                setClientId(e.target.value);
              }}
            />
          </div>
          <div className="field">
            <label htmlFor="tenant">Tenant</label>
            <input
              id="tenant"
              className="textbox mono"
              placeholder="organizations or a tenant ID"
              disabled={!own}
              value={tenant}
              onChange={(e) => {
                touch();
                setTenant(e.target.value);
              }}
            />
          </div>
        </div>
        <span className="faint text-[12px]">
          {memoryOnly
            ? 'Your token stays in memory while Kustodian runs. Nothing is sent anywhere but Microsoft.'
            : 'Your token stays in this computer’s keychain. Nothing is sent anywhere but Microsoft.'}
        </span>
      </section>

      <section className="flex min-w-0 flex-1 flex-col gap-4">
        {onBack && (
          <div>
            <button type="button" className="btn ghost" onClick={onBack}>
              ← Back to queries
            </button>
          </div>
        )}
        {memoryOnly && (
          <div className="card flex flex-col gap-1.5 border-warn p-5" role="note" aria-label="Token cache">
            <b className="text-[14px] text-warn">Sign-ins aren’t remembered on this computer</b>
            <span className="muted text-[12px]">
              {list?.cacheReason ? `${list.cacheReason} ` : ''}Tokens are kept in memory only, so you sign in again each time Kustodian
              starts.
            </span>
          </div>
        )}
        {accounts.length > 0 && (
          <div className="card flex flex-col gap-3 p-5" aria-label="Accounts" role="region">
            <b className="text-[14px]">Accounts on this computer</b>
            {accounts.map((a) => (
              <div key={a.key} className="flex items-center gap-3 rounded-lg border border-line px-3 py-2.5">
                <span className={a.expired ? 'dot-off' : 'dot-ok'} aria-hidden="true" />
                <div className="flex min-w-0 flex-col">
                  <b className="truncate">{a.username}</b>
                  <span className="muted text-[12px]">
                    {a.tenantName} · {clientLabel(a.clientId)}
                    {a.expired ? ' · token expired, sign in again' : a.active ? ' · in use' : ''}
                  </span>
                </div>
                <div className="grow" />
                {a.expired ? (
                  <button
                    type="button"
                    className="btn"
                    disabled={busy}
                    aria-label={`Sign in again as ${a.username}`}
                    onClick={() =>
                      void signIn({ ...(a.clientId === AZURE_CLI_CLIENT_ID ? {} : { clientId: a.clientId }), tenant: a.tenantId, deviceCode: false })
                    }
                  >
                    Sign in
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn"
                    disabled={busy || a.active}
                    aria-label={`Use ${a.username}`}
                    onClick={() => void act(() => call('account.use', { key: a.key }), true)}
                  >
                    {a.active ? 'In use' : 'Use'}
                  </button>
                )}
                <button
                  type="button"
                  className="btn ghost"
                  disabled={busy}
                  aria-label={`Sign out ${a.username}`}
                  onClick={() => void act(() => call('account.signOut', { key: a.key }), false)}
                >
                  Sign out
                </button>
              </div>
            ))}
            <span className="muted text-[12px]">
              One tenant at a time. Switching closes no tabs; each run uses the account active when it starts.
            </span>
          </div>
        )}
        {active && (
          <div className="card flex flex-col gap-2.5 p-5" aria-label="What this sign-in can read" role="region">
            <b className="text-[14px]">What this sign-in can read</b>
            <span className="muted text-[12px]">
              From the token’s scopes. A table you can’t read answers “No permission” when you run it.
            </span>
            <div className="flex flex-wrap gap-1.5">
              {active.scopes.map((scope) => (
                <span key={scope} className="chip ok">
                  {scope}
                </span>
              ))}
            </div>
            <span className="faint text-[12px]">Delegated permissions are also limited by your own Entra roles.</span>
            <TenantLicenses accountKey={active.key} />
            {shownApp && (
              <div className="flex flex-col items-start gap-1 border-t border-line pt-2.5" role="note" aria-label="Created app">
                <span className="text-[12.5px]">
                  {shownApp.name} was created. Client ID <span className="mono">{shownApp.appId}</span>
                </span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    className="btn"
                    onClick={() =>
                      void Promise.resolve()
                        .then(() => navigator.clipboard.writeText(shownApp.appId))
                        .then(
                          () => setCopyNote('Client ID copied.'),
                          () => setCopyNote('Couldn’t copy; select it and copy by hand.'),
                        )
                    }
                  >
                    Copy client ID
                  </button>
                  {copyNote && (
                    <span className="faint text-[12px]" role="status">
                      {copyNote}
                    </span>
                  )}
                </div>
                <span className="muted text-[12px]">Use it later under “My own app registration”.</span>
              </div>
            )}
            {offerCreate && (
              <div className="flex flex-col items-start gap-1.5 border-t border-line pt-2.5">
                <button type="button" className="btn" disabled={!createAllowed} onClick={() => setCreateOpen(true)}>
                  Create Entra ID application…
                </button>
                {!createAllowed && <span className="muted text-[12px]">{CANNOT_CREATE_REASON}</span>}
              </div>
            )}
          </div>
        )}
      </section>
      {createOpen && (
        <CreateAppDialog
          onClose={() => setCreateOpen(false)}
          onClientId={setShownApp}
          onSwitched={() => {
            setCreateOpen(false);
            onChanged(true);
          }}
        />
      )}
    </div>
  );
}

function ClientChoice({ checked, onChange, children }: { checked: boolean; onChange: () => void; children: ReactNode }) {
  return (
    <label
      className="flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2.5"
      style={{ borderColor: checked ? 'var(--accent)' : 'var(--line)', background: checked ? 'var(--accent-soft)' : undefined }}
    >
      <input type="radio" name="client" checked={checked} onChange={onChange} className="mt-[3px] accent-accent" />
      <span>{children}</span>
    </label>
  );
}
