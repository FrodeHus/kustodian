import { create } from 'zustand';
import { useTabs, type Tab } from '../tabs/tab-store';
import type { RawResponse, RawTabHeader, RawTabRequest } from '../wire';

export const RAW_VERSIONS = ['beta', 'v1.0'] as const;

/** The raw tab's limits on headers, as the host has them (`RawRequestService`). */
export const MAX_HEADERS = 20;
export const MAX_HEADER_BYTES = 8 * 1024;

const REFUSED_HEADERS = new Set(['authorization', 'host', 'cookie', 'accept-encoding']);
const TOKEN = /^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/;
const PRINTABLE = /^[\t\x20-\x7e]*$/;

/** Why the host would refuse to send a header, in its words (`RawRequestService.HeaderProblem`), or null when it would send it. */
export function headerProblem(name: string, value: string): string | null {
  if (!TOKEN.test(name)) {
    return "A header name can only have letters, digits and !#$%&'*+-.^_`|~.";
  }
  if (REFUSED_HEADERS.has(name.toLowerCase())) {
    return `The ${name} header can't be set from the raw tab.`;
  }
  return PRINTABLE.test(value) ? null : `The ${name} header's value can only have printable ASCII characters.`;
}

/** The headers the raw tab could send, in order, within the host's caps: what the session keeps. */
export function sendableHeaders(headers: RawTabHeader[]): RawTabHeader[] {
  const kept: RawTabHeader[] = [];
  let total = 0;
  for (const h of headers) {
    if (kept.length === MAX_HEADERS) {
      break;
    }
    if (headerProblem(h.name, h.value) === null && total + h.name.length + h.value.length <= MAX_HEADER_BYTES) {
      total += h.name.length + h.value.length;
      kept.push(h);
    }
  }
  return kept;
}

/** A raw tab's request: its version (none: the settings' default) and its headers in order. */
export function rawRequest(tab: Pick<Tab, 'raw'>): RawTabRequest {
  return tab.raw ?? { version: null, headers: [] };
}

/** Opens a raw Graph request tab, numbered after the raw tabs already open, with `path` and `version` when given. */
export function openRaw(seed: { path?: string; version?: string } = {}): string {
  const used = new Set(useTabs.getState().tabs.map((t) => t.title));
  let n = 1;
  while (used.has(`Raw request ${n}`)) {
    n++;
  }
  return useTabs.getState().openWith({ source: 'raw', title: `Raw request ${n}`, text: seed.path ?? '', raw: { version: seed.version ?? null, headers: [] } });
}

export interface RawState {
  /** The pages of the last request, the first from `raw.send` and the rest from `raw.next`. */
  pages: RawResponse[];
  /** The account active when the first page was sent: a next page with another account would mix tenants. */
  accountKey: string | undefined;
  sending: boolean;
  /** The last request's error, and the control it is about: a refusal shows beside it. */
  error: { code: string; message: string; about: 'path' | 'version' | 'headers' | 'next' } | null;
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
