import { BridgeError } from '../bridge';
import { AZURE_CLI_CLIENT_ID, type AccountInfo, type PlannedGroup, type PlannedPermission } from '../wire';

/** "Create Entra ID application" is offered for the Azure CLI client with a token that hasn't expired (spec 6.1). */
export const canOfferCreateApp = (account: AccountInfo | undefined): boolean =>
  account !== undefined && !account.expired && account.clientId.toLowerCase() === AZURE_CLI_CLIENT_ID;

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

/** The scopes that let a token create app registrations and their service principals (spec 6.1). */
const CREATE_SCOPES = ['application.readwrite.all', 'directory.accessasuser.all'];

/** The command and the run status offer the dialog only when the sign-in can also create: Azure CLI, not expired, and a token
 * with one of the create scopes. */
export const canCreateApp = (account: AccountInfo | undefined): boolean =>
  canOfferCreateApp(account) && (account?.scopes ?? []).some((s) => CREATE_SCOPES.includes(s.toLowerCase()));

/** The host answered `signInNeeded`: the sign-in expired or is missing, so nothing more can be asked of it. */
export const isSignInNeeded = (e: unknown): boolean => e instanceof BridgeError && e.code === 'signInNeeded';
