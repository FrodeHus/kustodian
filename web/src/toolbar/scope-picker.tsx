import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { BridgeError, call } from '../bridge';
import { scopeText } from '../results/source-wording';
import { errorText } from '../shell/errors';
import { ConsentButton } from '../signin/consent-button';
import type { ArgScope, ArmManagementGroupsAnswer, ArmSubscription, ArmSubscriptionsAnswer } from '../wire';

/** The host takes at most this many subscriptions in a scope. */
const MAX_SUBSCRIPTIONS = 100;

const ALL: ArgScope = { kind: 'all', ids: [] };

const KINDS: { kind: ArgScope['kind']; label: string }[] = [
  { kind: 'subscriptions', label: 'Subscriptions' },
  { kind: 'managementGroup', label: 'Management group' },
  { kind: 'all', label: 'All I can see' },
];

/** A subscription id as the list shows it: its first and last four characters. */
const shortId = (id: string) => (id.length > 12 ? `${id.slice(0, 4)}…${id.slice(-4)}` : id);

interface Lists {
  subscriptions?: ArmSubscription[];
  groups?: ArmManagementGroupsAnswer;
  /** Why a list couldn't be read; `consent` when Azure access needs granting first. */
  problem?: { text: string; consent: boolean };
}

interface ScopePickerProps {
  /** The tab's scope; none is "all I can see". */
  scope: ArgScope | null | undefined;
  onChange: (scope: ArgScope) => void;
  /** The active account, which "Grant Azure access" asks consent for. */
  accountKey: string | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * The Resource Graph tab's scope (mockup: ResourceGraph; spec 8.2): subscriptions (several, with a search), one management group,
 * or "all I can see". The trigger says which: "Scope: 3 subscriptions", "Scope: {group}" or "Scope: all I can see". The lists are
 * read from ARM each time the picker opens (never before: spec 6.7); when Azure access needs granting, it offers "Grant Azure
 * access" and reads them again after. The picker closes on a click outside it or Esc, never on blur (macOS WebKit doesn't focus
 * a clicked button), and a mousedown in it doesn't move focus, except into the search.
 */
export function ScopePicker({ scope, onChange, accountKey, open, onOpenChange }: ScopePickerProps) {
  const ref = useRef<HTMLDivElement>(null);

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
        Scope: {scopeText(scope)} <span aria-hidden="true">▾</span>
      </button>
      {open && <ScopeDialog scope={scope ?? ALL} onChange={onChange} accountKey={accountKey} />}
    </div>
  );
}

/** The open picker: mounted each time it opens, so it starts on the tab's kind and reads the lists afresh. */
function ScopeDialog({ scope, onChange, accountKey }: { scope: ArgScope; onChange: (scope: ArgScope) => void; accountKey: string | undefined }) {
  const ref = useRef<HTMLDivElement>(null);
  /** The kind shown; choosing Subscriptions or Management group changes the scope only once one is picked. */
  const [kind, setKind] = useState<ArgScope['kind']>(scope.kind);
  const [search, setSearch] = useState('');
  const [lists, setLists] = useState<Lists | null>(null);
  /** Counts reads: only the latest one's answer is shown. */
  const reads = useRef(0);

  const load = useCallback(() => {
    const read = ++reads.current;
    void Promise.allSettled([call<ArmSubscriptionsAnswer>('arm.subscriptions'), call<ArmManagementGroupsAnswer>('arm.managementGroups')]).then(
      ([subscriptions, groups]) => {
        if (read !== reads.current) {
          return;
        }
        const failure = [subscriptions, groups].flatMap((r) => (r.status === 'rejected' ? [r.reason as unknown] : []));
        const consent = failure.find((e) => e instanceof BridgeError && e.code === 'consentNeeded');
        const first = consent ?? failure[0];
        setLists({
          subscriptions: subscriptions.status === 'fulfilled' ? subscriptions.value.subscriptions : undefined,
          groups: groups.status === 'fulfilled' ? groups.value : undefined,
          problem: first === undefined ? undefined : { text: errorText(first), consent: consent !== undefined },
        });
      },
    );
  }, []);

  useEffect(() => {
    load();
    ref.current?.querySelector<HTMLButtonElement>('[role="radio"][aria-checked="true"]')?.focus();
  }, [load]);

  // A mousedown doesn't move focus, so a click lands even where WebKit wouldn't focus what was clicked; the search still takes it.
  const keepFocus = (e: ReactMouseEvent) => {
    if (!(e.target instanceof HTMLInputElement && e.target.type === 'search')) {
      e.preventDefault();
    }
  };

  const chooseKind = (next: ArgScope['kind']) => {
    setKind(next);
    if (next === 'all') {
      onChange(ALL);
    }
  };

  const chosen = scope.kind === 'subscriptions' ? scope.ids : [];
  const toggle = (id: string, on: boolean) => {
    const ids = on ? [...chosen, id] : chosen.filter((c) => c !== id);
    // No subscription left: the scope is everything the account can see, as the trigger then says.
    onChange(ids.length > 0 ? { kind: 'subscriptions', ids } : ALL);
  };

  const needle = search.trim().toLowerCase();
  const subscriptions = lists?.subscriptions ?? [];
  const shown = subscriptions.filter((s) => !needle || s.name.toLowerCase().includes(needle) || s.id.toLowerCase().includes(needle));
  const full = chosen.length >= MAX_SUBSCRIPTIONS;

  return (
    <div ref={ref} className="menu" role="dialog" aria-label="Query scope" style={{ left: 0, top: 36, width: 420, padding: 12, gap: 8 }} onMouseDown={keepFocus}>
      <div role="radiogroup" aria-label="Scope kind" className="flex gap-1.5">
        {KINDS.map((k) => (
          <button
            key={k.kind}
            type="button"
            role="radio"
            aria-checked={kind === k.kind}
            className={`h-[30px] flex-1 whitespace-nowrap !justify-center !px-2${kind === k.kind ? ' on' : ''}`}
            onClick={() => chooseKind(k.kind)}
          >
            {k.label}
          </button>
        ))}
      </div>
      {lists?.problem && kind !== 'all' && (
        <div className="flex flex-wrap items-center gap-2 text-[12px]">
          <span role="alert" className="min-w-0 text-bad">
            {lists.problem.text}
          </span>
          {lists.problem.consent && (
            <ConsentButton
              accountKey={accountKey}
              onGranted={() => {
                // Read again, now that Azure access is granted.
                setLists(null);
                load();
              }}
            />
          )}
        </div>
      )}
      {!lists && kind !== 'all' && <span className="faint text-[12px]">Reading the list from Azure…</span>}
      {kind === 'subscriptions' && lists?.subscriptions && (
        <>
          <input
            className="search !m-0 !w-full"
            type="search"
            aria-label="Find a subscription"
            placeholder={`Find among ${subscriptions.length} subscriptions`}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="max-h-[260px] overflow-y-auto">
            {shown.map((s) => {
              const on = chosen.includes(s.id);
              return (
                <label key={s.id} className="flex h-[30px] items-center gap-2.5 px-1.5">
                  <input type="checkbox" aria-label={s.name} checked={on} disabled={!on && full} onChange={(e) => toggle(s.id, e.target.checked)} />
                  <span className="truncate">{s.name}</span>
                  <span className="mono faint ml-auto text-[11px]" title={s.id}>
                    {shortId(s.id)}
                  </span>
                </label>
              );
            })}
            {shown.length === 0 && <span className="faint text-[12px]">{needle ? 'No subscription matches.' : 'No subscriptions to pick.'}</span>}
          </div>
          {full && <span className="text-[12px] text-warn">A scope takes at most {MAX_SUBSCRIPTIONS} subscriptions.</span>}
        </>
      )}
      {kind === 'managementGroup' && lists?.groups && (
        <div className="max-h-[260px] overflow-y-auto">
          {lists.groups.groups.map((g) => (
            <label key={g.name} className="flex h-[30px] items-center gap-2.5 px-1.5">
              <input
                type="radio"
                name="scope-group"
                aria-label={`${g.displayName} (${g.name})`}
                checked={scope.kind === 'managementGroup' && scope.ids[0] === g.name}
                onChange={() => onChange({ kind: 'managementGroup', ids: [g.name] })}
              />
              <span className="truncate">{g.displayName}</span>
              <span className="mono faint ml-auto text-[11px]">{g.name}</span>
            </label>
          ))}
          {lists.groups.groups.length === 0 && !lists.groups.note && <span className="faint text-[12px]">No management groups to pick.</span>}
        </div>
      )}
      {kind === 'managementGroup' && lists?.groups?.note && <span className="text-[12px] text-warn">{lists.groups.note}</span>}
      {kind === 'all' && <span className="faint text-[12px]">Every subscription the account can read.</span>}
      <span className="faint text-[12px]">The scope is saved with the query.</span>
    </div>
  );
}
