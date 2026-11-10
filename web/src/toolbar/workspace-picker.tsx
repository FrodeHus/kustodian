import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { BridgeError, call } from '../bridge';
import { ErrorReportActions } from '../shell/error-report';
import { reportIdOf } from '../shell/report-id';
import { errorText } from '../shell/errors';
import { ConsentButton } from '../signin/consent-button';
import type { ArmSubscriptionsAnswer, ArmWorkspace, ArmWorkspacesAnswer, QueryWorkspace } from '../wire';

const PRIMARY = 'Primary workspace';

/** Why the list couldn't be read, and what helps: granting Azure access, signing in again, or nothing the picker can offer. */
interface Problem {
  text: string;
  reportId?: string;
  fix: 'consent' | 'signIn' | null;
}

const problemOf = (e: unknown): Problem => ({
  text: errorText(e),
  reportId: reportIdOf(e),
  fix: e instanceof BridgeError && e.code === 'consentNeeded' ? 'consent' : e instanceof BridgeError && e.code === 'signInNeeded' ? 'signIn' : null,
});

/** What the picker read: the workspaces (or why not) and the subscription names that label them. */
interface Read {
  workspaces?: ArmWorkspace[];
  problem?: Problem;
  names: Map<string, string>;
}

interface WorkspacePickerProps {
  /** The tab's workspace: none is the primary workspace; else exactly one. */
  workspaces: QueryWorkspace[] | null | undefined;
  onChange: (workspaces: QueryWorkspace[] | null) => void;
  /** The active account, which "Grant Azure access" asks consent for. */
  accountKey: string | null;
  /** Opens sign-in, when the list needs the account to sign in again. */
  onSignIn: () => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** What the no-workspace entry is called. */
  primaryLabel?: string;
}

/**
 * The advanced hunting tab's workspace (mockup: HuntingWorkspace): the primary workspace, or one Log Analytics workspace the
 * account can see. The trigger says which; a saved workspace the list lacks says "not available" once the list has been read.
 * The list is read from ARM each time the picker opens (never before: spec 6.7), with the same consent and sign-in help as the
 * scope picker. It closes on a click outside it, Esc or a pick, never on blur (macOS WebKit doesn't focus a clicked button).
 */
export function WorkspacePicker({ workspaces, onChange, accountKey, onSignIn, open, onOpenChange, primaryLabel = PRIMARY }: WorkspacePickerProps) {
  const ref = useRef<HTMLDivElement>(null);
  const chosen = workspaces?.[0];
  /** The workspaces last read, kept after the picker closes so the trigger can tell a saved one is gone. */
  const [known, setKnown] = useState<ArmWorkspace[] | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onDown = (e: MouseEvent) => {
      if (!(e.target instanceof Node) || !ref.current?.contains(e.target)) {
        onOpenChange(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onOpenChange(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onOpenChange]);

  const missing = chosen !== undefined && known !== null && !known.some((w) => w.customerId === chosen.customerId);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        className="btn whitespace-nowrap"
        aria-haspopup="dialog"
        aria-expanded={open}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => onOpenChange(!open)}
      >
        Workspace: {chosen ? chosen.name : primaryLabel}
        {missing && ' · not available'} <span aria-hidden="true">▾</span>
      </button>
      {open && (
        <WorkspaceDialog
          chosen={chosen}
          primaryLabel={primaryLabel}
          accountKey={accountKey}
          onSignIn={onSignIn}
          onRead={setKnown}
          onPick={(w) => {
            onChange(w ? [{ customerId: w.customerId, name: w.name, resourceId: w.resourceId }] : null);
            onOpenChange(false);
          }}
        />
      )}
    </div>
  );
}

interface WorkspaceDialogProps {
  chosen: QueryWorkspace | undefined;
  primaryLabel: string;
  accountKey: string | null;
  onSignIn: () => void;
  onRead: (workspaces: ArmWorkspace[] | null) => void;
  onPick: (workspace: ArmWorkspace | null) => void;
}

/** The open picker: mounted each time it opens, so it reads the list afresh. */
function WorkspaceDialog({ chosen, primaryLabel, accountKey, onSignIn, onRead, onPick }: WorkspaceDialogProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [search, setSearch] = useState('');
  const [read, setRead] = useState<Read | null>(null);
  /** Counts reads: only the latest one's answer is shown. */
  const reads = useRef(0);

  const load = useCallback(() => {
    const n = ++reads.current;
    void Promise.allSettled([call<ArmWorkspacesAnswer>('arm.workspaces'), call<ArmSubscriptionsAnswer>('arm.subscriptions')]).then(([ws, subs]) => {
      if (n !== reads.current) {
        return;
      }
      // Without the subscriptions list a workspace's subscription shows by its id.
      const names = new Map(subs.status === 'fulfilled' ? subs.value.subscriptions.map((s) => [s.id, s.name]) : []);
      const list = ws.status === 'fulfilled' ? ws.value.workspaces : undefined;
      setRead({ workspaces: list, problem: ws.status === 'rejected' ? problemOf(ws.reason) : undefined, names });
      onRead(list ?? null);
    });
  }, [onRead]);

  useEffect(() => {
    load();
    ref.current?.querySelector<HTMLInputElement>('input[type="radio"]:checked')?.focus();
  }, [load]);

  // A mousedown doesn't move focus, so a click lands even where WebKit wouldn't focus what was clicked; the search still takes it.
  const keepFocus = (e: ReactMouseEvent) => {
    if (!(e.target instanceof HTMLInputElement && e.target.type === 'search')) {
      e.preventDefault();
    }
  };

  const needle = search.trim().toLowerCase();
  const all = read?.workspaces ?? [];
  const shown = all.filter((w) => !needle || w.name.toLowerCase().includes(needle) || w.resourceGroup.toLowerCase().includes(needle));
  const problem = read?.problem;

  return (
    <div ref={ref} className="menu" role="dialog" aria-label="Workspace" style={{ left: 0, top: 36, width: 460, padding: 12, gap: 8 }} onMouseDown={keepFocus}>
      <input
        className="search !m-0 !w-full"
        type="search"
        aria-label="Find a workspace"
        placeholder={`Find among ${all.length} workspaces`}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      <div className="max-h-[300px] overflow-y-auto">
        <label className="flex min-h-[44px] items-center gap-2.5 px-1.5">
          <input type="radio" name="workspace" checked={!chosen} onChange={() => onPick(null)} />
          <span className="flex flex-col">
            <span>{primaryLabel}</span>
            <span className="faint text-[11.5px]">Default. Defender&apos;s tables, plus your primary Sentinel workspace if one is connected.</span>
          </span>
        </label>
        <div className="my-1 h-px bg-line" />
        {shown.map((w) => (
          <label key={w.customerId} className="flex min-h-[44px] items-center gap-2.5 px-1.5">
            <input type="radio" name="workspace" checked={chosen?.customerId === w.customerId} onChange={() => onPick(w)} />
            <span className="flex min-w-0 flex-col">
              <span className="truncate">{w.name}</span>
              <span className="faint truncate text-[11.5px]">
                {w.resourceGroup} · {read?.names.get(w.subscriptionId) ?? w.subscriptionId} · {w.location}
              </span>
            </span>
          </label>
        ))}
        {!read && <span className="faint text-[12px]">Reading the list from Azure…</span>}
        {read?.workspaces && shown.length === 0 && <span className="faint text-[12px]">{needle ? 'No workspace matches.' : 'No workspaces to pick.'}</span>}
      </div>
      {problem && (
        <div className="flex flex-wrap items-center gap-2 text-[12px]">
          <span role="alert" className="min-w-0 text-bad">
            {problem.text}
          </span>
          <ErrorReportActions reportId={problem.reportId} uiSections={{ message: problem.text }} />
          {problem.fix === 'signIn' && (
            <button type="button" className="btn primary shrink-0" onClick={onSignIn}>
              Sign in
            </button>
          )}
          {problem.fix === 'consent' && (
            <ConsentButton
              accountKey={accountKey ?? undefined}
              onGranted={() => {
                // Read again, now that Azure access is granted.
                setRead(null);
                load();
              }}
            />
          )}
        </div>
      )}
      <span className="faint text-[12px]">
        Defender reaches a workspace&apos;s tables when it&apos;s onboarded to the Defender portal and you have Microsoft Sentinel Reader on it. The workspace is
        saved with the query.
      </span>
    </div>
  );
}
