import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent as KeyEvent, type PointerEvent, type ReactNode } from 'react';
import { EXPORT_NAMES, exportResult, type ExportFormat } from '../results/export';
import { MenuButton, NoticeLine, type Notice } from '../results/result-grid';
import { RunStatus } from '../results/run-status';
import { errorText } from '../shell/errors';
import { reportIdOf } from '../shell/report-id';
import { SourceBadge } from '../tabs/source-badge';
import { failed, useTabs } from '../tabs/tab-store';
import type { ParameterDef, RunResult } from '../wire';
import { COLUMNS, GAP_PX, move, place, resize, ROW_PX } from './layout';
import { newWidget, type Widget, type WidgetLayout } from './model';
import { widgetParams, widgetRunOptions, type ResolvedParam } from './resolve';
import { effectiveWidget, useWorkbooks, type WidgetRun } from './workbook-store';

const FORMATS: ExportFormat[] = ['csv', 'json', 'markdown'];

/** Edit mode's part in a widget: whether it is the selected one, and what the workbook does on its actions. */
export interface WidgetEditing {
  selected: boolean;
  onSelect: () => void;
  /** Opens the widget editor; focus goes back to `opener` when it closes. */
  onEditWidget: (opener: HTMLElement) => void;
  /** Removes the widget and puts focus somewhere that keeps working (the workbook knows the order). */
  onRemove: () => void;
  /** Said through the workbook's live region. */
  announce: (text: string) => void;
}

/** A gesture: a move, or a resize by the right edge (w), the bottom edge (h) or the corner (both). */
type Kind = 'move' | { w: boolean; h: boolean };

const ARROWS: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

/** The widgets after moving or resizing `id` by `dx` columns and `dy` rows, through layout.ts. */
function shifted(widgets: Widget[], id: string, kind: Kind, dx: number, dy: number): Widget[] {
  const l = widgets.find((w) => w.id === id)?.layout;
  if (!l) {
    return widgets;
  }
  return kind === 'move' ? move(widgets, id, l.x + dx, l.y + dy) : resize(widgets, id, l.w + (kind.w ? dx : 0), l.h + (kind.h ? dy : 0));
}

const cellVars = (l: WidgetLayout) => ({ '--x': l.x + 1, '--y': l.y + 1, '--w': l.w, '--h': l.h }) as CSSProperties;

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
 * `children` once it has a result. Placed on the grid by its layout, through the `.wb-widget` variables. In edit mode
 * (`editing`) its grip drags or arrow-keys it, and the selected one has resize handles; each gesture is one `edit`.
 */
export function WidgetFrame({
  tabId,
  widget,
  children,
  onSignIn = () => undefined,
  editing,
}: {
  tabId: string;
  widget: Widget;
  children: ReactNode;
  onSignIn?: () => void;
  /** Set in edit mode: the grip, size, resize handles and Edit widget, Duplicate and Remove. */
  editing?: WidgetEditing;
}) {
  const doc = useWorkbooks((s) => s.byTab[tabId]?.doc);
  const values = useWorkbooks((s) => s.byTab[tabId]?.values);
  const run = useWorkbooks((s) => s.byTab[tabId]?.runs[widget.id]);
  const [full, setFull] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const ref = useRef<HTMLElement>(null);
  // The pointer gesture under way: what it does, where it started, and the grid's measured column pitch.
  const gesture = useRef<{ kind: Kind; x: number; y: number; column: number } | null>(null);
  const [target, setTarget] = useState<WidgetLayout | null>(null);
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

  const { edit } = useWorkbooks.getState();
  const steps = (e: { clientX: number; clientY: number }) => {
    const g = gesture.current;
    return g ? ([Math.round((e.clientX - g.x) / g.column), Math.round((e.clientY - g.y) / (ROW_PX + GAP_PX))] as const) : null;
  };
  /** One edit for a move or resize, announced where it ended. Nothing when it changes nothing (at an edge, say). */
  const commit = (kind: Kind, dx: number, dy: number) => {
    const now = shifted(doc.widgets, widget.id, kind, dx, dy).find((w) => w.id === widget.id)?.layout ?? widget.layout;
    const l = widget.layout;
    if (now.x !== l.x || now.y !== l.y || now.w !== l.w || now.h !== l.h) {
      edit(tabId, (d) => ({ ...d, widgets: shifted(d.widgets, widget.id, kind, dx, dy) }));
    }
    editing?.announce(kind === 'move' ? `Moved to column ${now.x + 1}, row ${now.y + 1}` : `Resized to ${now.w} × ${now.h}`);
  };
  const duplicate = () => {
    edit(tabId, (d) => ({ ...d, widgets: [...d.widgets, { ...widget, id: newWidget(widget.type, widget.layout).id, layout: place(d.widgets, widget.layout.w, widget.layout.h) }] }));
    editing?.announce(`Duplicated ${title}`);
  };
  /** Pointer handlers for the grip or a resize handle: moves by whole cells, with the drop target showing where it lands. */
  const drag = (kind: Kind) => ({
    onPointerDown: (e: PointerEvent<HTMLElement>) => {
      const grid = ref.current?.parentElement?.getBoundingClientRect();
      if (e.button !== 0 || !grid) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      // Absent in jsdom; in a browser it keeps the gesture's events on the handle when the pointer leaves it.
      e.currentTarget.setPointerCapture?.(e.pointerId);
      gesture.current = { kind, x: e.clientX, y: e.clientY, column: (grid.width + GAP_PX) / COLUMNS };
      editing?.onSelect();
    },
    onPointerMove: (e: PointerEvent<HTMLElement>) => {
      const s = steps(e);
      if (s) {
        setTarget(shifted(doc.widgets, widget.id, kind, s[0], s[1]).find((w) => w.id === widget.id)?.layout ?? null);
      }
    },
    onPointerUp: (e: PointerEvent<HTMLElement>) => {
      const s = steps(e);
      gesture.current = null;
      setTarget(null);
      if (s) {
        commit(kind, s[0], s[1]);
      }
    },
    onPointerCancel: () => {
      gesture.current = null;
      setTarget(null);
    },
  });
  const onGripKey = (e: KeyEvent) => {
    const arrow = ARROWS[e.key];
    if (arrow) {
      e.preventDefault();
      commit(e.shiftKey ? { w: true, h: true } : 'move', arrow[0], arrow[1]);
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      editing?.onRemove();
    }
  };

  const used = params.filter((p) => p.from === 'workbook').map((p) => p.name);

  const selected = editing?.selected ?? false;
  return (
    <>
      <section
        ref={ref}
        aria-label={title}
        style={cellVars(widget.layout)}
        className={`card wb-widget relative flex min-h-0 min-w-0 flex-col ${selected ? 'border-accent' : ''} ${full ? 'fixed inset-0 z-20 rounded-none' : ''}`}
        onPointerDown={editing?.onSelect}
      >
        <header className="flex min-w-0 flex-wrap items-center gap-2 px-3 py-2 text-[12.5px]">
          {editing && (
            <button
              type="button"
              className="wb-grip btn ghost"
              aria-label={`Move ${title}`}
              title="Drag to move. Arrows move, Shift+arrows resize, Delete removes."
              onFocus={editing.onSelect}
              onKeyDown={onGripKey}
              {...drag('move')}
            >
              <span aria-hidden="true">⠿</span>
            </button>
          )}
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
          {editing && (
            <span className="mono faint text-[11.5px]">
              {widget.layout.w} × {widget.layout.h}
            </span>
          )}
          {selected && (
            <>
              <button type="button" className="btn ghost" onClick={(e) => editing?.onEditWidget(e.currentTarget)}>
                Edit widget
              </button>
              <button type="button" className="btn ghost" onClick={duplicate}>
                Duplicate
              </button>
              <button type="button" className="btn ghost" onClick={editing?.onRemove}>
                Remove
              </button>
            </>
          )}
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
        {/* Pointer only; Shift+arrows on the grip resize from the keyboard. */}
        {selected && (
          <>
            <div className="wb-resize-right" aria-hidden="true" {...drag({ w: true, h: false })} />
            <div className="wb-resize-bottom" aria-hidden="true" {...drag({ w: false, h: true })} />
            <div className="wb-resize-corner" aria-hidden="true" {...drag({ w: true, h: true })} />
          </>
        )}
      </section>
      {target && <div className="wb-widget wb-drop" style={cellVars(target)} aria-hidden="true" />}
    </>
  );
}
