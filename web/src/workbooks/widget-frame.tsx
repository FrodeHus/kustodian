import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent as KeyEvent, type PointerEvent, type ReactNode } from 'react';
import { EXPORT_NAMES, exportResult, type ExportFormat } from '../results/export';
import { createPortal } from 'react-dom';
import { call } from '../bridge';
import { MenuButton, NoticeLine, type Notice } from '../results/result-grid';
import { RunStatus } from '../results/run-status';
import { errorText } from '../shell/errors';
import { reportIdOf } from '../shell/report-id';
import { SourceBadge } from '../tabs/source-badge';
import { failed, useTabs } from '../tabs/tab-store';
import type { ParameterDef, RunResult } from '../wire';
import { COLUMNS, GAP_PX, nudge, overlaps, resize, ROW_PX } from './layout';
import { MAX_WIDGETS, type Place, type ToolButton, type Widget, type WidgetLayout } from './model';
import { destinations, duplicateWidget, placeKey, placeOf, withinPlace } from './tabs';
import { daysSince, HistoryData, SKIP_TEXT, useHistory, type HistoryFilter } from './history';
import { ClearConfirm } from './history-section';
import { widgetParams, widgetRunOptions, type ResolvedParam } from './resolve';
import { buttonName, effectiveSelection, okResult, toolTarget } from './tool-buttons';
import { useToolRun } from './tool-run';
import { SheetHost } from './widgets/sheet-host';
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
  /** Moves the widget to another place: to the cell `at` (a drop), else the bottom (Move to…). The workbook says so and focuses it. */
  onMoveTo: (to: Place | null, at?: { x: number; y: number }) => void;
  /** Where the widget shows: its layout, or where a gesture under way in its grid would leave it. */
  layout: WidgetLayout;
  /** Shows every widget in the grid where a gesture would leave it; null puts them back. */
  onPreview: (widgets: Widget[] | null) => void;
}

/** A gesture: a move, or a resize by the right edge (w), the bottom edge (h) or the corner (both). */
type Kind = 'move' | { w: boolean; h: boolean };

const ARROWS: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

/** The widgets after moving or resizing `id` by `dx` columns and `dy` rows within its place, through layout.ts. */
function shifted(widgets: Widget[], id: string, kind: Kind, dx: number, dy: number): Widget[] {
  const w = widgets.find((i) => i.id === id);
  if (!w) {
    return widgets;
  }
  const l = w.layout;
  return withinPlace(widgets, placeOf(w), (s) =>
    kind === 'move' ? nudge(s, id, dx, dy) : resize(s, id, l.w + (kind.w ? dx : 0), l.h + (kind.h ? dy : 0)),
  );
}

/** Move to…'s entries in place of the ⋯ menu's: Top level, then each tabs widget's tabs in a group named by its title.
 * `here`, the widget's place (a placeKey), is off. */
function MoveToItems({ widgets, here, onMove }: { widgets: Widget[]; here: string; onMove: (to: Place | null) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  // The item that opened it was replaced, and focus went with it.
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus();
  }, []);
  const list = destinations(widgets);
  const item = (d: (typeof list)[number]) => {
    const on = placeKey(d.to) === here;
    return (
      <button key={placeKey(d.to)} type="button" role="menuitem" tabIndex={-1} disabled={on} onClick={() => onMove(d.to)}>
        {on ? `${d.label} (here)` : d.label}
      </button>
    );
  };
  const groups = [...new Set(list.flatMap((d) => (d.to ? [d.to.tabs] : [])))].map((tabs) => list.filter((d) => d.to?.tabs === tabs));
  return (
    <div ref={ref} className="flex flex-col gap-0.5">
      {list.filter((d) => !d.to).map(item)}
      {groups.map((g) => (
        <div key={g[0]!.to!.tabs} role="group" aria-label={g[0]!.group} className="flex flex-col gap-0.5">
          <span className="faint px-2.5 pt-1.5 text-[11.5px]" aria-hidden="true">
            {g[0]!.group}
          </span>
          {g.map(item)}
        </div>
      ))}
    </div>
  );
}

const cellVars = (l: WidgetLayout) => ({ '--x': l.x + 1, '--y': l.y + 1, '--w': l.w, '--h': l.h }) as CSSProperties;

const duration = (ms: number) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

const INTERVAL_TEXT = { day: 'Daily', run: 'Every run', week: 'Weekly' } as const;

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
  if (param.type === 'list') {
    return (
      <textarea
        className="textbox mono h-auto w-40 py-0.5"
        rows={2}
        aria-label={param.name}
        placeholder="One value per line"
        value={param.value}
        onChange={(e) => onChange(e.target.value, false)}
      />
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

/** A widget's buttons for one placement: `btn`s for 'header', menu items for 'menu'. Each is labelled `${label} · ${count}`
 * and is off while its target has no rows or the widget has no ok result. */
function ToolButtonItems({
  tabId,
  widget,
  placement,
  onOpen,
}: {
  tabId: string;
  widget: Widget;
  placement: ToolButton['placement'];
  onOpen: (b: ToolButton) => void;
}): ReactNode {
  const result = okResult(useWorkbooks((s) => s.byTab[tabId]?.runs[widget.id]));
  const stored = useWorkbooks((s) => s.byTab[tabId]?.selections[widget.id]);
  const selection = effectiveSelection(widget.selection, stored);
  return (widget.tools ?? [])
    .filter((b) => b.placement === placement)
    .map((b, i) => {
      const target = toolTarget(b.runsOn, result?.rows ?? [], selection);
      const label = `${buttonName(b)} · ${target.count}`;
      const off = !result || target.rows.length === 0;
      return placement === 'header' ? (
        <button key={i} type="button" className="btn" disabled={off} onClick={() => onOpen(b)}>
          {label}
        </button>
      ) : (
        <button key={i} type="button" role="menuitem" tabIndex={-1} disabled={off} onClick={() => onOpen(b)}>
          {label}
        </button>
      );
    });
}

/** What a widget shows while it has no result: running, waiting, blocked, gone, or the error view. Null when it has one. */
/** `onSetUp`, in edit mode, opens the widget editor from a widget with no query yet; focus goes back to `opener` after. */
function runBody(tabId: string, widget: Widget, run: WidgetRun | undefined, onSignIn: () => void, onSetUp?: (opener: HTMLElement) => void): ReactNode {
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
      return (
        <div className="flex flex-col items-start gap-2 p-4 text-[12px]">
          <span className="faint">No query yet.</span>
          {onSetUp && (
            // The button is gone once the widget has a query: focus goes back to its grip.
            <button type="button" className="btn" onClick={(e) => onSetUp(e.currentTarget.closest('.wb-widget')?.querySelector<HTMLElement>('[data-wb-grip]') ?? e.currentTarget)}>
              Set up widget
            </button>
          )}
        </div>
      );
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
  const [clearing, setClearing] = useState(false);
  const [filter, setFilter] = useState<HistoryFilter>('open');
  const history = useHistory(tabId, widget, run ?? { state: 'idle' });
  const recording = useWorkbooks((s) => s.byTab[tabId]?.history[widget.id]);
  const selection = effectiveSelection(widget.selection, useWorkbooks((s) => s.byTab[tabId]?.selections[widget.id]));
  const tools = useToolRun(tabId, widget, setNotice);
  const ref = useRef<HTMLElement>(null);
  // The pointer gesture under way: what it does, where it started, the grid's measured column pitch, and `stop` removing its
  // window listeners; in a move, also another place under the pointer (`over`: what is outlined, its place key, and whether the
  // drop lands where the pointer is, in that grid, or at the bottom, for a tab name) and a hidden tab waiting to be shown.
  const gesture = useRef<{
    kind: Kind;
    x: number;
    y: number;
    column: number;
    stop: () => void;
    over?: { el: HTMLElement; place: string; at: boolean };
    hover?: { tab: HTMLElement; timer: ReturnType<typeof setTimeout> };
  } | null>(null);
  const [target, setTarget] = useState<WidgetLayout | null>(null);
  // The pointer is over another place's grid, which shows the drop instead of this one.
  const [away, setAway] = useState(false);
  // The ⋯ menu shows Move to…'s entries; it starts with its own each time it opens.
  const [moving, setMoving] = useState(false);
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

  // The rerun drops the history the widget showed.
  const clearHistory = () => {
    setClearing(false);
    call('history.clear', { workbookId: doc.id, widgetId: widget.id }).then(
      () => void useWorkbooks.getState().runWidget(tabId, widget.id, { refresh: true }),
      (e: unknown) => setNotice({ tone: 'bad', text: `Couldn’t clear history: ${errorText(e)}`, reportId: reportIdOf(e) }),
    );
  };

  const { edit } = useWorkbooks.getState();
  /** Ends the gesture under way, if any, leaving no listener, outline or timer behind. */
  function endGesture() {
    const g = gesture.current;
    gesture.current = null;
    g?.stop();
    clearTimeout(g?.hover?.timer);
    g?.over?.el.classList.remove('wb-drop');
    editing?.onPreview(null);
    setTarget(null);
    setAway(false);
  }
  /** In a move, follows the pointer across grids: outlines another place's grid under it, and shows a hidden tab hovered for
   * 500 ms. Over a tab name the place is that tab (its grid outlined if shown, else the tab); in a tab panel outside its grid,
   * that grid (R17). True when it is over another place. */
  const follow = (e: { clientX: number; clientY: number }) => {
    const g = gesture.current!;
    const under = document.elementFromPoint(e.clientX, e.clientY);
    const tab = under?.closest<HTMLElement>('[data-wb-tab]') ?? undefined;
    if (g.hover?.tab !== tab) {
      clearTimeout(g.hover?.timer);
      g.hover =
        tab && tab.getAttribute('aria-selected') !== 'true'
          ? { tab, timer: setTimeout(() => useWorkbooks.getState().showTab(tabId, tab.dataset.wbTabs!, tab.dataset.wbTab!), 500) }
          : undefined;
    }
    // A tabs widget's panel holds its shown tab's grid; another widget's result panel holds none.
    const gridIn = (panel: Element | null | undefined) => panel?.querySelector<HTMLElement>(':scope > [data-wb-place]') ?? undefined;
    const grid = gridIn(under?.closest('[role=tabpanel]')) ?? under?.closest<HTMLElement>('[data-wb-place]') ?? undefined;
    const place = tab ? placeKey({ tabs: tab.dataset.wbTabs!, tab: tab.dataset.wbTab! }) : grid?.dataset.wbPlace;
    const shownGrid = tab?.getAttribute('aria-selected') === 'true' ? gridIn(document.getElementById(tab.getAttribute('aria-controls') ?? '')) : undefined;
    const el = tab ? (shownGrid ?? tab) : grid;
    const over = el && place !== undefined && place !== placeKey(placeOf(widget)) ? { el, place, at: !tab } : undefined;
    if (g.over?.el !== over?.el) {
      g.over?.el.classList.remove('wb-drop');
      over?.el.classList.add('wb-drop');
    }
    g.over = over;
    return over !== undefined;
  };
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
    edit(tabId, (d) => ({ ...d, widgets: duplicateWidget(d.widgets, widget.id) ?? d.widgets }));
    editing?.announce(`Duplicated ${title}`);
  };
  /** Pointer handlers for the grip or a resize handle: moves by whole cells, with the drop target showing where it lands. A move
   * (of a widget other than a tabs widget, which stays at the top level) can also drop into another place's grid. */
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
      endGesture();
      const across = kind === 'move' && widget.type !== 'tabs';
      const id = e.pointerId;
      let armed = false;
      let last: string | null = null;
      const onMove = (m: globalThis.PointerEvent) => {
        if (m.pointerId !== id) {
          return;
        }
        // Released where no pointerup reached us (outside the window, after a tab shown mid-drag hid this widget).
        if (m.buttons === 0) {
          endGesture();
          return;
        }
        // Esc drops the drag once it has moved, so a press that doesn't move leaves Esc alone.
        if (!armed) {
          armed = true;
          window.addEventListener('keydown', onKey, true);
        }
        const s = steps(m);
        const off = across && follow(m);
        // Once per whole cell (or change of grid), not per pixel: each one redraws the grid.
        const key = s && `${s[0]},${s[1]},${off}`;
        if (s && key !== last) {
          last = key;
          const next = shifted(doc.widgets, widget.id, kind, s[0], s[1]);
          const at = next.find((w) => w.id === widget.id)?.layout ?? null;
          setAway(off);
          setTarget(at);
          // The others make way live, except around a tabs widget: pushed aside, it could never be dropped into.
          const onTabs = at && doc.widgets.some((w) => w.type === 'tabs' && w.id !== widget.id && placeKey(placeOf(w)) === placeKey(placeOf(widget)) && overlaps(w.layout, at));
          editing?.onPreview(off || onTabs ? null : next);
        }
      };
      const onUp = (u: globalThis.PointerEvent) => {
        if (u.pointerId !== id) {
          return;
        }
        const s = steps(u);
        const over = gesture.current?.over;
        endGesture();
        const to = over && destinations(doc.widgets).find((d) => placeKey(d.to) === over.place);
        if (over) {
          // No destination when its tab went mid-drag: nothing moves.
          if (!to) {
            return;
          }
          // Dropped on a tab name: at the bottom of that tab.
          const r = over.at ? over.el.getBoundingClientRect() : null;
          editing?.onMoveTo(
            to.to,
            r ? { x: Math.floor((u.clientX - r.left) / ((r.width + GAP_PX) / COLUMNS)), y: Math.floor((u.clientY - r.top) / (ROW_PX + GAP_PX)) } : undefined,
          );
        } else if (s && ref.current) {
          // Not when a tab shown mid-drag hid this widget: back over its home grid, that drop does nothing.
          commit(kind, s[0], s[1]);
        }
      };
      // Esc drops the drag: the widget stays where it was.
      const onKey = (k: KeyboardEvent) => {
        if (k.key === 'Escape') {
          k.preventDefault();
          k.stopPropagation();
          endGesture();
        }
      };
      // On the window, not the handle: showing a tab mid-drag can unmount this widget, and the drop must still land.
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', endGesture);
      const stop = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', endGesture);
        window.removeEventListener('keydown', onKey, true);
      };
      gesture.current = { kind, x: e.clientX, y: e.clientY, column: (grid.width + GAP_PX) / COLUMNS, stop };
      editing?.onSelect();
    },
    // Capture lost without a pointerup here (the window lost focus, say): drop the gesture rather than leave its target up.
    onLostPointerCapture: endGesture,
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

  // A table widget's selected rows that are shown, of those shown, and its header buttons (spec screen 5).
  // A tracked table's tools act on Open now only: the other filters show history rows, which a tool can't act on.
  const toolsOn = widget.type === 'table' && (filter === 'open' || widget.history?.mode !== 'rows' || !history.changes);
  const ok = toolsOn ? okResult(run) : null;
  const picked = ok ? toolTarget('selected', ok.rows, selection).rows.length : 0;
  const headerTools = toolsOn && (widget.tools ?? []).some((b) => b.placement === 'header');

  // The footer: how often it saves and for how long (from the first snapshot), why the last run wasn't kept, a reset file.
  const first = history.values?.snapshots[0]?.takenAt;
  const days = first === undefined ? null : daysSince(first, new Date(history.readAt ?? 0));

  const used = params.filter((p) => p.from === 'workbook').map((p) => p.name);

  const selected = editing?.selected ?? false;
  const shown = editing?.layout ?? widget.layout;
  // Off when the copy (a tabs widget's with its widgets) would pass MAX_WIDGETS.
  const canDuplicate = editing !== undefined && duplicateWidget(doc.widgets, widget.id) !== null;
  const bare = !editing && widget.hideTitle === true;
  const refreshTab = (
    <button type="button" role="menuitem" tabIndex={-1} onClick={() => void useWorkbooks.getState().refreshTab(tabId, widget.id)}>
      Refresh
    </button>
  );
  return (
    <>
      <section
        ref={ref}
        aria-label={title}
        style={cellVars(shown)}
        className={`card wb-widget flex min-h-0 min-w-0 flex-col ${selected ? 'border-accent' : ''} ${full ? 'wb-full fixed inset-0 z-20 rounded-none' : 'relative'}`}
        // Not for a widget inside this one (in a tabs widget): that one selects itself.
        onPointerDown={editing && ((e) => e.target instanceof Element && e.target.closest('.wb-widget') === e.currentTarget && editing.onSelect())}
      >
        {/* One row that never wraps (the title truncates, so it fits at the narrowest widget), then a row that wraps for the
            widget's own controls, and, in edit mode, its size; the workbook parameters it uses are a link icon in the corner. Edit mode's actions are ✎ and ⋯. */}
        <header hidden={bare} className="flex min-w-0 flex-col gap-1.5 px-3 py-2 text-[12.5px]">
          <div className="flex min-w-0 items-center gap-2">
            {editing && (
              <button
                type="button"
                className="wb-grip btn ghost"
                data-wb-grip={widget.id}
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
            <b className="min-w-0 flex-1 truncate" title={title}>
              {title}
            </b>
            {/* Opening ⋯ (its button's click) starts it with its own items, not Move to…'s. */}
            <div className="flex shrink-0 items-center gap-2" onClick={(e) => e.target instanceof Element && e.target.closest('[aria-haspopup]') && setMoving(false)}>
              {!editing && result && <span className="mono faint text-[11.5px]">{duration(result.durationMs)}</span>}
              {editing && (
                <button type="button" className="btn ghost" aria-label="Edit widget" title="Edit widget" onClick={(e) => editing.onEditWidget(e.currentTarget)}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M12 20h9" />
                    <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
                  </svg>
                </button>
              )}
              <MenuButton label={`${title} menu`} icon="⋯">
                {!moving && editing && (
                  <>
                    <button
                      type="button"
                      role="menuitem"
                      tabIndex={-1}
                      // Focus goes back to ⋯ when the editor closes: the item is gone by then.
                      onClick={(e) => editing.onEditWidget(e.currentTarget.closest('.relative')?.querySelector<HTMLElement>('[aria-haspopup]') ?? e.currentTarget)}
                    >
                      Edit widget
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      tabIndex={-1}
                      disabled={!canDuplicate}
                      title={canDuplicate ? undefined : `A workbook can have at most ${MAX_WIDGETS} widgets.`}
                      onClick={duplicate}
                    >
                      Duplicate
                    </button>
                    <button type="button" role="menuitem" tabIndex={-1} onClick={editing.onRemove}>
                      Remove
                    </button>
                  </>
                )}
                {moving && editing && <MoveToItems widgets={doc.widgets} here={placeKey(placeOf(widget))} onMove={(to) => editing.onMoveTo(to)} />}
                {!moving && widget.type === 'tabs' && refreshTab}
                {!moving && widget.query && (
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
                    {toolsOn && <ToolButtonItems tabId={tabId} widget={widget} placement="menu" onOpen={tools.open} />}
                  </>
                )}
                {!moving && widget.history && (
                  <button type="button" role="menuitem" tabIndex={-1} onClick={() => setClearing(true)}>
                    Clear history…
                  </button>
                )}
                {!moving && (
                  <button type="button" role="menuitem" tabIndex={-1} onClick={() => setFull(!full)}>
                    {full ? 'Exit full screen' : 'Full screen'}
                  </button>
                )}
                {!moving && editing && widget.type !== 'tabs' && (
                  <button type="button" role="menuitem" tabIndex={-1} data-keep-open onClick={() => setMoving(true)}>
                    Move to…
                  </button>
                )}
              </MenuButton>
            </div>
          </div>
          {(params.some((p) => p.from === 'widget') || editing || picked > 0 || headerTools) && (
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              {/* Edit mode's size sits here, not in the first row, so the title keeps room at the narrowest widget. */}
              {editing && (
                <span className="mono faint text-[11.5px]">
                  {shown.w} × {shown.h}
                </span>
              )}
              {params
                .filter((p) => p.from === 'widget')
                .map((p) => (
                  <ShownControl key={p.name} param={p} choices={choicesOf(live, p)} onChange={(v, now) => useWorkbooks.getState().setWidgetValue(tabId, widget.id, p.name, v, { now })} />
                ))}
              {/* In this wrapping row, not the first, so the title keeps room at the narrowest widget. */}
              {(picked > 0 || headerTools) && (
                <div className="ml-auto flex flex-wrap items-center gap-2">
                  {picked > 0 && (
                    <span className="faint text-[11.5px]">
                      {picked} of {selection.shown?.length ?? ok?.rows.length} selected
                    </span>
                  )}
                  <ToolButtonItems tabId={tabId} widget={widget} placement="header" onOpen={tools.open} />
                </div>
              )}
            </div>
          )}
        </header>
        {notice && <NoticeLine notice={notice} onDismiss={() => setNotice(null)} />}
        {/* A tabs widget without its title bar keeps ⋯ at the end of its tab bar. */}
        {bare && widget.type === 'tabs' && (
          <div className="absolute top-1 right-2">
            <MenuButton label={`${title} menu`} icon="⋯">
              {refreshTab}
              <button type="button" role="menuitem" tabIndex={-1} onClick={() => setFull(!full)}>
                {full ? 'Exit full screen' : 'Full screen'}
              </button>
            </MenuButton>
          </div>
        )}
        <div className={`flex min-h-0 flex-1 flex-col overflow-hidden ${bare && widget.type !== 'tabs' ? 'pt-3' : ''}`}>
          {(widget.query &&
            runBody(tabId, widget, run, onSignIn, editing?.onEditWidget)) ?? (
            <HistoryData.Provider value={{ ...history, filter, setFilter }}>
              {full ? <SheetHost.Provider value={null}>{children}</SheetHost.Provider> : children}
            </HistoryData.Provider>
          )}
        </div>
        {widget.history && (
          <footer className="faint flex flex-col gap-0.5 px-3 pb-2 text-[11.5px]">
            <span>
              {INTERVAL_TEXT[widget.history.interval]}
              {days !== null && ` · ${days} ${days === 1 ? 'day' : 'days'}`}
            </span>
            {recording?.skipped && <span className="text-warn">! {SKIP_TEXT[recording.skipped]}</span>}
            {recording?.error && <span className="text-warn">! Not recorded: {recording.error}</span>}
            {(recording?.reset || history.values?.reset || history.changes?.reset) && <span className="text-warn">History was reset: its file was damaged.</span>}
            {history.error && <span className="text-bad">Couldn’t read history: {history.error}</span>}
          </footer>
        )}
        {/* The workbook parameters it uses, named on hover: as words they took a small widget's room. Left of the resize corner. */}
        {used.length > 0 && (
          <span
            role="img"
            aria-label={`Uses workbook parameters ${used.join(', ')}`}
            title={`Uses workbook parameters: ${used.join(', ')}`}
            className={`faint absolute bottom-1.5 ${selected ? 'right-5' : 'right-2'} flex`}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1" />
              <path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1" />
            </svg>
          </span>
        )}
        {/* Pointer only; Shift+arrows on the grip resize from the keyboard. */}
        {selected && (
          <>
            <div className="wb-resize-right" aria-hidden="true" {...drag({ w: true, h: false })} />
            <div className="wb-resize-bottom" aria-hidden="true" {...drag({ w: false, h: true })} />
            <div className="wb-resize-corner" aria-hidden="true" {...drag({ w: true, h: true })} />
          </>
        )}
      </section>
      {target && !away && <div className="wb-widget wb-drop" style={cellVars(target)} aria-hidden="true" />}
      {/* Outside the widget's body, so a rerun's spinner doesn't unmount it (Review Focus 5). */}
      {tools.dialog}
      {clearing &&
        createPortal(
          <div className="fixed inset-0 z-20" onKeyDown={(e) => e.key === 'Escape' && setClearing(false)}>
            <div className="scrim" onClick={() => setClearing(false)} />
            <div className="card absolute inset-x-0 top-[20vh] mx-auto w-[360px] max-w-[calc(100vw-32px)] p-3">
              <ClearConfirm title="Clear this widget's history?" confirm="Clear" onConfirm={clearHistory} onCancel={() => setClearing(false)} />
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
