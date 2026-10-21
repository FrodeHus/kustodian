import { Component, Suspense, lazy, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { errorText } from '../shell/errors';
import { useTabs } from '../tabs/tab-store';
import type { RunResult } from '../wire';
import { CompareView } from './compare-view';
import { DiagnosticsView } from './diagnostics-view';
import { EXPORT_FORMATS, EXPORT_NAMES, exportResult, toJson, type ExportFormat } from './export';
import { MenuButton, NoticeLine, ResultGrid, type Notice } from './result-grid';
import { RowDetails } from './row-details';

// Recharts is a chunk of its own, loaded the first time the Chart tab opens.
const ChartView = lazy(() => import('./chart-view'));

/** The JSON tab shows at most this many rows; Export writes them all. */
const JSON_ROWS = 1000;

type ResultTab = 'rows' | 'chart' | 'json' | 'diagnostics' | 'compare';

const count = (n: number) => n.toLocaleString('en-US');
const rowCount = (n: number) => `${count(n)} ${n === 1 ? 'row' : 'rows'}`;

class ChartFailed extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <p className="m-0 p-4 text-[12px] text-bad" role="alert">
        The chart couldn’t be loaded. Restart Kustodian to try again.
      </p>
    ) : (
      this.props.children
    );
  }
}

interface PanelProps {
  tabId: string;
  /** The tab's title: exports are named after it. */
  title: string;
  /** The query that ran, for its `| render`. */
  kql: string;
  result: RunResult;
  /** The run pinned to compare with, when there is one. */
  pinned?: RunResult;
  /** A dialog (the palette, the save dialog) is open: the row details sheet closes first, so focus is the dialog's. */
  dialogOpen?: boolean;
}

/**
 * The results area (spec 6.5): tabs for Rows, Chart, JSON and Diagnostics, and Compare once a run is pinned. The tabs take the
 * arrow keys, Home and End. The Rows tab's tools and Export sit in the tab bar; a row opened in the grid shows in the row
 * details sheet.
 */
export function ResultPanel({ tabId, title, kql, result, pinned, dialogOpen = false }: PanelProps) {
  const [chosen, setChosen] = useState<ResultTab>('rows');
  const [slot, setSlot] = useState<HTMLDivElement | null>(null);
  const [details, setDetails] = useState<number | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  // A new result closes the row details: its index was into the old rows.
  const [resultSeen, setResultSeen] = useState(result);
  if (resultSeen !== result) {
    setResultSeen(result);
    setDetails(null);
  }
  if (dialogOpen && details !== null) {
    setDetails(null);
  }
  const tabRefs = useRef(new Map<ResultTab, HTMLButtonElement>());
  const id = useId();

  const tabs: { name: ResultTab; label: string }[] = [
    { name: 'rows', label: `Rows · ${count(result.rows.length)}` },
    { name: 'chart', label: 'Chart' },
    { name: 'json', label: 'JSON' },
    { name: 'diagnostics', label: 'Diagnostics' },
    ...(pinned ? [{ name: 'compare' as const, label: 'Compare' }] : []),
  ];
  // Compare goes when the pinned run does.
  const active = tabs.some((t) => t.name === chosen) ? chosen : 'rows';

  const choose = (name: ResultTab) => {
    setChosen(name);
    tabRefs.current.get(name)?.focus();
  };

  const onTabKey = (e: KeyboardEvent) => {
    const at = tabs.findIndex((t) => t.name === active);
    const to =
      e.key === 'ArrowRight' ? at + 1 : e.key === 'ArrowLeft' ? at - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : null;
    if (to === null) {
      return;
    }
    e.preventDefault();
    const next = tabs[(to + tabs.length) % tabs.length];
    if (next) {
      choose(next.name);
    }
  };

  const exportAs = (format: ExportFormat) =>
    exportResult(format, title, result).then(
      (file) => file && setNotice({ tone: 'ok', text: `Exported ${rowCount(result.rows.length)} to ${file.name}.` }),
      (e: unknown) => setNotice({ tone: 'bad', text: `Couldn’t export: ${errorText(e)}` }),
    );

  const panel = (name: ResultTab, content: ReactNode) => (
    <div
      key={name}
      id={`${id}-panel-${name}`}
      role="tabpanel"
      aria-labelledby={`${id}-tab-${name}`}
      hidden={active !== name}
      className={active === name ? 'flex min-h-0 flex-1 flex-col' : undefined}
    >
      {content}
    </div>
  );

  const detailsRow = details === null ? undefined : result.rows[details];

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div className="rbar">
        <div role="tablist" aria-label="Result" className="flex shrink-0" onKeyDown={onTabKey}>
          {tabs.map((t) => (
            <button
              key={t.name}
              ref={(el) => {
                if (el) {
                  tabRefs.current.set(t.name, el);
                } else {
                  tabRefs.current.delete(t.name);
                }
              }}
              id={`${id}-tab-${t.name}`}
              type="button"
              role="tab"
              className="rtab whitespace-nowrap"
              aria-selected={active === t.name}
              aria-controls={`${id}-panel-${t.name}`}
              tabIndex={active === t.name ? 0 : -1}
              onClick={() => setChosen(t.name)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="grow" />
        <div ref={setSlot} className="flex min-w-0 items-center justify-end gap-1.5" />
        {active === 'rows' && (
          <MenuButton label="Export" primary>
            {EXPORT_FORMATS.map((format) => (
              <button key={format} type="button" role="menuitem" tabIndex={-1} onClick={() => void exportAs(format)}>
                {EXPORT_NAMES[format]}
              </button>
            ))}
          </MenuButton>
        )}
        {pinned ? (
          <button type="button" className="btn ghost shrink-0" onClick={() => useTabs.getState().unpin(tabId)}>
            Unpin
          </button>
        ) : (
          <button type="button" className="btn ghost shrink-0" onClick={() => useTabs.getState().pin(tabId)}>
            Pin to compare
          </button>
        )}
      </div>
      {notice && <NoticeLine notice={notice} onDismiss={() => setNotice(null)} />}
      {panel('rows', <ResultGrid columns={result.columns} rows={result.rows} toolbar={active === 'rows' ? slot : null} onOpenRow={setDetails} />)}
      {panel(
        'chart',
        active === 'chart' && (
          <ChartFailed>
            <Suspense fallback={<p className="faint m-0 p-4 text-[12px]">Loading the chart…</p>}>
              <ChartView columns={result.columns} rows={result.rows} kql={kql} />
            </Suspense>
          </ChartFailed>
        ),
      )}
      {panel(
        'json',
        active === 'json' && (
          <div className="flex min-h-0 flex-1 flex-col">
            {result.rows.length > JSON_ROWS && (
              <p className="faint m-0 px-3 pt-3 text-[12px]">
                Showing the first {count(JSON_ROWS)} of {rowCount(result.rows.length)}. Export writes them all.
              </p>
            )}
            <pre className="codeblock m-3 min-h-0 flex-1 overflow-auto" tabIndex={0}>
              {toJson(result.columns, result.rows.slice(0, JSON_ROWS))}
            </pre>
          </div>
        ),
      )}
      {panel('diagnostics', active === 'diagnostics' && <DiagnosticsView result={result} />)}
      {pinned && panel('compare', active === 'compare' && <CompareView pinned={pinned} current={result} />)}
      {detailsRow && <RowDetails columns={result.columns} row={detailsRow} onClose={() => setDetails(null)} />}
    </div>
  );
}
