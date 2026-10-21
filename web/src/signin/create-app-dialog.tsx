import { useEffect, useMemo, useState } from 'react';
import { BridgeError, call, on } from '../bridge';
import { errorText } from '../shell/errors';
import type { EntraAppCreateResult, EntraAppPlan, EntraAppStep } from '../wire';
import { PermissionList } from './permission-list';
import { allPermissions, permKey } from './permission-plan';

const STEPS: { id: EntraAppStep; label: string }[] = [
  { id: 'lookUp', label: 'Looking up the permissions' },
  { id: 'createApp', label: 'Creating the app registration' },
  { id: 'addOwner', label: 'Adding you as owner' },
  { id: 'createServicePrincipal', label: 'Creating the service principal' },
];

type Phase = 'loading' | 'choose' | 'creating' | 'failed' | 'created';

/**
 * "Create Entra ID application" (spec 5.3, 5.4; mockup EntraApp): choose the permissions, name the app and create it.
 * Nothing is created until Create. While it runs the dialog can't be closed, so the request is never orphaned.
 * `onSwitched` fires once the user has signed in with the new app (Task 6's created view).
 */
export function CreateAppDialog({ onClose }: { onClose: () => void; onSwitched: () => void }) {
  const [phase, setPhase] = useState<Phase>('loading');
  const [plan, setPlan] = useState<EntraAppPlan | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const [typedName, setName] = useState<string | null>(null);
  const [step, setStep] = useState<EntraAppStep | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [result, setResult] = useState<EntraAppCreateResult | null>(null);

  const name = (typedName ?? plan?.defaultName ?? '').trim();
  const idle = phase !== 'creating';

  useEffect(() => {
    let live = true;
    call<EntraAppPlan>('entraApp.plan').then(
      (p) => {
        if (!live) {
          return;
        }
        setPlan(p);
        setTicked(new Set(allPermissions(p.groups).filter((x) => x.ticked).map(permKey)));
        setPhase('choose');
      },
      (e: unknown) => {
        if (live) {
          setPlanError(errorText(e));
        }
      },
    );
    const off = on('entraApp.step', (data) => {
      const id = (data as { step?: unknown } | null)?.step;
      if (STEPS.some((s) => s.id === id)) {
        setStep(id as EntraAppStep);
      }
    });
    return () => {
      live = false;
      off();
    };
  }, []);

  // Esc closes the dialog, but not while it is creating.
  useEffect(() => {
    if (!idle) {
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [idle, onClose]);

  const chosen = useMemo(() => (plan ? allPermissions(plan.groups).filter((p) => ticked.has(permKey(p))) : []), [plan, ticked]);
  const totals = useMemo(
    () => ({
      permissions: chosen.length,
      covered: new Set(chosen.flatMap((p) => p.tables)).size,
      admin: chosen.filter((p) => p.adminConsent).length,
    }),
    [chosen],
  );

  const toggle = (keys: string[], on: boolean) =>
    setTicked((current) => {
      const next = new Set(current);
      keys.forEach((k) => (on ? next.add(k) : next.delete(k)));
      return next;
    });

  const canCreate = plan?.canCreate === true && phase === 'choose' && name !== '' && chosen.length > 0;

  const create = () => {
    if (!canCreate) {
      return;
    }
    setPhase('creating');
    setStep(null);
    setProblem(null);
    call<EntraAppCreateResult>('entraApp.create', { name, permissions: chosen.map((p) => ({ resource: p.resource, name: p.name })) }).then(
      (r) => {
        setResult(r);
        setPhase('created');
      },
      (e: unknown) => {
        // An error means nothing was created (a partial creation comes back as a result), so the ticks stay.
        setProblem(e instanceof BridgeError && e.code === 'cancelled' ? 'The request was cancelled.' : errorText(e));
        setPhase('failed');
      },
    );
  };

  const stepAt = STEPS.findIndex((s) => s.id === step);
  const byResource = new Map<string, number>();
  chosen.forEach((p) => byResource.set(p.resource, (byResource.get(p.resource) ?? 0) + 1));

  return (
    <div className="fixed inset-0 z-10">
      <div className="scrim" data-testid="create-app-scrim" onClick={() => idle && onClose()} />
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Create Entra ID application"
        className="card absolute top-1/2 left-1/2 flex h-[min(790px,calc(100%-48px))] w-[min(1200px,calc(100%-48px))] -translate-x-1/2 -translate-y-1/2 flex-col"
      >
        <div className="flex flex-col gap-1 border-b border-line px-6 pt-5 pb-3.5">
          <h1 className="m-0 text-[18px] font-semibold">Create Entra ID application</h1>
          <span className="muted">The least set of read permissions that lets Kustodian query everything. Untick what you don’t want; nothing is created until you click Create.</span>
        </div>

        {planError !== null ? (
          <div className="flex flex-1 flex-col items-start gap-3 p-6">
            <span className="text-[12px] text-bad" role="alert">
              {planError}
            </span>
            <button type="button" className="btn" onClick={onClose}>
              Close
            </button>
          </div>
        ) : phase === 'loading' || plan === null ? (
          <div className="muted flex-1 p-6" role="status">
            Reading the permissions…
          </div>
        ) : phase === 'creating' || phase === 'failed' ? (
          <div className="flex flex-1 flex-col items-start gap-4 p-6">
            {phase === 'creating' ? (
              <ol className="m-0 flex list-none flex-col gap-2 p-0" role="status" aria-label="Progress">
                {STEPS.map((s, i) => (
                  <li key={s.id} aria-current={i === stepAt ? 'step' : undefined} className={i > stepAt ? 'faint' : i === stepAt ? 'font-semibold' : 'muted'}>
                    {i < stepAt ? '✓' : i === stepAt ? '…' : '○'} {s.label}
                  </li>
                ))}
              </ol>
            ) : (
              <>
                <span className="text-[13px] text-bad" role="alert">
                  {problem}
                </span>
                <span className="muted">Nothing was created.</span>
                <button type="button" className="btn primary" onClick={() => setPhase('choose')}>
                  Back to permissions
                </button>
              </>
            )}
          </div>
        ) : phase === 'created' && result !== null ? (
          <div className="flex flex-1 flex-col items-start gap-3 p-6">
            <b>{name} was created</b>
            <div className="flex gap-2.5 text-[12.5px]">
              <span className="muted w-[100px]">Client ID</span>
              <span className="mono">{result.appId}</span>
            </div>
            {result.servicePrincipalId === null && (
              <span className="text-[12px] text-warn" role="alert">
                {result.servicePrincipalMessage ?? 'The service principal could not be created.'}
              </span>
            )}
            <button type="button" className="btn" onClick={onClose}>
              Close
            </button>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1">
            <div className="flex min-w-0 flex-1 flex-col border-r border-line">
              <div className="flex-1 overflow-auto px-4 py-2">
                {!plan.canCreate && plan.reason && (
                  <div className="mb-2 text-[12px] text-warn" role="alert">
                    {plan.reason}
                  </div>
                )}
                <PermissionList groups={plan.groups} ticked={ticked} onToggle={toggle} />
              </div>
              <div className="flex flex-col gap-0.5 border-t border-line bg-panel2 px-4 py-2.5">
                <b className="text-[12.5px]">
                  {`${totals.permissions} permissions · ${totals.covered} of ${plan.tablesWithData} tables · ${totals.admin} need admin consent`}
                </b>
                <span className="faint text-[12px]">
                  {`${plan.tablesWithoutData} more tables have no published delegated permission; ${plan.writeOnlyTables} are reachable only with write permissions, which Kustodian doesn’t ask for.`}
                </span>
              </div>
            </div>

            <div className="flex w-[400px] shrink-0 flex-col gap-3.5 overflow-auto px-5 py-[18px]">
              <div className="field">
                <label htmlFor="entra-app-name">Name</label>
                <input id="entra-app-name" className="textbox" value={typedName ?? plan.defaultName} onChange={(e) => setName(e.target.value)} />
              </div>
              <b className="text-[13px]">What will be created</b>
              <div className="card flex flex-col gap-2 bg-panel2 px-3.5 py-3">
                <b>App registration</b>
                <Row label="Who can sign in">{plan.tenantName ? `Only ${plan.tenantName}` : 'Only your tenant'}</Row>
                <Row label="Type">Public client (desktop)</Row>
                <Row label="Public client flows">On (device code)</Row>
                <Row label="Owner">you</Row>
              </div>
              <div className="card flex flex-col gap-2 bg-panel2 px-3.5 py-3">
                <b>Service principal</b>
                <span className="muted text-[12px]">The app’s enterprise application{plan.tenantName ? ` in ${plan.tenantName}` : ''}, so it can be consented to and signed in to.</span>
              </div>
              <div className="card flex flex-col gap-2 bg-panel2 px-3.5 py-3">
                <b>API permissions (delegated)</b>
                {[...byResource].map(([resource, n]) => (
                  <Row key={resource} label={resource}>
                    {n}
                  </Row>
                ))}
                <span className="muted text-[12px]">Listed on the app only. Nothing is granted until someone consents.</span>
              </div>
              <div className="grow" />
              <div className="flex justify-end gap-2">
                <button type="button" className="btn" onClick={onClose}>
                  Cancel
                </button>
                <button type="button" className="btn primary" disabled={!canCreate} onClick={create}>
                  Create
                </button>
              </div>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2.5 text-[12.5px]">
      <span className="muted w-[132px] shrink-0">{label}</span>
      <span>{children}</span>
    </div>
  );
}
