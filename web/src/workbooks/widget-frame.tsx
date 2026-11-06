import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { EXPORT_NAMES, exportResult, type ExportFormat } from '../results/export';
import { MenuButton, NoticeLine, type Notice } from '../results/result-grid';
import { RunStatus } from '../results/run-status';
import { errorText } from '../shell/errors';
import { reportIdOf } from '../shell/report-id';
import { SourceBadge } from '../tabs/source-badge';
import { failed, useTabs } from '../tabs/tab-store';
import type { ParameterDef, RunResult } from '../wire';
import type { Widget } from './model';
import { widgetParams, widgetRunOptions, type ResolvedParam } from './resolve';
import { effectiveWidget, useWorkbooks, type WidgetRun } from './workbook-store';

const FORMATS: ExportFormat[] = ['csv', 'json', 'markdown'];

const duration = (ms: number) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

/** A Widget · shown parameter's control: a select for one with choices, which reruns the widget at once, else a text box,
 * which reruns it when typing stops, or at once on Enter. */
function ShownControl({ param, choices, onChange }: { param: ResolvedParam; choices: string[] | null; onChange: (value: string, now: boolean) => void }) {
  if (choices) {
    return (
      <select className="textbox mono" style={{ height: 24 }} aria-label={param.name} value={param.value} onChange={(e) => onChange(e.target.value, true)}>
        {(choices.includes(param.value) ? choices : [param.value, ...choices]).map((c) => (
          <option key={c} value={c}>
            {c === '' ? '(none)' : c}
          </option>
        ))}
      </select>
    );
  }
  return (
    <input
      className="textbox mono w-24"
      style={{ height: 24 }}
      aria-label={param.name}
      placeholder={param.name}
      value={param.value}
      onChange={(e) => onChange(e.target.value, false)}
      onKeyDown={(e) => e.key === 'Enter' && onChange(e.currentTarget.value, true)}
    />
  );
}

/** What a widget shows while it has no result: running, waiting, blocked, gone, or the error view. Null when it has one. */
function runBody(tabId: string, widget: Widget, run: WidgetRun | undefined, onSignIn: () => void): ReactNode {
  const source = widget.query?.source ?? 'graph';
  const errorView = (result: RunResult, at: number | undefined) => (
    <RunStatus
      run={{ state: 'done', source, runId: result.runId, result, startedAt: at ?? Date.now(), origin: { line: 1, column: 1 }, kql: widget.query?.text }}
      onSignIn={onSignIn}
      onConsented={() => void useWorkbooks.getState().runWidget(tabId, widget.id)}
      onGranted={() => void useWorkbooks.getState().runWidget(tabId, widget.id)}
    />
  );
  switch (run?.state) {
    case undefined:
    case 'idle':
      return <p className="faint m-0 p-4 text-[12px]">No query yet.</p>;
    case 'running':
    case 'waiting':
      return (
        <p className="muted m-0 flex items-center gap-2 p-4 text-[12px]" role="status">
          <span className="size-3 animate-spin rounded-full border-2 border-line border-t-accent" aria-hidden="true" />
          {run.state === 'running' ? 'Running' : 'Waiting'}
        </p>
      );
    case 'blocked':
      return <p className="m-0 p-4 text-[12px] text-warn">{run.reason}</p>;
    case 'gone':
      return (
        <div className="flex flex-col items-start gap-2 p-4 text-[12px]">
          <span className="text-bad">This saved query is gone.</span>
          <button type="button" className="btn" onClick={() => useWorkbooks.getState().copySavedIntoWidget(tabId, widget.id)}>
            Copy the last text into the widget
          </button>
        </div>
      );
    case 'failed':
      return errorView(failed(errorText(run.error), '', reportIdOf(run.error)), run.finishedAt);
    case 'done':
      return run.result.outcome === 'ok' ? null : errorView(run.result, run.finishedAt);
  }
}

/**
 * A widget on the workbook grid (spec 5.3): its header (source badge, title, its Widget · shown controls, the workbook
 * parameters it uses, run time, and ⋯ with Refresh, Open in query tab, Export and Full screen), then its run's state, or
 * `children` once it has a result. Placed on the grid by its layout, through the `.wb-widget` variables.
 */
export function WidgetFrame({ tabId, widget, children, onSignIn = () => undefined }: { tabId: string; widget: Widget; children: ReactNode; onSignIn?: () => void }) {
  const doc = useWorkbooks((s) => s.byTab[tabId]?.doc);
  const values = useWorkbooks((s) => s.byTab[tabId]?.values);
  const run = useWorkbooks((s) => s.byTab[tabId]?.runs[widget.id]);
  const [full, setFull] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  // Esc leaves full screen first, as on the Chart tab.
  useEffect(() => {
    if (!full) {
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) {
        e.preventDefault();
        setFull(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [full]);
  if (!doc || !values) {
    return null;
  }

  const title = widget.title || 'Untitled widget';
  // A linked widget shows, and opens, what its saved query has now.
  const live = effectiveWidget(tabId, widget) ?? widget;
  const params = widgetParams(doc, live, values);
  const choicesOf = (w: Widget, p: ResolvedParam) =>
    (p.from === 'workbook' ? doc.parameters.find((d) => d.name === p.name) : w.query?.parameters.find((d) => d.name === p.name))?.choices ?? null;
  const result = run?.state === 'done' ? run.result : null;

  const openInTab = () => {
    const w = live;
    if (!w.query) {
      return;
    }
    const parameters: ParameterDef[] = widgetParams(doc, w, values).map((p) => ({
      name: p.name,
      type: p.type,
      value: p.value,
      required: p.required,
      choices: choicesOf(w, p),
    }));
    const options = widgetRunOptions(doc, w, values);
    useTabs.getState().openWith({
      source: w.query.source,
      title,
      text: w.query.text,
      parameters,
      options: (options && !('problem' in options) ? options : w.query.options) ?? undefined,
    });
  };

  const exportAs = (format: ExportFormat) => {
    if (!result) {
      return;
    }
    void exportResult(format, title, result).then(
      (file) => file && setNotice({ tone: 'ok', text: `Exported to ${file.name}.` }),
      (e: unknown) => setNotice({ tone: 'bad', text: `Couldn’t export: ${errorText(e)}`, reportId: reportIdOf(e) }),
    );
  };

  const place = { '--x': widget.layout.x + 1, '--y': widget.layout.y + 1, '--w': widget.layout.w, '--h': widget.layout.h } as CSSProperties;
  const used = params.filter((p) => p.from === 'workbook').map((p) => p.name);

  return (
    <section aria-label={title} style={place} className={`card wb-widget flex min-h-0 min-w-0 flex-col ${full ? 'fixed inset-0 z-20 rounded-none' : ''}`}>
      <header className="flex min-w-0 flex-wrap items-center gap-2 px-3 py-2 text-[12.5px]">
        {live.query && <SourceBadge source={live.query.source} titled />}
        <b className="min-w-0 truncate">{title}</b>
        {params
          .filter((p) => p.from === 'widget')
          .map((p) => (
            <ShownControl key={p.name} param={p} choices={choicesOf(live, p)} onChange={(v, now) => useWorkbooks.getState().setWidgetValue(tabId, widget.id, p.name, v, { now })} />
          ))}
        {used.length > 0 && (
          <span className="faint flex items-center gap-1 text-[11.5px]" title="Workbook parameters it uses">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1" />
              <path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1" />
            </svg>
            {used.map((name) => (
              <span key={name} className="mono">
                {name}
              </span>
            ))}
          </span>
        )}
        <div className="grow" />
        {result && <span className="mono faint text-[11.5px]">{duration(result.durationMs)}</span>}
        <MenuButton label={`${title} menu`} icon="⋯">
          {widget.query && (
            <>
              <button type="button" role="menuitem" tabIndex={-1} onClick={() => void useWorkbooks.getState().runWidget(tabId, widget.id, { refresh: true })}>
                Refresh
              </button>
              <button type="button" role="menuitem" tabIndex={-1} onClick={openInTab}>
                Open in query tab
              </button>
              {FORMATS.map((format) => (
                <button key={format} type="button" role="menuitem" tabIndex={-1} disabled={!result} onClick={() => exportAs(format)}>
                  Export {EXPORT_NAMES[format]}
                </button>
              ))}
            </>
          )}
          <button type="button" role="menuitem" tabIndex={-1} onClick={() => setFull(!full)}>
            {full ? 'Exit full screen' : 'Full screen'}
          </button>
        </MenuButton>
      </header>
      {notice && <NoticeLine notice={notice} onDismiss={() => setNotice(null)} />}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {(widget.query && runBody(tabId, widget, run, onSignIn)) ?? children}
      </div>
    </section>
  );
}
