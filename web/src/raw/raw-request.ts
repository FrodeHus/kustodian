import { create } from 'zustand';
import { useTabs, type Tab } from '../tabs/tab-store';
import type { ParameterDef, RawResponse } from '../wire';

export const RAW_VERSIONS = ['beta', 'v1.0'] as const;

/** A request header as the headers editor holds it. */
export interface RawHeader {
  name: string;
  value: string;
}

// The session keeps a tab's id, title, text and parameters, and the host drops fields it doesn't know. A raw tab's text is its
// path; its version and headers go in its parameters, which a raw tab has no other use for, as entries of these types.
const VERSION_TYPE = 'raw-version';
const HEADER_TYPE = 'raw-header';

/** A raw tab's request as its parameters keep it: the version it was last sent with or set to (none: the settings' default),
 * and its headers in order. */
export function rawRequest(tab: Pick<Tab, 'parameters'>): { version?: string; headers: RawHeader[] } {
  const version = tab.parameters.find((p) => p.type === VERSION_TYPE)?.value;
  return {
    version: version && (RAW_VERSIONS as readonly string[]).includes(version) ? version : undefined,
    headers: tab.parameters.filter((p) => p.type === HEADER_TYPE).map((p) => ({ name: p.name, value: p.value })),
  };
}

/** A raw tab's version and headers as its parameters keep them. */
export function requestParameters(version: string | undefined, headers: RawHeader[]): ParameterDef[] {
  return [
    ...(version ? [{ name: 'version', type: VERSION_TYPE, value: version, required: false }] : []),
    ...headers.map((h) => ({ name: h.name, type: HEADER_TYPE, value: h.value, required: false })),
  ];
}

/** Opens a raw Graph request tab, numbered after the raw tabs already open, with `path` and `version` when given. */
export function openRaw(seed: { path?: string; version?: string } = {}): string {
  const used = new Set(useTabs.getState().tabs.map((t) => t.title));
  let n = 1;
  while (used.has(`Raw request ${n}`)) {
    n++;
  }
  return useTabs.getState().openWith({ source: 'raw', title: `Raw request ${n}`, text: seed.path ?? '', parameters: requestParameters(seed.version, []) });
}

export interface RawState {
  /** The pages of the last request, the first from `raw.send` and the rest from `raw.next`. */
  pages: RawResponse[];
  /** The account active when the first page was sent: a next page with another account would mix tenants. */
  accountKey: string | undefined;
  sending: boolean;
  error: { code: string; message: string } | null;
}

export const IDLE: RawState = { pages: [], accountKey: undefined, sending: false, error: null };

/** Each raw tab's last response, kept while the window is open (never in the session) so switching tabs keeps it. */
export const useRawResponses = create<{ responses: Record<string, RawState> }>()(() => ({ responses: {} }));

/** Changes a raw tab's response state; the states of tabs that were closed go. */
export function updateRaw(id: string, change: Partial<RawState>) {
  const open = new Set(useTabs.getState().tabs.map((t) => t.id));
  useRawResponses.setState((s) => {
    const responses = Object.fromEntries(Object.entries(s.responses).filter(([key]) => open.has(key)));
    responses[id] = { ...(s.responses[id] ?? IDLE), ...change };
    return { responses };
  });
}
