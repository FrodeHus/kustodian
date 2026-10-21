import { useCallback, useState } from 'react';
import type { DiagnosticEntry, RunResult } from '../wire';
import { copyFailed, copyText, diagnosticsText } from './copy';
import { NoticeLine, type Notice } from './result-grid';

const ROW_HEIGHT = 28;
/** Entries drawn above and below the ones in view. */
const OVERSCAN = 12;
const count = (n: number) => n.toLocaleString('en-US');

const KIND_TONE: Partial<Record<DiagnosticEntry['kind'], string>> = { throttled: 'warn', retry: 'warn' };

function seconds(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/**
 * The Diagnostics tab (spec 6.10, mockup Diagnostics): the run's statistics, and its log as a virtualized list with a badge for
 * each entry's kind, copyable as text.
 */
export function DiagnosticsView({ result }: { result: RunResult }) {
  const [notice, setNotice] = useState<Notice | null>(null);
  const entries = result.diagnostics;
  // A window of entries around the ones in view, every entry one row high. (Windowed here rather than with TanStack Virtual,
  // which the React Compiler can't memoize.)
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(600);
  const measure = useCallback((el: HTMLDivElement | null) => {
    if (!el || typeof ResizeObserver === 'undefined') {
      return;
    }
    const observer = new ResizeObserver(() => setViewport(el.clientHeight));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(entries.length, Math.ceil((scrollTop + viewport) / ROW_HEIGHT) + OVERSCAN);
  const padTop = first * ROW_HEIGHT;
  const padBottom = (entries.length - last) * ROW_HEIGHT;

  const stats: [string, string][] = [
    ['Duration', seconds(result.durationMs)],
    ['Rows', count(result.total)],
    ['Graph requests', count(result.tables.reduce((n, t) => n + t.requests.length, 0))],
    ['From cache', count(result.tables.reduce((n, t) => n + t.perObjectCached, 0))],
    ['Retries', count(entries.filter((e) => e.kind === 'retry').length)],
    ['Throttled', count(entries.filter((e) => e.kind === 'throttled').length)],
  ];

  const copy = () =>
    copyText(diagnosticsText(entries)).then(
      () => setNotice({ tone: 'ok', text: `Copied ${count(entries.length)} ${entries.length === 1 ? 'entry' : 'entries'}.` }),
      (e: unknown) => setNotice({ tone: 'bad', text: copyFailed(e) }),
    );

  return (
    <div className="flex min-h-0 flex-1 gap-4 overflow-auto p-4">
      <section className="card flex w-[300px] shrink-0 flex-col gap-3 self-start p-4" aria-label="Run statistics">
        <b className="text-[14px]">This run</b>
        <dl className="m-0 grid grid-cols-2 gap-3">
          {stats.map(([label, value]) => (
            <div key={label} className="field">
              <dt className="text-[12px] font-semibold text-muted">{label}</dt>
              <dd className="mono m-0 text-[20px]">{value}</dd>
            </div>
          ))}
        </dl>
      </section>
      <section className="card flex min-w-0 flex-1 flex-col" aria-label="What happened">
        <div className="flex items-center gap-2 border-b border-line px-4 py-3">
          <b className="text-[14px]">What happened</b>
          <div className="grow" />
          <button type="button" className="btn ghost" disabled={entries.length === 0} onClick={() => void copy()}>
            Copy as text
          </button>
        </div>
        {entries.length === 0 ? (
          <p className="faint m-0 p-4 text-[12px]">This run logged nothing.</p>
        ) : (
          <div
            ref={measure}
            className="min-h-0 flex-1 overflow-auto"
            tabIndex={0}
            role="region"
            aria-label="Log entries"
            onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
          >
            <ul aria-label="Event log" className="m-0 list-none p-0" style={{ paddingTop: padTop, paddingBottom: padBottom }}>
              {entries.slice(first, last).map((e, i) => {
                const tone = KIND_TONE[e.kind];
                return (
                  <li
                    key={first + i}
                    className="flex items-center gap-3 border-b border-line px-4 font-mono text-[12px]"
                    style={{ height: ROW_HEIGHT }}
                  >
                    <span className="faint w-[72px] shrink-0">+{count(e.atMs)} ms</span>
                    <span className={`tag w-[72px] text-center${tone ? ` ${tone}` : ''}`}>{e.kind}</span>
                    <span className="min-w-0 flex-1 truncate" title={e.detail}>
                      {e.detail}
                    </span>
                    <span className={`w-[36px] shrink-0 text-right ${e.status !== null && e.status >= 400 ? 'text-bad' : e.status !== null ? 'text-ok' : 'faint'}`}>
                      {e.status ?? '·'}
                    </span>
                    <span className="faint w-[64px] shrink-0 text-right">{e.durationMs === null ? '' : `${count(e.durationMs)} ms`}</span>
                    <span className="faint w-[72px] shrink-0 text-right">{e.bytes === null ? '' : `${count(e.bytes)} B`}</span>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
        {notice && <NoticeLine notice={notice} onDismiss={() => setNotice(null)} />}
      </section>
    </div>
  );
}
