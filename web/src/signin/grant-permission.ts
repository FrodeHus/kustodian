import type { AccountInfo } from '../wire';

/** Whether the permission only reads: `.Read` in its name and no `Write`, in any casing (the host's rule). */
const isReadOnly = (permission: string) => /\.read/i.test(permission) && !/write/i.test(permission);

/**
 * What a refused run offers the user: `{ scope }` is the read-only permission to grant (the first listed); `{ held }` is the first listed
 * permission (of any kind) the account already has, so granting wouldn't help; `null` is no offer (no account, the Azure CLI whose client
 * can't be granted anything, a Resource Graph or raw run, or no read-only permission listed).
 */
export function grantOffer(account: AccountInfo | undefined, permissions: string[], source: string): { scope: string } | { held: string } | null {
  if (!account || account.clientKind === 'azureCli' || (source !== 'graph' && source !== 'hunting')) {
    return null;
  }
  const held = new Set(account.scopes.map((s) => s.toLowerCase()));
  const alreadyHeld = permissions.find((p) => held.has(p.toLowerCase()));
  if (alreadyHeld) {
    return { held: alreadyHeld };
  }
  const [scope] = permissions.filter(isReadOnly);
  return scope ? { scope } : null;
}
