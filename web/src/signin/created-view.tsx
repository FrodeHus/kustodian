import { useEffect, useRef, useState, type ReactNode } from 'react';
import { call } from '../bridge';
import { errorText } from '../shell/errors';
import type { AppSettings, EntraAppConsentStatus, EntraAppCreateResult, SettingsAnswer } from '../wire';

const NEEDS_ADMIN = /AADSTS65001|AADSTS90094/;

/** The app "Just show me the client ID" leaves behind, and the tenant it was created in. */
export interface CreatedApp {
  name: string;
  appId: string;
  tenantId: string;
}

interface CreatedViewProps {
  name: string;
  initial: EntraAppCreateResult;
  /** How many permissions the app lists. */
  listed: number;
  onClose: () => void;
  onSwitched: () => void;
  /** Signing in with the app starts and ends: the dialog can't be closed meanwhile. */
  onSwitching: (switching: boolean) => void;
  onClientId?: (app: CreatedApp) => void;
}

/** The dialog after Create (spec 6.5, 7, 8; mockups EntraAppCreated and EntraAppRefused): the ids, admin consent, then what now. */
export function CreatedView({ name, initial, listed, onClose, onSwitched, onSwitching, onClientId }: CreatedViewProps) {
  const [result, setResult] = useState(initial);
  const [canGrant, setCanGrant] = useState<boolean | null>(null);
  const [status, setStatus] = useState<EntraAppConsentStatus | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [switchProblem, setSwitchProblem] = useState<string | null>(null);
  const [consentProblem, setConsentProblem] = useState<string | null>(null);
  /** Why "Open in Entra" in the missing-service-principal block failed; shown next to that button. */
  const [portalProblem, setPortalProblem] = useState<string | null>(null);
  const grantButton = useRef<HTMLButtonElement>(null);

  const { appId, objectId, tenantId, adminScopes } = result;
  const needsAdmin = adminScopes.length > 0;
  const focusGrant = useRef(false);
  const noPrincipal = result.servicePrincipalId === null;

  useEffect(() => {
    if (focusGrant.current && !busy) {
      focusGrant.current = false;
      grantButton.current?.focus();
    }
  }, [busy]);

  useEffect(() => {
    let live = true;
    call<{ canGrant?: unknown }>('entraApp.canGrant').then(
      (a) => live && setCanGrant(typeof a?.canGrant === 'boolean' ? a.canGrant : null),
      () => live && setCanGrant(null),
    );
    return () => {
      live = false;
    };
  }, []);

  /** Runs a bridge call for a button; its failure is shown under the step. */
  async function run(work: () => Promise<void>) {
    setBusy(true);
    setProblem(null);
    try {
      await work();
    } catch (e) {
      setProblem(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const copy = (text: string, what: string) =>
    Promise.resolve()
      .then(() => navigator.clipboard.writeText(text))
      .then(
        () => setNote(`${what} copied.`),
        () => setNote(`Couldn’t copy ${what.toLowerCase()}; select it and copy by hand.`),
      );

  const openConsent = () => run(async () => void (await call('entraApp.openConsent', { appId })));
  const copyLink = () =>
    run(async () => {
      const answer = await call<{ url: string }>('entraApp.consentLink', { appId });
      await copy(answer.url, 'Link');
    });
  const checkAgain = () =>
    run(async () => {
      setStatus(await call<EntraAppConsentStatus>('entraApp.consentStatus', { appId, adminScopes }));
    });
  const retry = () =>
    run(async () => {
      const again = await call<EntraAppCreateResult>('entraApp.retryServicePrincipal', { appId, objectId });
      // The retry answers only step 4: the earlier result keeps everything else.
      setResult((r) => ({ ...r, servicePrincipalId: again.servicePrincipalId, servicePrincipalMessage: again.servicePrincipalMessage }));
    });

  async function openPortal() {
    setBusy(true);
    setPortalProblem(null);
    try {
      await call('entraApp.openPortal', { appId });
    } catch (e) {
      setPortalProblem(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function switchToApp() {
    setBusy(true);
    onSwitching(true);
    setProblem(null);
    setSwitchProblem(null);
    setConsentProblem(null);
    try {
      const current = await call<SettingsAnswer>('settings.get');
      const next: AppSettings = { ...current.settings, signIn: { clientId: appId, tenant: tenantId } };
      await call('settings.set', { settings: next });
      await call('account.signIn', { clientId: appId, tenant: tenantId, deviceCode: false });
      onSwitched();
    } catch (e) {
      const text = errorText(e);
      if (NEEDS_ADMIN.test(text)) {
        // Back to step 1: the message is shown there and its primary button takes the focus.
        setConsentProblem('This app still needs an admin to grant its permissions');
        focusGrant.current = true;
      } else {
        setSwitchProblem(text);
      }
      setBusy(false);
      onSwitching(false);
    }
  }

  const openPrimary = canGrant !== false && canGrant !== null;
  const copyPrimary = canGrant === false;
  const grantedCount = status ? adminScopes.length - status.missing.length : 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-6">
      <div className="flex flex-col gap-1">
        <b className="text-[15px]">{`✓ ${name} was created`}</b>
        <span className="muted text-[12.5px]">
          {noPrincipal ? 'App registration' : 'App registration and service principal'}
          {`, with ${listed} delegated permissions listed. Nothing is granted yet.`}
        </span>
      </div>

      <div className="card flex flex-col gap-2 bg-panel2 px-3.5 py-3">
        <IdRow label="Client ID" value={appId} onCopy={() => void copy(appId, 'Client ID')} />
        <IdRow label="Tenant ID" value={tenantId} onCopy={() => void copy(tenantId, 'Tenant ID')} />
        <div>
          <button type="button" className="btn" disabled={busy} onClick={() => void run(async () => void (await call('entraApp.openPortal', { appId })))}>
            Open in Entra admin center
          </button>
        </div>
        {note && (
          <span className="faint text-[12px]" role="status">
            {note}
          </span>
        )}
      </div>

      {!result.ownerAdded && result.ownerMessage && (
        <span className="text-[12px] text-warn" role="alert">
          {result.ownerMessage}
        </span>
      )}
      {result.dropped.length > 0 && <span className="muted text-[12px]">{`Not in your tenant: ${result.dropped.join(', ')}`}</span>}

      {noPrincipal && (
        <div className="flex flex-col items-start gap-2" role="alert">
          <span className="text-[12.5px] text-warn">
            {`${appId} exists without its enterprise application. ${result.servicePrincipalMessage ?? 'The service principal could not be created.'}`}
          </span>
          <span className="muted text-[12px]">Kustodian doesn’t delete it for you. An admin’s consent (next step) also creates the enterprise application.</span>
          <div className="flex gap-2">
            <button type="button" className="btn primary" disabled={busy} onClick={() => void retry()}>
              Try again
            </button>
            <button type="button" className="btn" disabled={busy} onClick={() => void openPortal()}>
              Open in Entra
            </button>
          </div>
          {portalProblem && (
            <span className="text-[12px] text-bad" role="alert">
              {portalProblem}
            </span>
          )}
        </div>
      )}

      <div className="card flex flex-col gap-2.5 px-3.5 py-3">
        <div className="flex items-baseline gap-2">
          <b>1. Grant for the whole tenant</b>
          <span className="faint text-[12px]">optional</span>
        </div>
        {consentProblem && (
          <span className="text-[12.5px] text-bad" role="alert">
            {consentProblem}
          </span>
        )}
        {needsAdmin ? (
          <>
            <span className="muted text-[12.5px]">
              {`${adminScopes.length} of the ${listed} permissions need an admin’s consent. Until an admin grants them, signing in with this app will ask for admin approval. Microsoft’s page shows the admin exactly what is granted.`}
            </span>
            <div className="flex flex-wrap gap-2">
              <button ref={grantButton} type="button" className={`btn${openPrimary ? ' primary' : ''}`} disabled={busy} onClick={() => void openConsent()}>
                Open admin consent page
              </button>
              <button type="button" className={`btn${copyPrimary ? ' primary' : ''}`} disabled={busy} onClick={() => void copyLink()}>
                Copy link for an admin
              </button>
              <button type="button" className="btn" disabled={busy} onClick={() => void checkAgain()}>
                Check again
              </button>
            </div>
            {copyPrimary && <span className="muted text-[12px]">You can’t grant this yourself. Send the link to an admin, then click Check again.</span>}
            {status && (
              <span className={status.missing.length > 0 ? 'text-[12.5px] text-warn' : 'text-[12.5px] text-ok'} role="status">
                {`Granted for the tenant: ${grantedCount} of ${adminScopes.length}`}
                {status.missing.length > 0 ? ` · missing ${status.missing.join(', ')}` : ''}
              </span>
            )}
          </>
        ) : (
          <span className="muted text-[12.5px]">No permissions need an admin’s consent.</span>
        )}
        {problem && (
          <span className="text-[12px] text-bad" role="alert">
            {problem}
          </span>
        )}
      </div>

      <div className="card flex flex-col gap-2.5 px-3.5 py-3">
        <b>2. What now?</b>
        {switchProblem && (
          <span className="text-[12.5px] text-bad" role="alert">
            {switchProblem}
          </span>
        )}
        <div className="flex flex-wrap items-start gap-6">
          <Choice text="Saves it as your default client and tenant, then signs you in with it. Your Azure CLI sign-in stays in the account list.">
            <button type="button" className="btn primary" data-autofocus="" disabled={busy} onClick={() => void switchToApp()}>
              Switch and sign in
            </button>
          </Choice>
          <Choice text="Nothing is saved. Use it later under “My own app registration”.">
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => {
                onClientId?.({ name, appId, tenantId });
                onClose();
              }}
            >
              Just show me the client ID
            </button>
          </Choice>
        </div>
      </div>
    </div>
  );
}

function IdRow({ label, value, onCopy }: { label: string; value: string; onCopy: () => void }) {
  return (
    <div className="flex items-center gap-2.5 text-[12.5px]">
      <span className="muted w-[100px] shrink-0">{label}</span>
      <span className="mono">{value}</span>
      <button type="button" className="btn ghost" aria-label={`Copy ${label}`} onClick={onCopy}>
        Copy
      </button>
    </div>
  );
}

function Choice({ text, children }: { text: string; children: ReactNode }) {
  return (
    <div className="flex max-w-[320px] flex-col items-start gap-1.5">
      {children}
      <span className="muted text-[12px]">{text}</span>
    </div>
  );
}
