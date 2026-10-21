import { useEffect, useRef, useState } from 'react';
import type { PlannedGroup, PlannedPermission } from '../wire';
import { lostTables, permKey } from './permission-plan';

const SHOWN_TABLES = 5;

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** A checkbox that is mixed (neither ticked nor unticked) when only some of what it stands for is ticked. */
function TriBox({ label, ticked, total, onChange }: { label: string; ticked: number; total: number; onChange: (on: boolean) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const all = total > 0 && ticked === total;
  useEffect(() => {
    if (ref.current) {
      ref.current.indeterminate = ticked > 0 && ticked < total;
    }
  }, [ticked, total]);
  return <input ref={ref} type="checkbox" aria-label={label} checked={all} onChange={() => onChange(!all)} className="mt-0.5 accent-accent" />;
}

function countTicked(perms: PlannedPermission[], ticked: ReadonlySet<string>): number {
  return perms.filter((p) => ticked.has(permKey(p))).length;
}

function tableCount(perms: PlannedPermission[]): number {
  return new Set(perms.flatMap((p) => p.tables)).size;
}

function Row({ permission, groups, ticked, onToggle }: { permission: PlannedPermission; groups: PlannedGroup[]; ticked: ReadonlySet<string>; onToggle: PermissionListProps['onToggle'] }) {
  const [expanded, setExpanded] = useState(false);
  const on = ticked.has(permKey(permission));
  const lost = on ? [] : lostTables(permission, groups, ticked);
  const tables = permission.tables;
  const shown = expanded ? tables : tables.slice(0, SHOWN_TABLES);

  return (
    <div className="flex items-start gap-2.5 rounded-[7px] py-[7px] pr-2 pl-[30px] hover:bg-raise">
      <input type="checkbox" aria-label={permission.name} checked={on} onChange={() => onToggle([permKey(permission)], !on)} className="mt-0.5 accent-accent" />
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="flex items-center gap-1.5">
          <span className="mono text-[12px]">{permission.name}</span>
          {permission.adminConsent && <span className="tag warn">Admin</span>}
        </span>
        {permission.description !== '' && <span className="muted text-[12px]">{permission.description}</span>}
        {tables.length > 0 ? (
          <span className="faint text-[12px]">
            {plural(tables.length, 'table', 'tables')}: {shown.join(', ')}
            {tables.length > SHOWN_TABLES && !expanded && (
              <>
                {' … '}
                <button type="button" className="text-accent underline" onClick={() => setExpanded(true)}>
                  show all
                </button>
              </>
            )}
          </span>
        ) : (
          permission.unlocks !== null && (
            <span className="faint text-[12px]">
              Unlocks <span>{permission.unlocks}</span>
            </span>
          )
        )}
        {lost.length > 0 && (
          <span className="text-[12px] text-warn">
            You lose {plural(lost.length, 'table', 'tables')}: {lost.join(', ')}
          </span>
        )}
      </div>
    </div>
  );
}

export interface PermissionListProps {
  groups: PlannedGroup[];
  /** The ticked permissions, by {@link permKey}. */
  ticked: ReadonlySet<string>;
  /** Ticks (`on`) or unticks the permissions with these keys. */
  onToggle: (keys: string[], on: boolean) => void;
}

/** Groups, then subgroups, then permissions, each group and subgroup with a tri-state checkbox (mockup EntraApp). */
export function PermissionList({ groups, ticked, onToggle }: PermissionListProps) {
  const keys = (perms: PlannedPermission[]) => perms.map(permKey);
  return (
    <div className="flex flex-col">
      {groups.map((g) => {
        const perms = g.subgroups.flatMap((s) => s.permissions);
        return (
          <div key={g.id} className="flex flex-col gap-1">
            <div className="muted flex items-center gap-2.5 pt-2.5 pb-1.5 pl-1 text-[11px] font-semibold tracking-[.08em] uppercase">
              <TriBox label={g.title} ticked={countTicked(perms, ticked)} total={perms.length} onChange={(on) => onToggle(keys(perms), on)} />
              {g.title}
              <span className="faint ml-auto text-[12px] font-normal tracking-normal normal-case">
                {countTicked(perms, ticked)} of {plural(perms.length, 'permission', 'permissions')} · {plural(tableCount(perms), 'table', 'tables')}
              </span>
            </div>
            {g.subgroups.map((s) => (
              <div key={s.title} className="flex flex-col">
                <div className="flex items-center gap-2.5 rounded-[7px] bg-panel2 px-2 py-2 font-semibold">
                  <TriBox label={s.title} ticked={countTicked(s.permissions, ticked)} total={s.permissions.length} onChange={(on) => onToggle(keys(s.permissions), on)} />
                  {s.title}
                  <span className="faint ml-auto text-[12px] font-normal">
                    {countTicked(s.permissions, ticked)} of {plural(s.permissions.length, 'permission', 'permissions')}
                  </span>
                </div>
                {s.permissions.map((p) => (
                  <Row key={permKey(p)} permission={p} groups={groups} ticked={ticked} onToggle={onToggle} />
                ))}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}
