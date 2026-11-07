import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { call } from '../bridge';
import { useRevisions } from '../library/saving';
import { MenuButton } from '../results/result-grid';
import { runCommand } from '../shell/commands';
import { ErrorReportActions, type Shown } from '../shell/error-report';
import { errorText } from '../shell/errors';
import { exportWorkbook } from './sharing';
import { reportIdOf } from '../shell/report-id';
import { ConfirmDelete } from '../side/row-menu';
import { inSendDetails } from '../shell/send-details-marker';
import { SourceBadge } from '../tabs/source-badge';
import { useTabs } from '../tabs/tab-store';
import type { LibraryList, SavedQuery } from '../wire';
import { narrowOrder, place } from './layout';
import { MAX_WIDGETS, MIN_SIZE, newWidget, type Place, type Widget, type WidgetType, type WorkbookParameter } from './model';
import { huntingTimespanProblem, workbookValues } from './resolve';
import { ParametersDialog } from './parameters-dialog';
import { childrenOf, placeKey, placeOf, removeTabs, siblings } from './tabs';
import { ChildrenConfirm, TabsWidget } from './tabs-widget';
import { WidgetEditor } from './widget-editor';
import { WidgetGrid, type GridEditing } from './widget-grid';
import { ChartWidget } from './widgets/chart-widget';
import { MarkdownWidget } from './widgets/markdown-widget';
import { StatWidget } from './widgets/stat-widget';
import { SheetHost } from './widgets/sheet-host';
import { TableWidget } from './widgets/table-widget';
import { editRanWidgets, editStartDoc, readLibrary, useWorkbooks, visibleTab } from './workbook-store';

const ALL = '\u0000all';

/** A workbook parameter's control in the bar: a select for one with choices (a list's takes several values, one per line, when `multi`;
 * `all` adds "All", which picks every choice), else a text box. Text reruns as typing stops, or at once on Enter. */
function ParamControl({ tabId, param, value }: { tabId: string; param: WorkbookParameter; value: string }) {
  const set = (v: string, now = true) => useWorkbooks.getState().setWorkbookValue(tabId, param.name, v, { now });
  const label = param.label ?? param.name;
  // Choices make a select for any type, as in a query tab; several values and All are a list's only.
  const choices = (param.choices ?? []).filter((c) => c.trim() !== '');
  const list = param.type === 'list';
  let control;
  if (choices.length > 0 && list && param.multi) {
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
    const options = [...(list && param.all ? [{ value: all, text: 'All' }] : []), ...choices.map((c) => ({ value: c, text: c }))];
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
  // A hunting timespan that can't be sent says so here, where it's fixed, as well as on the widgets it stops.
  const problem = param.huntingTimespan ? huntingTimespanProblem(label, value) : null;
  return (
    <label className="flex items-center gap-2 text-[12.5px]">
      <span className="muted">{label}</span>
      {control}
      {problem && (
        <span role="alert" className="text-[12px] text-bad">
          {problem}
        </span>
      )}
    </label>
  );
}

const ADDABLE: [WidgetType, string][] = [
  ['markdown', 'Markdown'],
  ['chart', 'Chart'],
  ['table', 'Table'],
  ['stat', 'Stat'],
  ['tabs', 'Tabs'],
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

  // Focus starts inside, so Esc closes it before the list has loaded (or when it's empty); the first query takes it on load.
  useEffect(() => dialogRef.current?.querySelector<HTMLElement>('button')?.focus(), []);
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
export function WorkbookView({ tabId, onSignIn }: { tabId: string; onSignIn?: () => void }) {
  const state = useWorkbooks((s) => s.byTab[tabId]);
  const savedId = useTabs((s) => s.tabs.find((t) => t.id === tabId)?.savedId);
  const [deleting, setDeleting] = useState(false);
  const [problem, setProblem] = useState<Shown | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  // The tab grid (clicked in edit mode) new widgets go into; null is the top level.
  const [selectedPlace, setSelectedPlace] = useState<Place | null>(null);
  // Each announcement is a fresh node (n), so saying the same thing twice is heard twice.
  const [said, setSaid] = useState({ text: '', n: 0 });
  const say = (text: string) => setSaid((s) => ({ text, n: s.n + 1 }));
  const [picking, setPicking] = useState(false);
  // A tabs widget with widgets being removed: the confirm asks what happens to them.
  const [removingTabs, setRemovingTabs] = useState<{ widget: Widget; count: number } | null>(null);
  // The widget open in the widget editor, and the Edit widget control focus goes back to when it closes.
  const [editingWidget, setEditingWidget] = useState<{ id: string; opener: HTMLElement } | null>(null);
  const [parametersOpen, setParametersOpen] = useState(false);
  const parametersRef = useRef<HTMLButtonElement>(null);
  const editRef = useRef<HTMLButtonElement>(null);
  const editingBar = useRef<HTMLDivElement>(null);
  const undoRef = useRef<HTMLButtonElement>(null);
  // Table widgets open their row details here, over the whole workbook, as a query tab's results do.
  const [sheetHost, setSheetHost] = useState<HTMLDivElement | null>(null);
  // Where focus goes once the next render is in (the toolbar swaps, a removed grip unmounts, Undo enables).
  const focusNext = useRef<(() => HTMLElement | null | undefined) | null>(null);
  useEffect(() => {
    const target = focusNext.current?.();
    focusNext.current = null;
    target?.focus();
  });
  if (!state) {
    return <p className="faint m-0 p-4 text-[12px]">Opening the workbook…</p>;
  }
  const { doc, values, runs, editing } = state;
  const full = doc.widgets.length >= MAX_WIDGETS;
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
    const tab = widget.in && doc.widgets.find((w) => w.id === widget.in?.tabs)?.tabs?.find((t) => t.id === widget.in?.tab);
    say(`Added ${what}${tab ? ` to ${tab.name}` : ''} at column ${widget.layout.x + 1}, row ${widget.layout.y + 1}`);
  };
  // Into the selected tab while it's the one shown; a tabs widget always goes to the top level.
  const into = (type: WidgetType) => (type !== 'tabs' && selectedPlace && visibleTab(state, selectedPlace.tabs) === selectedPlace.tab ? selectedPlace : null);
  const placed = (type: WidgetType) => {
    const at = into(type);
    const min = MIN_SIZE[type];
    const w = newWidget(type, place(siblings(doc.widgets, at), min.w, min.h * 2));
    return at ? { ...w, in: at } : w;
  };
  const addNew = (type: WidgetType, name: string) => add(placed(type), `a ${name} widget`);
  // The picker opens from + Add widget, the editing bar's first button; focus goes back there when it closes.
  const closePicker = () => {
    setPicking(false);
    focusNext.current = () => editingBar.current?.querySelector('button');
  };
  const addSaved = (q: SavedQuery) => {
    closePicker();
    if (q.source === 'raw') {
      return;
    }
    const widget = placed('table');
    widget.title = q.name;
    widget.query = { source: q.source, text: q.text, options: q.options ?? null, parameters: q.parameters, saved: { id: q.id, name: q.name } };
    add(widget, q.name);
  };
  const startEditing = () => {
    store().setEditing(tabId, true);
    focusNext.current = () => editingBar.current?.querySelector('button');
    say('Editing the workbook');
  };
  const leave = (discard: boolean) => {
    const start = editStartDoc(tabId);
    const ran = editRanWidgets(tabId);
    setSelected(null);
    setSelectedPlace(null);
    store().setEditing(tabId, false, discard);
    focusNext.current = () => editRef.current;
    say(discard ? 'Changes discarded' : 'Done editing');
    const now = store().byTab[tabId]?.doc;
    // Edits don't rerun widgets (the store's ruling); Done reruns once if the doc changed. Back at the starting doc (a discard,
    // or undone all the way), a widget run on a draft reruns, so it doesn't keep that draft's rows.
    if (discard || !start || !now || start === now) {
      for (const id of ran) {
        void store().runWidget(tabId, id);
      }
      return;
    }
    // A saved query linked since editing began may be newer than the tab's copy of the library.
    const known = new Set(start.widgets.map((w) => w.query?.saved?.id));
    const linked = now.widgets.some((w) => w.query?.saved && !known.has(w.query.saved.id));
    if (linked) {
      void readLibrary(tabId).then(() => store().runAll(tabId));
    } else {
      void store().runAll(tabId);
    }
  };
  /** Removes `w`; a tabs widget's widgets are moved to the top level or deleted too, as asked when it has any. */
  const removeWidget = (w: Widget, children?: 'move' | 'delete') => {
    setRemovingTabs(null);
    const count = w.type === 'tabs' ? childrenOf(doc.widgets, w.id).length : 0;
    if (count > 0 && !children) {
      setRemovingTabs({ widget: w, count });
      return;
    }
    // Grips are in the widget's grid's (y, x) order; focus the next one, else the previous, else Undo.
    const grid = sheetHost?.querySelector(`[data-wb-place="${placeKey(placeOf(w))}"]`);
    const grips = [...(grid?.querySelectorAll<HTMLElement>(':scope > .wb-widget > header .wb-grip') ?? [])];
    const at = narrowOrder(siblings(doc.widgets, placeOf(w))).findIndex((x) => x.id === w.id);
    const next = grips[at + 1] ?? grips[at - 1];
    store().edit(tabId, (d) => ({ ...d, widgets: w.type === 'tabs' ? removeTabs(d.widgets, w.id, children ?? 'move') : d.widgets.filter((x) => x.id !== w.id) }));
    focusNext.current = () => next ?? undoRef.current;
    say(`Removed ${w.title || 'Untitled widget'}`);
  };
  const undo = () => {
    store().undoEdit(tabId);
    say('Undone');
  };
  const redo = () => {
    store().redoEdit(tabId);
    say('Redone');
  };
  const onKey = (e: KeyboardEvent) => {
    if (!editing || editingWidget || parametersOpen || picking || !(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z' || inTextField(e.target)) {
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
        return <MarkdownWidget text={w.markdown ?? ''} values={workbookValues(doc, values)} />;
      case 'chart':
        return <ChartWidget widget={w} run={run} />;
      case 'table':
        return <TableWidget widget={w} run={run} tabId={tabId} />;
      case 'stat':
        return <StatWidget widget={w} run={run} tabId={tabId} />;
      case 'tabs':
        return <TabsWidget tabId={tabId} widget={w} editing={gridEditing} body={body} onSignIn={onSignIn} />;
    }
  };
  const gridEditing: GridEditing | undefined = editing
    ? {
        selected,
        onSelect: (w) => {
          setSelected(w.id);
          setSelectedPlace(null);
        },
        onEditWidget: (w, opener) => setEditingWidget({ id: w.id, opener }),
        onRemove: removeWidget,
        announce: say,
        selectedPlace,
        onSelectPlace: setSelectedPlace,
      }
    : undefined;

  return (
    <div ref={setSheetHost} className="relative flex min-h-0 flex-1 flex-col" onKeyDown={onKey}>
      {editing ? (
        <div ref={editingBar} className="toolbar" role="group" aria-label="Editing the workbook">
          <span className="chip warn">EDITING</span>
          <h1 className="m-0 truncate text-[14px] font-semibold">{doc.name}</h1>
          <div className="grow" />
          <MenuButton label="Add widget" text="+ Add widget">
            {full && <p className="faint m-0 max-w-56 px-2.5 py-1.5 text-[12px]">A workbook can have at most {MAX_WIDGETS} widgets.</p>}
            {ADDABLE.map(([type, name]) => (
              <button key={type} type="button" role="menuitem" tabIndex={-1} disabled={full} onClick={() => addNew(type, name)}>
                {name}
              </button>
            ))}
            <button type="button" role="menuitem" tabIndex={-1} disabled={full} onClick={() => setPicking(true)}>
              From a saved query…
            </button>
          </MenuButton>
          <button ref={parametersRef} type="button" className="btn" onClick={() => setParametersOpen(true)}>
            Parameters
          </button>
          <button ref={undoRef} type="button" className="btn ghost" disabled={state.undo.length === 0} onClick={undo}>
            Undo
          </button>
          <button type="button" className="btn ghost" disabled={state.redo.length === 0} onClick={redo}>
            Redo
          </button>
          <button type="button" className="btn ghost" onClick={() => leave(true)}>
            Discard
          </button>
          <button type="button" className="btn primary" onClick={() => leave(false)}>
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
          <button ref={editRef} type="button" className="btn" onClick={startEditing}>
            Edit
          </button>
          <MenuButton label="Workbook menu" icon="⋯">
            <button type="button" role="menuitem" tabIndex={-1} onClick={() => runCommand('file.save')}>
              Save
            </button>
            <button type="button" role="menuitem" tabIndex={-1} onClick={() => store().saveValuesAsDefaults(tabId)}>
              Save current values as defaults
            </button>
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              onClick={() =>
                exportWorkbook(tabId).catch((e: unknown) => setProblem({ text: `The workbook couldn’t be exported: ${errorText(e)}`, reportId: reportIdOf(e) }))
              }
            >
              Export…
            </button>
            <button type="button" role="menuitem" tabIndex={-1} disabled={!savedId} onClick={() => setDeleting(true)}>
              Delete
            </button>
          </MenuButton>
        </div>
      )}
      <p className="wb-announce sr-only" aria-live="polite">
        <span key={said.n}>{said.text}</span>
      </p>
      {/* The dialogs go on the body: a glass theme's workspace (backdrop-filter) would hold a fixed overlay inside it and leave
          the tab strip clickable. React events still come up through this tree, so onKey sees them. */}
      {removingTabs && (
        <ChildrenConfirm
          question={`Remove ${removingTabs.widget.title || 'Tabs'}?`}
          count={removingTabs.count}
          move="Move widgets to the top level"
          onChoose={(children) => removeWidget(removingTabs.widget, children)}
          onCancel={() => setRemovingTabs(null)}
        />
      )}
      {editingWidget &&
        createPortal(
          <WidgetEditor
            tabId={tabId}
            widgetId={editingWidget.id}
            onClose={() => {
              focusNext.current = () => editingWidget.opener;
              setEditingWidget(null);
            }}
          />,
          document.body,
        )}
      {parametersOpen &&
        createPortal(
          <ParametersDialog
            tabId={tabId}
            onClose={() => {
              focusNext.current = () => parametersRef.current;
              setParametersOpen(false);
            }}
          />,
          document.body,
        )}
      {picking && createPortal(<SavedQueryPicker onPick={addSaved} onClose={closePicker} />, document.body)}
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
      <SheetHost.Provider value={sheetHost}>
        <div className="wb-canvas min-h-0 flex-1 overflow-auto p-3">
          {doc.widgets.length === 0 && !editing ? (
            <p className="faint m-0 text-[12px]">No widgets yet. Edit the workbook to add some.</p>
          ) : (
            <WidgetGrid tabId={tabId} place={null} editing={gridEditing} body={body} onSignIn={onSignIn} />
          )}
        </div>
      </SheetHost.Provider>
    </div>
  );
}
