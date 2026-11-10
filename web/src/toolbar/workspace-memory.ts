import type { QueryWorkspace } from '../wire';

const key = (accountKey: string) => `kustodian.logsWorkspace.${accountKey}`;

/** The account a new `logs` tab asks for its remembered workspace: set by the app when the active account changes. */
let activeAccount: string | null = null;
export const setMemoryAccount = (accountKey: string | null) => {
  activeAccount = accountKey;
};
export const memoryAccount = () => activeAccount;

const isWorkspace = (w: unknown): w is QueryWorkspace =>
  typeof w === 'object' &&
  w !== null &&
  'customerId' in w &&
  typeof w.customerId === 'string' &&
  'name' in w &&
  typeof w.name === 'string' &&
  'resourceId' in w &&
  typeof w.resourceId === 'string';

/** The workspace last picked on a `logs` tab for the account, or null (none, or a value that doesn't read). A per-viewer
 * convenience: a lost value only means picking again. */
export function rememberedLogsWorkspace(accountKey: string): QueryWorkspace[] | null {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(key(accountKey)) ?? 'null');
    return Array.isArray(parsed) && parsed.length === 1 && parsed.every(isWorkspace) ? parsed : null;
  } catch {
    return null;
  }
}

export function rememberLogsWorkspace(accountKey: string, workspaces: QueryWorkspace[] | null): void {
  try {
    if (workspaces?.length) {
      localStorage.setItem(key(accountKey), JSON.stringify(workspaces));
    } else {
      localStorage.removeItem(key(accountKey));
    }
  } catch {
    // Storage may be blocked; the pick still holds for the tab.
  }
}
