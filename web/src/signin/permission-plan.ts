import type { PlannedGroup, PlannedPermission } from '../wire';

/** A permission's identity: its resource and name (a name alone repeats across resources). */
export const permKey = (p: Pick<PlannedPermission, 'resource' | 'name'>): string => `${p.resource}|${p.name}`;

/** The tables only `permission` covers among the ticked permissions: what unticking it loses. Like the host's
 * `PermissionPlanner.LostTables`. A table another ticked permission also covers is not lost. */
export function lostTables(permission: PlannedPermission, groups: PlannedGroup[], ticked: ReadonlySet<string>): string[] {
  const covered = new Set<string>();
  for (const other of allPermissions(groups)) {
    if (permKey(other) !== permKey(permission) && ticked.has(permKey(other))) {
      other.tables.forEach((t) => covered.add(t));
    }
  }
  return permission.tables.filter((t) => !covered.has(t));
}

export function allPermissions(groups: PlannedGroup[]): PlannedPermission[] {
  return groups.flatMap((g) => g.subgroups.flatMap((s) => s.permissions));
}
