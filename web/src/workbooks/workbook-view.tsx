import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { call } from '../bridge';
import { useRevisions } from '../library/saving';
import { MenuButton } from '../results/result-grid';
import { runCommand } from '../shell/commands';
import { ErrorReportActions, type Shown } from '../shell/error-report';
import { errorText } from '../shell/errors';
import { reportIdOf } from '../shell/report-id';
import { ConfirmDelete } from '../side/row-menu';
import { inSendDetails } from '../shell/send-details-marker';
import { SourceBadge } from '../tabs/source-badge';
import { useTabs } from '../tabs/tab-store';
import type { LibraryList, SavedQuery } from '../wire';
import { narrowOrder, place } from './layout';
import { MIN_SIZE, newWidget, type Widget, type WidgetType, type WorkbookDoc, type WorkbookParameter } from './model';
import { WidgetFrame } from './widget-frame';
import { ChartWidget } from './widgets/chart-widget';
import { MarkdownWidget } from './widgets/markdown-widget';
import { StatWidget } from './widgets/stat-widget';
import { TableWidget } from './widgets/table-widget';
import { useWorkbooks } from './workbook-store';

const ALL = '\u0000all';

/** A workbook parameter's control in the bar: a select for a list with choices (several values, one per line, when `multi`;
 * `all` adds "All", which picks every choice), else a text box. Text reruns as typing stops, or at once on Enter. */
function ParamControl({ tabId, param, value }: { tabId: string; param: WorkbookParameter; value: string }) {
  const set = (v: string, now = true) => useWorkbooks.getState().setWorkbookValue(tabId, param.name, v, { now });
  const label = param.label ?? param.name;
  const choices = param.type === 'list' ? (param.choices ?? []).filter((c) => c.trim() !== '') : [];
  let control;
  if (choices.length > 0 && param.multi) {
    control = (
      <select
        multiple
        className="textbox mono h-auto py-1"
        aria-label={label}
        value={value.split('\n')}
        onChange={(e) => {
          const picked = [...e.target.selectedOptions].map((o) => o.value);
          set((picked.includes(ALL) ? choices : picked).join('\n'));
        }}
      >
        {param.all && <option value={ALL}>All</option>}
        {choices.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>
    );
  } else if (choices.length > 0) {
    const all = choices.join('\n');
    const options = [...(param.all ? [{ value: all, text: 'All' }] : []), ...choices.map((c) => ({ value: c, text: c }))];
    control = (
      <select className="textbox mono" style={{ height: 28 }} aria-label={label} value={value} onChange={(e) => set(e.target.value)}>
        {!options.some((o) => o.value === value) && <option value={value}>{value === '' ? '(none)' : value}</option>}
        {options.map((o) => (
          <option key={o.text} value={o.value}>
            {o.text}
          </option>
        ))}
      </select>
    );
  } else {
    control = (
      <input
        className="textbox mono w-40"
        style={{ height: 28 }}
        aria-label={label}
        value={value}
        onChange={(e) => set(e.target.value, false)}
        onKeyDown={(e) => e.key === 'Enter' && set(e.currentTarget.value)}
      />
    );
  }
  return (
    <label className="flex items-center gap-2 text-[12.5px]">
      <span className="muted">{label}</span>
      {control}
    </label>
  );
}

const ADDABLE: [WidgetType, string][] = [
  ['markdown', 'Markdown'],
  ['chart', 'Chart'],
  ['table', 'Table'],
  ['stat', 'Stat'],
];

/** "From a saved query…": the library's saved queries (a raw request can't run in a widget), to pick one to link. */
function SavedQueryPicker({ onPick, onClose }: { onPick: (q: SavedQuery) => void; onClose: () => void }) {
  const [queries, setQueries] = useState<SavedQuery[] | null>(null);
  const [problem, setProblem] = useState<Shown | null>(null);
  const id = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const closing = useRef(false);
  const close = () => {
    closing.current = true;
    onClose();
  };

  useEffect(() => {
    let live = true;
    call<LibraryList>('library.list').then(
      (l) => live && setQueries(l.queries.filter((q) => q.source !== 'raw')),
      (e: unknown) => live && setProblem({ text: `Saved queries couldn’t be loaded: ${errorText(e)}`, reportId: reportIdOf(e) }),
    );
    return () => {
      live = false;
    };
  }, []);

  // A modal, as the save dialog is: focus that lands outside it goes back to it.
  useEffect(() => {
    const onFocusIn = (e: FocusEvent) => {
      if (!closing.current && !inSendDetails(e.target) && (!(e.target instanceof Node) || !dialogRef.current?.contains(e.target))) {
        dialogRef.current?.querySelector<HTMLElement>('button')?.focus();
      }
    };
    document.addEventListener('focusin', onFocusIn);
    return () => document.removeEventListener('focusin', onFocusIn);
  }, []);

  return (
    <div className="fixed inset-0 z-20">
      <div className="scrim" onClick={close} />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        className="card absolute top-1/4 left-1/2 flex max-h-[60vh] w-[440px] max-w-[calc(100vw-32px)] -translate-x-1/2 flex-col gap-3 p-5"
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            close();
          }
        }}
      >
        <b id={`${id}-title`} className="text-[14px]">
          Add a saved query
        </b>
        {problem ? (
          <span role="alert" className="text-[12px] text-bad">
            {problem.text}
            <ErrorReportActions reportId={problem.reportId} uiSections={{ message: problem.text }} />
          </span>
        ) : !queries ? (
          <span className="faint text-[12px]">Loading saved queries…</span>
        ) : queries.length === 0 ? (
          <span className="faint text-[12px]">No saved queries yet.</span>
        ) : (
          <div className="flex min-h-0 flex-col gap-1 overflow-auto">
            {queries.map((q, i) => (
              <button key={q.id} type="button" className="btn ghost justify-start gap-2" autoFocus={i === 0} onClick={() => onPick(q)}>
                <SourceBadge source={q.source} />
                <span className="truncate">{q.name}</span>
                {q.folder && <span className="faint text-[12px]">{q.folder}</span>}
              </button>
            ))}
          </div>
        )}
        <div className="flex justify-end">
          <button type="button" className="btn ghost" onClick={close}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

/** Ctrl/⌘+Z and Ctrl/⌘+Shift+Z are the workbook's own except in a text field, which keeps its native undo. */
function inTextField(target: EventTarget) {
  return target instanceof HTMLElement && (target.matches('input, textarea, select') || target.isContentEditable || !!target.closest('.monaco-editor'));
}

/** "Updated 12 s ago": since the last widget run ended, ticking each second. */
function Updated({ at }: { at: number }) {
  const [now, setNow] = useState(at);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const s = Math.max(0, Math.round((now - at) / 1000));
  return <span className="faint text-[12px]">Updated {s < 60 ? `${s} s` : `${Math.floor(s / 60)} min`} ago</span>;
}

/**
 * A workbook tab in view mode (spec 5.3, screen 1): the toolbar (name, folder, when it last updated, Refresh all, Edit, and
 * ⋯ with Save, Save current values as defaults and Delete), the parameter bar, and the widgets on the 12-column grid, which
 * stacks them full width in (y, x) order when narrow (`.wb-grid`). Edit swaps in the EDITING toolbar (spec 5.2, screen 2):
 * + Add widget, Parameters, Undo, Redo, Discard and Done.
 */
export function WorkbookView({
  tabId,
  onSignIn,
  onEditWidget = () => undefined,
  onParameters = () => undefined,
}: {
  tabId: string;
  onSignIn?: () => void;
  /** Edit mode's Edit widget, by the widget's id (Ruling R4: the widget editor comes with Task 13). */
  onEditWidget?: (widgetId: string) => void;
  /** Edit mode's Parameters (Ruling R4: the parameters dialog comes with Task 14). */
  onParameters?: () => void;
}) {
  const state = useWorkbooks((s) => s.byTab[tabId]);
  const savedId = useTabs((s) => s.tabs.find((t) => t.id === tabId)?.savedId);
  const [deleting, setDeleting] = useState(false);
  const [problem, setProblem] = useState<Shown | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [said, setSaid] = useState('');
  const [picking, setPicking] = useState(false);
  // The doc when Edit was pressed, and whether a saved query was linked since. Null after a remount: Done then reruns.
  const editStart = useRef<{ doc: WorkbookDoc; linked: boolean } | null>(null);
  if (!state) {
    return <p className="faint m-0 p-4 text-[12px]">Opening the workbook…</p>;
  }
  const { doc, values, runs, editing, viewCharts } = state;
  const store = useWorkbooks.getState;
  const updatedAt = Math.max(0, ...Object.values(runs).map((r) => (r.state === 'done' || r.state === 'failed' ? (r.finishedAt ?? 0) : 0)));

  const remove = () => {
    setDeleting(false);
    if (!savedId) {
      return;
    }
    call('workbook.delete', { id: savedId }).then(
      () => {
        useRevisions.getState().bump('library');
        useTabs.getState().close(tabId);
      },
      (e: unknown) => setProblem({ text: `It couldn’t be deleted: ${errorText(e)}`, reportId: reportIdOf(e) }),
    );
  };

  const add = (widget: Widget, what: string) => {
    store().edit(tabId, (d) => ({ ...d, widgets: [...d.widgets, widget] }));
    setSelected(widget.id);
    setSaid(`Added ${what} at column ${widget.layout.x + 1}, row ${widget.layout.y + 1}`);
  };
  const addNew = (type: WidgetType, name: string) => {
    const min = MIN_SIZE[type];
    add(newWidget(type, place(doc.widgets, min.w, min.h * 2)), `a ${name} widget`);
  };
  const addSaved = (q: SavedQuery) => {
    setPicking(false);
    if (q.source === 'raw') {
      return;
    }
    const min = MIN_SIZE.table;
    const widget = newWidget('table', place(doc.widgets, min.w, min.h * 2));
    widget.title = q.name;
    widget.query = { source: q.source, text: q.text, options: q.options ?? null, parameters: q.parameters, saved: { id: q.id, name: q.name } };
    if (editStart.current) {
      editStart.current.linked = true;
    }
    add(widget, q.name);
  };
  const startEditing = () => {
    editStart.current = { doc, linked: false };
    store().setEditing(tabId, true);
  };
  const done = () => {
    const start = editStart.current;
    editStart.current = null;
    setSelected(null);
    store().setEditing(tabId, false);
    // Edits don't rerun widgets (the store's ruling); Done reruns once if anything changed. A new link needs the library re-read.
    if (!start || start.linked) {
      void store().runAll(tabId, { refresh: true });
    } else if (start.doc !== store().byTab[tabId]?.doc) {
      void store().runAll(tabId);
    }
  };
  const discard = () => {
    editStart.current = null;
    setSelected(null);
    store().setEditing(tabId, false, true);
  };
  const undo = () => {
    store().undoEdit(tabId);
    setSaid('Undone');
  };
  const redo = () => {
    store().redoEdit(tabId);
    setSaid('Redone');
  };
  const onKey = (e: KeyboardEvent) => {
    if (!editing || !(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z' || inTextField(e.target)) {
      return;
    }
    e.preventDefault();
    if (e.shiftKey) {
      redo();
    } else {
      undo();
    }
  };

  const body = (w: Widget) => {
    const run = runs[w.id] ?? { state: 'idle' };
    switch (w.type) {
      case 'markdown':
        return <MarkdownWidget text={w.markdown ?? ''} values={values.workbook} />;
      case 'chart':
        return (
          <ChartWidget
            widget={w}
            run={run}
            picked={viewCharts[w.id] ?? w.chart ?? {}}
            // Ruling R3: a pick outside edit mode is view state; in edit mode it is the widget's.
            onChart={(picked) =>
              editing
                ? store().edit(tabId, (d) => ({ ...d, widgets: d.widgets.map((x) => (x.id === w.id ? { ...x, chart: picked } : x)) }))
                : store().setViewChart(tabId, w.id, picked)
            }
          />
        );
      case 'table':
        return <TableWidget widget={w} run={run} />;
      case 'stat':
        return <StatWidget widget={w} run={run} />;
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col" onKeyDown={onKey}>
      {editing ? (
        <div className="toolbar" role="group" aria-label="Editing the workbook">
          <span className="chip warn">EDITING</span>
          <h1 className="m-0 truncate text-[14px] font-semibold">{doc.name}</h1>
          <div className="grow" />
          <MenuButton label="Add widget" text="+ Add widget">
            {ADDABLE.map(([type, name]) => (
              <button key={type} type="button" role="menuitem" tabIndex={-1} onClick={() => addNew(type, name)}>
                {name}
              </button>
            ))}
            <button type="button" role="menuitem" tabIndex={-1} onClick={() => setPicking(true)}>
              From a saved query…
            </button>
          </MenuButton>
          <button type="button" className="btn" onClick={onParameters}>
            Parameters
          </button>
          <button type="button" className="btn ghost" disabled={state.undo.length === 0} onClick={undo}>
            Undo
          </button>
          <button type="button" className="btn ghost" disabled={state.redo.length === 0} onClick={redo}>
            Redo
          </button>
          <button type="button" className="btn ghost" onClick={discard}>
            Discard
          </button>
          <button type="button" className="btn primary" onClick={done}>
            Done
          </button>
        </div>
      ) : (
        <div className="toolbar">
          <h1 className="m-0 truncate text-[14px] font-semibold">{doc.name}</h1>
          {doc.folder && <span className="muted text-[12px]">{doc.folder}</span>}
          {updatedAt > 0 && <Updated key={updatedAt} at={updatedAt} />}
          <div className="grow" />
          <button type="button" className="btn" onClick={() => void store().runAll(tabId, { refresh: true })}>
            Refresh all
          </button>
          <button type="button" className="btn" onClick={startEditing}>
            Edit
          </button>
          <MenuButton label="Workbook menu" icon="⋯">
            <button type="button" role="menuitem" tabIndex={-1} onClick={() => runCommand('file.save')}>
              Save
            </button>
            <button type="button" role="menuitem" tabIndex={-1} onClick={() => store().saveValuesAsDefaults(tabId)}>
              Save current values as defaults
            </button>
            <button type="button" role="menuitem" tabIndex={-1} disabled={!savedId} onClick={() => setDeleting(true)}>
              Delete
            </button>
          </MenuButton>
        </div>
      )}
      <p className="wb-announce sr-only" aria-live="polite">
        {said}
      </p>
      {picking && <SavedQueryPicker onPick={addSaved} onClose={() => setPicking(false)} />}
      {deleting && <ConfirmDelete name={doc.name} onDelete={remove} onCancel={() => setDeleting(false)} />}
      {problem && (
        <p className="m-0 flex items-center gap-2 px-3 py-1.5 text-[12px] text-bad" role="alert">
          {problem.text}
          <ErrorReportActions reportId={problem.reportId} uiSections={{ message: problem.text }} />
        </p>
      )}
      {doc.parameters.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-3 py-2" role="group" aria-label="Workbook parameters">
          {doc.parameters.map((p) => (
            <ParamControl key={p.name} tabId={tabId} param={p} value={values.workbook[p.name] ?? p.value} />
          ))}
        </div>
      )}
      <div className="wb-canvas min-h-0 flex-1 overflow-auto p-3">
        {doc.widgets.length === 0 && !editing ? (
          <p className="faint m-0 text-[12px]">No widgets yet. Edit the workbook to add some.</p>
        ) : (
          <div className={editing ? 'wb-grid wb-editing' : 'wb-grid'}>
            {narrowOrder(doc.widgets).map((w) => (
              <WidgetFrame
                key={w.id}
                tabId={tabId}
                widget={w}
                onSignIn={onSignIn}
                editing={
                  editing
                    ? { selected: selected === w.id, onSelect: () => setSelected(w.id), onEditWidget: () => onEditWidget(w.id), announce: setSaid }
                    : undefined
                }
              >
                {body(w)}
              </WidgetFrame>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
