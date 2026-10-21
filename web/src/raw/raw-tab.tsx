import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { BridgeError, call } from '../bridge';
import { copyFailed, copyText } from '../results/copy';
import { NoticeLine, type Notice } from '../results/result-grid';
import { errorText } from '../shell/errors';
import { MOD } from '../shell/keys';
import { useTabs, type Tab } from '../tabs/tab-store';
import type { RawResponse, SchemaView } from '../wire';
import { completePath } from './path-completion';
import { IDLE, RAW_VERSIONS, rawRequest, requestParameters, updateRaw, useRawResponses, type RawHeader } from './raw-request';
import { MAX_DATATABLE_ROWS, toDatatable } from './to-datatable';

const STATUS_TEXT: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  204: 'No Content',
  301: 'Moved Permanently',
  302: 'Found',
  304: 'Not Modified',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
};

function size(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** The path as the host takes it: relative to the version, so a leading slash is dropped. */
const sentPath = (text: string) => text.trim().replace(/^\//, '');

interface RawTabProps {
  tab: Tab;
  schema: SchemaView | null;
  /** The settings' default version, for a tab that has none of its own yet. */
  defaultVersion: string;
  /** The active account's key; none when no one is signed in. */
  accountKey: string | undefined;
  onSignIn: () => void;
}

/**
 * The raw Graph request tab (spec 6.9, mockup RawRequest): GET only, a version, a path relative to it with completion from the
 * schema, headers, and the response with its status, headers and body as foldable JSON, paged with `@odata.nextLink`. Any
 * array in the body opens as a KQL tab. Requests go through `raw.send` and `raw.next`, never `query.run` (ruling 1).
 */
export function RawTab({ tab, schema, defaultVersion, accountKey, onSignIn }: RawTabProps) {
  const state = useRawResponses((s) => s.responses[tab.id]) ?? IDLE;
  const request = rawRequest(tab);
  const version = request.version ?? defaultVersion;
  const [view, setView] = useState<'body' | 'headers'>('body');
  const [notice, setNotice] = useState<Notice | null>(null);

  const setRequest = (next: { version?: string; headers?: RawHeader[] }) =>
    useTabs.getState().setParameters(tab.id, requestParameters(next.version ?? request.version, next.headers ?? request.headers));

  const busy = () => useRawResponses.getState().responses[tab.id]?.sending ?? false;

  async function send() {
    // One request at a time per tab: Enter in the path can't send a second while the first is out.
    if (busy()) {
      return;
    }
    const path = sentPath(tab.text);
    const headers = Object.fromEntries(request.headers.filter((h) => h.name.trim() !== '').map((h) => [h.name.trim(), h.value]));
    updateRaw(tab.id, { sending: true, error: null });
    try {
      const response = await call<RawResponse>('raw.send', { version, path, headers });
      updateRaw(tab.id, { pages: [response], accountKey, sending: false });
      setRequest({ version });
      useTabs.getState().setTitle(tab.id, `GET /${path.split('?')[0] ?? ''}`);
    } catch (e) {
      updateRaw(tab.id, { sending: false, error: { code: e instanceof BridgeError ? e.code : 'failed', message: errorText(e) } });
    }
  }

  async function next() {
    const nextLink = state.pages.at(-1)?.nextLink;
    if (!nextLink || busy() || accountChanged) {
      return;
    }
    updateRaw(tab.id, { sending: true, error: null });
    try {
      const response = await call<RawResponse>('raw.next', { nextLink });
      const pages = useRawResponses.getState().responses[tab.id]?.pages ?? [];
      updateRaw(tab.id, { pages: [...pages, response], sending: false });
    } catch (e) {
      updateRaw(tab.id, { sending: false, error: { code: e instanceof BridgeError ? e.code : 'failed', message: errorText(e) } });
    }
  }

  const openArray = (label: string | null, array: unknown[]) => {
    const segment = sentPath(tab.text).split('?')[0]?.split('/').filter(Boolean).at(-1) ?? '';
    // Graph's collections are all `value`: the entity set names them better.
    const base = label && label !== 'value' && !/^\d+$/.test(label) ? label : segment || 'value';
    const name = `${base.replace(/[^A-Za-z0-9_]/g, '_')}_rows`;
    const { kql, truncated } = toDatatable(name, array);
    const text = truncated
      ? `// Only the first ${MAX_DATATABLE_ROWS.toLocaleString('en-US')} of ${array.length.toLocaleString('en-US')} rows are here.\n${kql}`
      : kql;
    useTabs.getState().openWith({ source: 'graph', title: name, text });
  };

  const error = state.error;
  const refusal = error?.code === 'bad_request' ? error.message : null;
  const headerError = refusal && /header/i.test(refusal) ? refusal : null;
  const pathError = refusal && !headerError ? refusal : null;
  const last = state.pages.at(-1);
  const accountChanged = state.pages.length > 0 && state.accountKey !== accountKey;
  // A body can be megabytes: measured once per page, not on every keystroke in the headers.
  const bytes = useMemo(() => (last ? new TextEncoder().encode(last.body).length : 0), [last]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="toolbar">
        <span className="mono faint text-[12px]" title="Raw requests are GET only">
          GET
        </span>
        <select
          className="textbox font-mono w-[84px]"
          aria-label="Version"
          value={version}
          onChange={(e) => setRequest({ version: e.target.value })}
        >
          {RAW_VERSIONS.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
        <PathInput
          tabId={tab.id}
          text={tab.text}
          schema={schema}
          invalid={pathError !== null}
          onSend={() => void send()}
        />
        <button type="button" className="btn primary" disabled={state.sending} onClick={() => void send()}>
          Send <span className="kbd">{MOD} Enter</span>
        </button>
      </div>
      {pathError && (
        <div className="border-b border-line bg-bad-soft px-3 py-1.5 text-[12px] text-bad" role="alert" id={`${tab.id}-path-error`}>
          {pathError}
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <HeadersEditor headers={request.headers} error={headerError} onChange={(headers) => setRequest({ headers })} />
        <section aria-label="Response" className="flex min-w-0 flex-1 flex-col">
          {last ? (
            <>
              <div className="rbar">
                <span className={`chip ${last.status >= 200 && last.status < 300 ? 'ok' : 'bad'}`}>
                  {STATUS_TEXT[last.status] ? `${last.status} ${STATUS_TEXT[last.status]}` : String(last.status)}
                </span>
                <span className="mono faint text-[12px] whitespace-nowrap">
                  {last.durationMs} ms · {size(bytes)}
                  {state.pages.length > 1 ? ` · ${state.pages.length} pages` : ''}
                </span>
                <div className="grow" />
                <div role="tablist" aria-label="Response view" className="flex">
                  <button type="button" role="tab" className="rtab" aria-selected={view === 'body'} onClick={() => setView('body')}>
                    Body
                  </button>
                  <button type="button" role="tab" className="rtab" aria-selected={view === 'headers'} onClick={() => setView('headers')}>
                    Headers
                  </button>
                </div>
                <button
                  type="button"
                  className="btn ghost"
                  onClick={() =>
                    void copyText(last.body).then(
                      () => setNotice({ tone: 'ok', text: 'Copied the body.' }),
                      (e: unknown) => setNotice({ tone: 'bad', text: copyFailed(e) }),
                    )
                  }
                >
                  Copy
                </button>
              </div>
              {view === 'body' ? (
                <div className="min-h-0 flex-1 overflow-auto p-3" role="region" aria-label="Response body">
                  {state.pages.map((page, i) => (
                    // A page's tree keeps its folds while later pages are added.
                    <PageBody key={i} page={page} number={state.pages.length > 1 ? i + 1 : null} onOpenArray={openArray} />
                  ))}
                </div>
              ) : (
                <ResponseHeaders headers={last.headers} />
              )}
              {last.nextLink && (
                <div className="flex items-center gap-3 border-t border-line px-3 py-2">
                  <button type="button" className="btn" disabled={state.sending || accountChanged} onClick={() => void next()}>
                    Next page
                  </button>
                  {accountChanged && (
                    <span className="text-[12px] text-warn">
                      The account changed since the first page. Send the request again to page through it with this account.
                    </span>
                  )}
                </div>
              )}
            </>
          ) : (
            !error && (
              <div className="flex flex-1 items-center justify-center">
                <span className="faint text-[12px]">{state.sending ? 'Sending…' : `Send the request with ${MOD} Enter. Graph’s answer shows here.`}</span>
              </div>
            )
          )}
          {error?.code === 'signInNeeded' && (
            <div className="flex items-center gap-3 border-t border-line px-3 py-2 text-[12px]">
              <span>{error.message}</span>
              <button type="button" className="btn primary" onClick={onSignIn}>
                Sign in
              </button>
            </div>
          )}
          {error && error.code !== 'signInNeeded' && error.code !== 'bad_request' && (
            <div className="border-t border-line bg-bad-soft px-3 py-1.5 text-[12px] text-bad" role="alert">
              {error.message}
            </div>
          )}
          {notice && <NoticeLine notice={notice} onDismiss={() => setNotice(null)} />}
        </section>
      </div>
    </div>
  );
}

interface PathInputProps {
  tabId: string;
  text: string;
  schema: SchemaView | null;
  invalid: boolean;
  onSend: () => void;
}

/** The path, with a list of completions from the schema while typing. The list closes on Esc or a click outside, never on blur
 * (WebKit blurs on a click in the list itself). */
function PathInput({ tabId, text, schema, invalid, onSend }: PathInputProps) {
  const [completion, setCompletion] = useState<{ from: number; caret: number; items: string[]; active: number } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const caretAfter = useRef<number | null>(null);
  const listId = `${tabId}-completions`;

  useEffect(() => {
    if (caretAfter.current !== null) {
      input.current?.setSelectionRange(caretAfter.current, caretAfter.current);
      caretAfter.current = null;
    }
  });

  useEffect(() => {
    if (!completion) {
      return;
    }
    const onDown = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) {
        setCompletion(null);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [completion]);

  const accept = (item: string) => {
    if (!completion) {
      return;
    }
    const next = text.slice(0, completion.from) + item + text.slice(completion.caret);
    caretAfter.current = completion.from + item.length;
    useTabs.getState().setText(tabId, next);
    setCompletion(null);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (completion) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const step = e.key === 'ArrowDown' ? 1 : -1;
        setCompletion({ ...completion, active: (completion.active + step + completion.items.length) % completion.items.length });
        return;
      }
      if ((e.key === 'Enter' && !e.ctrlKey && !e.metaKey) || e.key === 'Tab') {
        e.preventDefault();
        accept(completion.items[completion.active]!);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setCompletion(null);
        return;
      }
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      onSend();
    }
  };

  return (
    <div className="relative flex-1" ref={box}>
      <input
        ref={input}
        className="textbox font-mono w-full"
        role="combobox"
        aria-label="Request path"
        aria-autocomplete="list"
        aria-expanded={completion !== null}
        aria-controls={listId}
        aria-activedescendant={completion ? `${listId}-${completion.active}` : undefined}
        aria-invalid={invalid}
        aria-describedby={invalid ? `${tabId}-path-error` : undefined}
        placeholder="me/memberOf?$select=displayName,id"
        spellCheck={false}
        value={text}
        onChange={(e) => {
          const value = e.target.value;
          const caret = e.target.selectionStart ?? value.length;
          useTabs.getState().setText(tabId, value);
          const { from, items } = completePath(schema, value, caret);
          setCompletion(items.length > 0 ? { from, caret, items, active: 0 } : null);
        }}
        onKeyDown={onKeyDown}
      />
      {completion && (
        <div className="menu" role="listbox" id={listId} aria-label="Completions" style={{ left: 0, top: 36, minWidth: 260, maxHeight: 280, overflowY: 'auto' }}>
          {completion.items.map((item, i) => (
            <button
              key={item}
              type="button"
              role="option"
              id={`${listId}-${i}`}
              aria-selected={i === completion.active}
              className={`mono${i === completion.active ? ' on' : ''}`}
              tabIndex={-1}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => accept(item)}
            >
              {item}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function HeadersEditor({ headers, error, onChange }: { headers: RawHeader[]; error: string | null; onChange: (headers: RawHeader[]) => void }) {
  const set = (i: number, change: Partial<RawHeader>) => onChange(headers.map((h, j) => (j === i ? { ...h, ...change } : h)));
  return (
    <section aria-label="Request headers" className="flex w-[34%] max-w-[420px] min-w-[240px] shrink-0 flex-col overflow-auto border-r border-line">
      <div className="rbar">
        <b className="text-[12.5px]">Headers · {headers.length}</b>
      </div>
      <div className="flex flex-col gap-1.5 p-3">
        {headers.map((h, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <input
              className="textbox font-mono w-[40%] min-w-0"
              aria-label={`Header ${i + 1} name`}
              placeholder="Name"
              spellCheck={false}
              value={h.name}
              onChange={(e) => set(i, { name: e.target.value })}
            />
            <input
              className="textbox font-mono min-w-0 flex-1"
              aria-label={`Header ${i + 1} value`}
              placeholder="Value"
              spellCheck={false}
              value={h.value}
              onChange={(e) => set(i, { value: e.target.value })}
            />
            <button type="button" className="btn ghost" aria-label={`Remove header ${i + 1}`} onClick={() => onChange(headers.filter((_, j) => j !== i))}>
              ×
            </button>
          </div>
        ))}
        <div className="flex items-center gap-1.5 text-[12px]">
          <span className="faint mono w-[40%]">Authorization</span>
          <span className="faint">Bearer · added for you, never shown</span>
        </div>
        {error && (
          <span className="text-[12px] text-bad" role="alert">
            {error}
          </span>
        )}
        <button type="button" className="btn self-start" onClick={() => onChange([...headers, { name: '', value: '' }])}>
          Add header
        </button>
      </div>
    </section>
  );
}

function ResponseHeaders({ headers }: { headers: Record<string, string> }) {
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <table className="datagrid" aria-label="Response headers">
        <thead>
          <tr>
            <th scope="col" className="px-3 py-[7px]">
              Header
            </th>
            <th scope="col" className="px-3 py-[7px]">
              Value
            </th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(headers).map(([name, value]) => (
            <tr key={name}>
              <td>{name}</td>
              <td title={value}>{value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

type OpenArray = (label: string | null, array: unknown[]) => void;

function PageBody({ page, number, onOpenArray }: { page: RawResponse; number: number | null; onOpenArray: OpenArray }) {
  const parsed = useMemo(() => {
    try {
      return { ok: true as const, value: JSON.parse(page.body) as unknown };
    } catch {
      return { ok: false as const };
    }
  }, [page.body]);
  return (
    <div className="mb-3 flex flex-col gap-1">
      {number !== null && <b className="text-[12.5px]">Page {number}</b>}
      {page.truncated && (
        <span className="text-[12px] text-warn">The body was cut off at the host’s limit, so it is shown as text.</span>
      )}
      {parsed.ok ? (
        <div className="codeblock overflow-x-auto">
          <JsonValue label={null} value={parsed.value} depth={0} onOpenArray={onOpenArray} />
        </div>
      ) : (
        <pre className="codeblock m-0 overflow-x-auto">{page.body}</pre>
      )}
    </div>
  );
}

/** How deep the body starts unfolded, and how many entries an array shows before "Show all". */
const OPEN_DEPTH = 3;
const SHOWN_ENTRIES = 100;

function Leaf({ value }: { value: unknown }) {
  const tone = typeof value === 'string' ? 'var(--str)' : typeof value === 'number' ? 'var(--num)' : 'var(--kw)';
  return <span style={{ color: tone }}>{JSON.stringify(value)}</span>;
}

function JsonValue({ label, value, depth, onOpenArray }: { label: string | null; value: unknown; depth: number; onOpenArray: OpenArray }) {
  const [open, setOpen] = useState(depth < OPEN_DEPTH);
  const [all, setAll] = useState(false);
  const key = label === null ? null : <span style={{ color: 'var(--col)' }}>{label}</span>;

  if (value === null || typeof value !== 'object') {
    return (
      <div>
        {key}
        {key && ': '}
        <Leaf value={value} />
      </div>
    );
  }

  const array = Array.isArray(value);
  const entries: [string, unknown][] = array ? value.map((v, i) => [String(i), v]) : Object.entries(value as Record<string, unknown>);
  const shown = all ? entries : entries.slice(0, SHOWN_ENTRIES);
  const summary = array ? `[${entries.length}]` : `{${entries.length}}`;
  const children = (
    <div className="border-l border-line pl-4">
      {shown.map(([k, v]) => (
        <JsonValue key={k} label={k} value={v} depth={depth + 1} onOpenArray={onOpenArray} />
      ))}
      {shown.length < entries.length && (
        <button type="button" className="btn ghost" onClick={() => setAll(true)}>
          Show all {entries.length.toLocaleString('en-US')}
        </button>
      )}
    </div>
  );

  // The body itself is always open.
  if (label === null && !array) {
    return children;
  }
  return (
    <div>
      <div className="flex items-center gap-2">
        <button type="button" className="btn ghost h-auto px-1" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <span aria-hidden="true">{open ? '▾' : '▸'}</span>
          {label === null ? 'body' : label} <span className="faint">{summary}</span>
        </button>
        {array && (
          <button type="button" className="btn ghost h-auto px-1 text-[11.5px]" aria-label={`Open ${label ?? 'body'} as a KQL tab`} onClick={() => onOpenArray(label, value)}>
            Open as KQL tab
          </button>
        )}
      </div>
      {open && children}
    </div>
  );
}
