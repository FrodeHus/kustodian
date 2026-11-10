import type { StoreApi, UseBoundStore } from 'zustand';
import { create } from 'zustand';
import { call } from '../bridge';
import { useRevisions } from '../library/saving';
import { errorText } from '../shell/errors';
import { newId } from '../shell/ids';
import { useTabs } from '../tabs/tab-store';
import type {
  HistoryQuery,
  HistoryRecordAnswer,
  HistoryRecordParams,
  LibraryList,
  QueryRunParams,
  RunResult,
  SavedQuery,
  Source,
} from '../wire';
import { historyRows, historySetting, recordable, seriesLabel } from './history';
import type { SkipReason } from './history';
import type { Widget, WorkbookDoc } from './model';
import { parseWorkbook, withFileVersion } from './model';
import type { ResolvedParam, ViewValues } from './resolve';
import { initialValues, missingRequired, toParameterValues, widgetParams, widgetRunOptions, widgetsUsing } from './resolve';
import type { RowSelection } from './tool-buttons';

export type WidgetRun =
  | { state: 'idle' }
  | { state: 'waiting' }
  | { state: 'running'; runId: string; startedAt: number }
  | { state: 'done'; result: RunResult; finishedAt?: number }
  | { state: 'blocked'; reason: string } // a required value is missing, or widgetRunOptions gave a problem
  | { state: 'gone' } // the linked saved query no longer exists
  | { state: 'failed'; error: unknown; finishedAt?: number };

export interface WorkbookState {
  doc: WorkbookDoc;
  values: ViewValues;
  runs: Record<string, WidgetRun>;
  editing: boolean;
  undo: WorkbookDoc[];
  redo: WorkbookDoc[];
  /** The doc differs from the file (Ruling R1); {@link startWorkbookTabs} mirrors it into the tab. */
  dirty: boolean;
  /** Chosen rows and the order the grid shows them, by widget id: view state, never in the doc. */
  selections: Record<string, RowSelection>;
  /** What recording did on each history widget's last answer, by widget id: view state, never in the doc. */
  history: Record<string, WidgetHistoryState>;
  /** The "since" each widget's history view chose, by widget id: view state, never in the doc. */
  since: Record<string, string>;
  /** The tab each tabs widget shows, by widget id: view state, never in the doc; a missing entry means the first tab. */
  activeTabs: Record<string, string>;
  /** Widgets (on tabs not shown) whose shown result is out of date, by widget id: view state, never in the doc. */
  stale: Record<string, true>;
  /** The parameter bar is folded to a line of its values: view state, never in the doc. */
  paramsCollapsed?: true;
}

/** The tab a tabs widget shows: the active one if it still exists, else the first. */
export function visibleTab(s: WorkbookState, tabsId: string): string | undefined {
  const tabs = s.doc.widgets.find((w) => w.id === tabsId)?.tabs;
  const active = s.activeTabs[tabsId];
  return tabs?.some((t) => t.id === active) ? active : tabs?.[0]?.id;
}

/** A widget at the top level, or on the tab its tabs widget shows. */
export const isVisible = (s: WorkbookState, w: Widget): boolean => !w.in || visibleTab(s, w.in.tabs) === w.in.tab;

export interface WidgetHistoryState {
  skipped: SkipReason | null;
  /** The history file was damaged and replaced; stays true for the session. */
  reset: boolean;
  recordedAt: number | null;
  /** Why the last record failed, for the widget's footer only: never logged or reported. */
  error?: string;
  /** What the last answered run sent: the widget reads its history by it, so it reads the series the record wrote. */
  query: HistoryQuery;
  /** Records sent and not yet answered: history is read once they settle, not before and again after. */
  pending?: number;
}

export interface WorkbookActions {
  load(tabId: string, doc: WorkbookDoc, opts?: { dirty?: boolean }): Promise<void>; // reads remembered values and the library, then runAll
  unload(tabId: string): void; // cancels its runs
  runWidget(tabId: string, widgetId: string, opts?: { refresh?: boolean }): Promise<void>;
  /** Runs a draft of a widget (the widget editor's preview) as `runWidget` would, under the run tab id `tab/preview`; only the
   * latest call answers, the others reject. Rejects with the reason when it can't run. Its result isn't kept in `runs`. */
  runDraft(tabId: string, widget: Widget): Promise<RunResult>;
  /** Runs the visible data widgets; hidden ones that ran are marked stale. */
  runAll(tabId: string, opts?: { refresh?: boolean }): Promise<void>;
  /** Shows a tab of a tabs widget and runs its widgets that haven't run or are stale. `tabId` is the workbook's tab. */
  showTab(tabId: string, tabsId: string, tab: string): void;
  /** Reruns the visible tab of a tabs widget, as Refresh does. */
  refreshTab(tabId: string, tabsId: string): Promise<void>;
  setWorkbookValue(tabId: string, name: string, value: string, opts?: { now?: boolean }): void; // reruns widgetsUsing; a value typed (no choices) is debounced unless now
  setWidgetValue(tabId: string, widgetId: string, name: string, value: string, opts?: { now?: boolean }): void; // reruns that widget, debounced unless now
  edit(tabId: string, change: (doc: WorkbookDoc) => WorkbookDoc): void; // pushes undo, marks the tab dirty
  undoEdit(tabId: string): void;
  redoEdit(tabId: string): void;
  setEditing(tabId: string, editing: boolean, discard?: boolean): void;
  saveValuesAsDefaults(tabId: string): void;
  copySavedIntoWidget(tabId: string, widgetId: string): void;
  /** The workbook was saved as `doc`. */
  markSaved(tabId: string, doc: WorkbookDoc): void;
  markUnsaved(tabId: string): void; // its file was deleted: dirty, also after a discard
  setSelection(tabId: string, widgetId: string, selected: number[]): void;
  setShown(tabId: string, widgetId: string, shown: number[]): void; // no state change when equal to the current one
  setSince(tabId: string, widgetId: string, since: string): void; // no rerun; the history view refetches
  setParamsCollapsed(tabId: string, collapsed: boolean): void;
}

type Store = { byTab: Record<string, WorkbookState> } & WorkbookActions;

export const MAX_RUNNING_PER_SOURCE = 3;
export const TEXT_DEBOUNCE_MS = 400;
export const UNDO_STEPS = 50;

const NEEDS_VALUE = 'Needs a value before the widget runs.';

/** A widget's run, keyed by its run tab id (`tab/widget`), from the moment it is queued until it answers. */
interface Job {
  key: string;
  source: Source;
  runId: string;
  started: boolean;
  controller: AbortController;
  start: () => Promise<void>;
  /** Called when the job is dropped before it answers. */
  settle: () => void;
}
const jobs = new Map<string, Job>();
/** Saved queries by id, per tab; null when the library couldn't be read (linked widgets then run their last copy). */
const libraries = new Map<string, Map<string, SavedQuery> | null>();
/** The doc, dirty flag and undo stacks as they were when editing started, for a discard. */
/** `ran` holds the widgets run while editing: their rows may be from a draft that a discard or undo then takes away. */
const editStarts = new Map<string, Pick<WorkbookState, 'doc' | 'dirty' | 'undo' | 'redo'> & { ran?: Set<string> }>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
/** The current load of each tab; a read that finishes after an unload or a newer load is dropped. */
const loads = new Map<string, symbol>();

const omit = <T>(o: Record<string, T>, key: string): Record<string, T> => Object.fromEntries(Object.entries(o).filter(([k]) => k !== key));

const debounce = (key: string, fn: () => void) => {
  clearTimeout(timers.get(key));
  timers.set(
    key,
    setTimeout(() => {
      timers.delete(key);
      fn();
    }, TEXT_DEBOUNCE_MS),
  );
};

/** Runs `fn` after the debounce when `wait`, else at once, dropping a debounced run pending under `key`. */
const rerunAfter = (key: string, wait: boolean, fn: () => void) => {
  if (wait) {
    debounce(key, fn);
  } else {
    clearTimeout(timers.get(key));
    timers.delete(key);
    fn();
  }
};

/** Drops a widget's queued or running job; the bridge sends `query.cancel` for a running one when its signal aborts. */
function drop(key: string) {
  const job = jobs.get(key);
  if (job) {
    jobs.delete(key);
    job.controller.abort();
    job.settle();
  }
}

/** Starts queued jobs, in queue order, while their source has fewer than MAX_RUNNING_PER_SOURCE running. */
function pump() {
  const running = new Map<Source, number>();
  for (const job of jobs.values()) {
    if (job.started) {
      running.set(job.source, (running.get(job.source) ?? 0) + 1);
    }
  }
  for (const job of jobs.values()) {
    const n = running.get(job.source) ?? 0;
    if (!job.started && n < MAX_RUNNING_PER_SOURCE) {
      job.started = true;
      running.set(job.source, n + 1);
      void job.start();
    }
  }
}

/** Reads the library into the tab's cache of saved queries, which linked widgets run from. */
export async function readLibrary(tabId: string) {
  const token = loads.get(tabId);
  let library: Map<string, SavedQuery> | null;
  try {
    const list = await call<LibraryList>('library.list');
    library = new Map(list.queries.map((q) => [q.id, q]));
  } catch {
    library = null;
  }
  if (token && loads.get(tabId) === token) {
    libraries.set(tabId, library);
  }
}

/** The doc as it was when editing started (or as last saved since), while editing. */
export function editStartDoc(tabId: string): WorkbookDoc | undefined {
  return editStarts.get(tabId)?.doc;
}

/** The widgets run since editing started (or since it was last saved), while editing. */
export function editRanWidgets(tabId: string): string[] {
  return [...(editStarts.get(tabId)?.ran ?? [])];
}

/** The widget as it runs: a linked one takes the library query's text, source, options and parameters (as last read for the
 * tab). Null when gone. */
export function effectiveWidget(tabId: string, widget: Widget): Widget | null {
  const query = widget.query;
  const lib = libraries.get(tabId);
  if (!query?.saved || !lib) {
    return widget;
  }
  const q = lib.get(query.saved.id);
  // A raw request can't run in a widget; a link to one counts as gone.
  if (!q || q.source === 'raw') {
    return null;
  }
  return { ...widget, query: { ...query, source: q.source, text: q.text, options: q.options ?? null, parameters: q.parameters } };
}

/**
 * Queues a run of `own` (as it runs: a linked one takes its library query) under the run tab id `key`, after dropping the
 * one already there, with the tab's current values. Returns `waiting` once queued, or why it doesn't run: then nothing is
 * sent and no callback is called. The caller calls `pump` after. Only the latest run under a key is answered (Review Focus 2); a dropped one gets
 * `onDropped`.
 */
function queue(
  tabId: string,
  key: string,
  own: Widget,
  refresh: boolean,
  on: {
    onStart: (runId: string) => void;
    onAnswer: (run: WidgetRun, sent: { query: HistoryQuery; label: string }) => void;
    onDropped: () => void;
  },
): WidgetRun {
  drop(key);
  const s = useWorkbooks.getState().byTab[tabId];
  const widget = effectiveWidget(tabId, own);
  if (!s || !widget?.query) {
    return { state: 'gone' };
  }
  const params = widgetParams(s.doc, widget, s.values);
  const options = widgetRunOptions(s.doc, widget, s.values);
  const blocked = missingRequired(params).length > 0 ? NEEDS_VALUE : options && 'problem' in options ? options.problem : null;
  if (blocked || widget.query.text.trim() === '') {
    return blocked ? { state: 'blocked', reason: blocked } : { state: 'idle' };
  }

  const { source, text } = widget.query;
  const runId = newId();
  const controller = new AbortController();
  const runParams: QueryRunParams = {
    tabId: key,
    runId,
    source,
    kql: text,
    parameters: toParameterValues(params),
    options: options as QueryRunParams['options'],
    refresh,
    addToRecent: false,
  };
  // The hunting timespan is a parameter value, not part of the query: another span is another series, not an edited query
  // (which would drop the other spans' history). A widget whose text names the parameter already sends it.
  const hunting = source === 'hunting' ? s.doc.parameters.find((p) => p.huntingTimespan) : undefined;
  const timespan = runParams.options?.timespan;
  const span: ResolvedParam[] =
    hunting && timespan && !params.some((p) => p.name === hunting.name)
      ? [
          {
            name: hunting.name,
            type: hunting.type,
            required: false,
            value: timespan,
            from: widget.parameters[hunting.name]?.from ?? 'workbook',
          },
        ]
      : [];
  const series = [...params, ...span];
  const sent = {
    query: {
      source,
      text,
      options: widget.query.options ?? null,
      parameters: series.map(({ name, value, type }) => ({ name, value, type })),
    },
    label: seriesLabel(series),
  };
  const job: Job = {
    key,
    source,
    runId,
    started: false,
    controller,
    settle: on.onDropped,
    start: async () => {
      on.onStart(runId);
      let run: WidgetRun;
      try {
        run = { state: 'done', result: await call<RunResult>('query.run', runParams, controller.signal), finishedAt: Date.now() };
      } catch (error) {
        run = { state: 'failed', error, finishedAt: Date.now() };
      }
      // Review Focus 2: an answer for any run but the key's latest is stale.
      if (jobs.get(key) === job) {
        jobs.delete(key);
        on.onAnswer(run, sent);
        pump();
      }
    },
  };
  jobs.set(key, job);
  return { state: 'waiting' };
}

export const useWorkbooks: UseBoundStore<StoreApi<Store>> = create<Store>()((set, get) => {
  const update = (tabId: string, change: (s: WorkbookState) => Partial<WorkbookState>) =>
    set((st) => {
      const s = st.byTab[tabId];
      return s ? { byTab: { ...st.byTab, [tabId]: { ...s, ...change(s) } } } : st;
    });
  const setRun = (tabId: string, widgetId: string, run: WidgetRun) => update(tabId, (s) => ({ runs: { ...s.runs, [widgetId]: run } }));

  /** Writes the values of the parameters marked `remember`, debounced. */
  const remember = (tabId: string) => {
    const doc = get().byTab[tabId]?.doc;
    if (!doc?.parameters.some((p) => p.remember)) {
      return;
    }
    debounce(`${tabId}:remember`, () => {
      const s = get().byTab[tabId];
      if (s) {
        const values = Object.fromEntries(
          s.doc.parameters.filter((p) => p.remember).map((p) => [p.name, s.values.workbook[p.name] ?? p.value]),
        );
        void call('workbook.values.save', { id: s.doc.id, values }).catch(() => undefined);
      }
    });
  };

  const setHistory = (
    tabId: string,
    widgetId: string,
    query: HistoryQuery,
    change: (was: WidgetHistoryState) => Partial<WidgetHistoryState>,
  ) =>
    update(tabId, (s) => {
      const was = s.history[widgetId] ?? { skipped: null, reset: false, recordedAt: null, query };
      return { history: { ...s.history, [widgetId]: { ...was, ...change(was) } } };
    });

  /** Sends a terminal answer of a history widget to the host, unless it mustn't be kept (Review Focus 1). Fire and forget:
   * a failed record leaves the run as it is and says why in the footer. `dirty` and the doc are read now, not when the run was queued. */
  const record = (tabId: string, widgetId: string, run: WidgetRun, sent: { query: HistoryQuery; label: string }) => {
    const s = get().byTab[tabId];
    const h = s?.doc.widgets.find((w) => w.id === widgetId)?.history;
    if (!s || !h) {
      return;
    }
    const rows = run.state === 'done' ? historyRows(run.result, h) : null;
    const skipped = recordable(run, s.dirty) ?? (rows === 'keysNotUnique' ? rows : null);
    if (skipped || run.state !== 'done' || !rows || rows === 'keysNotUnique') {
      setHistory(tabId, widgetId, sent.query, () => ({ skipped, error: undefined, query: sent.query }));
      return;
    }
    // Set now, not on the record's answer: an older record answering late mustn't bring back its query.
    setHistory(tabId, widgetId, sent.query, (was) => ({ error: undefined, query: sent.query, pending: (was.pending ?? 0) + 1 }));
    const params: HistoryRecordParams = {
      workbookId: s.doc.id,
      widgetId,
      ...sent,
      setting: historySetting(h),
      ...rows,
    };
    call<HistoryRecordAnswer>('history.record', params).then(
      (a) =>
        setHistory(tabId, widgetId, sent.query, (was) => ({
          skipped: a.skipped === 'interval' ? null : a.skipped,
          reset: was.reset || a.reset,
          recordedAt: a.recorded ? Date.now() : was.recordedAt,
          pending: (was.pending ?? 1) - 1,
        })),
      (e: unknown) =>
        setHistory(tabId, widgetId, sent.query, (was) => ({ skipped: null, error: errorText(e), pending: (was.pending ?? 1) - 1 })),
    );
  };

  /** Runs the data widgets `ids` that are visible; a hidden one that isn't idle is marked stale (an in-flight run used the old value), an idle one stays as it is. */
  const runVisible = (tabId: string, ids: string[], opts?: { refresh?: boolean }) => {
    const s = get().byTab[tabId];
    const widgets = (s?.doc.widgets ?? []).filter((w) => w.query && ids.includes(w.id));
    const hidden = widgets.filter((w) => !isVisible(s!, w) && (s!.runs[w.id]?.state ?? 'idle') !== 'idle');
    if (hidden.length > 0) {
      update(tabId, (t) => ({ stale: { ...t.stale, ...Object.fromEntries(hidden.map((w) => [w.id, true as const])) } }));
    }
    return Promise.all(widgets.filter((w) => isVisible(s!, w)).map((w) => get().runWidget(tabId, w.id, opts))).then(() => undefined);
  };

  const store: Store = {
    byTab: {},

    async load(tabId, doc, opts) {
      const fresh: WorkbookState = {
        doc,
        values: initialValues(doc, {}),
        runs: {},
        editing: false,
        undo: [],
        redo: [],
        dirty: opts?.dirty ?? false,
        selections: {},
        history: {},
        since: {},
        activeTabs: {},
        stale: {},
      };
      const token = Symbol(tabId);
      loads.set(tabId, token);
      set((st) => ({ byTab: { ...st.byTab, [tabId]: fresh } }));
      const [remembered] = await Promise.all([
        call<{ values: Record<string, string> }>('workbook.values.get', { id: doc.id }).then(
          (r) => r.values,
          () => ({}),
        ),
        readLibrary(tabId),
      ]);
      if (loads.get(tabId) !== token) {
        return; // unloaded or reloaded meanwhile
      }
      // Values the user changed during the load win over the remembered ones.
      // shortcut: a value changed back to its default counts as unchanged; track touched names if that matters.
      const changed = (s: WorkbookState) => Object.entries(s.values.workbook).filter(([n, v]) => v !== fresh.values.workbook[n]);
      update(tabId, (s) => ({
        values: { ...s.values, workbook: { ...initialValues(s.doc, remembered).workbook, ...Object.fromEntries(changed(s)) } },
      }));
      await get().runAll(tabId);
    },

    unload(tabId) {
      for (const key of [...jobs.keys()].filter((k) => k.startsWith(`${tabId}/`))) {
        drop(key);
      }
      for (const key of [...timers.keys()].filter((k) => k.startsWith(`${tabId}:`))) {
        clearTimeout(timers.get(key));
        timers.delete(key);
      }
      libraries.delete(tabId);
      loads.delete(tabId);
      editStarts.delete(tabId);
      set((st) => {
        const { [tabId]: _gone, ...byTab } = st.byTab;
        return { byTab };
      });
      pump();
    },

    runWidget(tabId, widgetId, opts) {
      const own = get().byTab[tabId]?.doc.widgets.find((w) => w.id === widgetId);
      if (!own?.query) {
        return Promise.resolve();
      }
      const start = editStarts.get(tabId);
      if (start) {
        (start.ran ??= new Set()).add(widgetId);
      }
      return new Promise<void>((settle) => {
        const queued = queue(tabId, `${tabId}/${widgetId}`, own, opts?.refresh ?? false, {
          onStart: (runId) => setRun(tabId, widgetId, { state: 'running', runId, startedAt: Date.now() }),
          onAnswer: (run, sent) => {
            setRun(tabId, widgetId, run);
            record(tabId, widgetId, run, sent);
            if (run.state === 'done') {
              // The rows changed, so the old row indexes mean nothing.
              update(tabId, (s) => ({ selections: Object.fromEntries(Object.entries(s.selections).filter(([id]) => id !== widgetId)) }));
            }
            settle();
          },
          onDropped: settle,
        });
        update(tabId, (s) => ({ runs: { ...s.runs, [widgetId]: queued }, stale: omit(s.stale, widgetId) }));
        pump();
        if (queued.state !== 'waiting') {
          settle();
        }
      });
    },

    runDraft(tabId, widget) {
      return new Promise<RunResult>((resolve, reject) => {
        const queued = queue(tabId, `${tabId}/preview`, widget, false, {
          onStart: () => undefined,
          onAnswer: (run) =>
            run.state === 'done' ? resolve(run.result) : reject(run.state === 'failed' ? run.error : new Error(run.state)),
          onDropped: () => reject(new DOMException('A newer preview replaced this one.', 'AbortError')),
        });
        pump();
        if (queued.state !== 'waiting') {
          reject(
            new Error(queued.state === 'blocked' ? queued.reason : queued.state === 'gone' ? 'This saved query is gone.' : 'No query yet.'),
          );
        }
      });
    },

    async runAll(tabId, opts) {
      if (opts?.refresh) {
        await readLibrary(tabId);
      }
      await runVisible(
        tabId,
        (get().byTab[tabId]?.doc.widgets ?? []).map((w) => w.id),
        opts,
      );
    },

    showTab(tabId, tabsId, tab) {
      update(tabId, (s) => ({ activeTabs: { ...s.activeTabs, [tabsId]: tab } }));
      const s = get().byTab[tabId];
      for (const w of s?.doc.widgets ?? []) {
        const state = s!.runs[w.id]?.state ?? 'idle';
        // A stale widget reruns even mid-run (queue drops the old run); a fresh one in flight is left alone (R16).
        if (w.query && w.in?.tabs === tabsId && w.in.tab === tab && (state === 'idle' || s!.stale[w.id])) {
          void get().runWidget(tabId, w.id);
        }
      }
    },

    async refreshTab(tabId, tabsId) {
      await readLibrary(tabId);
      const s = get().byTab[tabId];
      const shown = s && visibleTab(s, tabsId);
      await runVisible(
        tabId,
        (s?.doc.widgets ?? []).filter((w) => w.in?.tabs === tabsId && w.in.tab === shown).map((w) => w.id),
        { refresh: true },
      );
    },

    setWorkbookValue(tabId, name, value, opts) {
      const s = get().byTab[tabId];
      if (!s) {
        return;
      }
      update(tabId, (t) => ({ values: { ...t.values, workbook: { ...t.values.workbook, [name]: value } } }));
      remember(tabId);
      const rerun = () => {
        const doc = get().byTab[tabId]?.doc ?? s.doc;
        // A linked widget is rerun by what its library query uses, not its local copy.
        const running = { ...doc, widgets: doc.widgets.map((w) => effectiveWidget(tabId, w) ?? w) };
        void runVisible(tabId, widgetsUsing(running, name));
      };
      const key = `${tabId}:value:${name}`;
      // Any value typed, whatever its type, waits until typing stops; one picked from choices runs at once.
      const typed = !s.doc.parameters.find((p) => p.name === name)?.choices?.length;
      rerunAfter(key, !opts?.now && typed, rerun);
    },

    setWidgetValue(tabId, widgetId, name, value, opts) {
      update(tabId, (s) => ({
        values: { ...s.values, widgets: { ...s.values.widgets, [widgetId]: { ...s.values.widgets[widgetId], [name]: value } } },
      }));
      // The header's selects pass `now`; its text boxes wait until typing stops.
      rerunAfter(`${tabId}:widget:${widgetId}:${name}`, !opts?.now, () => void get().runWidget(tabId, widgetId));
    },

    edit(tabId, change) {
      update(tabId, (s) => ({ doc: change(s.doc), undo: [...s.undo, s.doc].slice(-UNDO_STEPS), redo: [], dirty: true }));
    },

    undoEdit(tabId) {
      update(tabId, (s) => {
        const doc = s.undo.at(-1);
        return doc ? { doc, undo: s.undo.slice(0, -1), redo: [...s.redo, s.doc], dirty: true } : {};
      });
    },

    redoEdit(tabId) {
      update(tabId, (s) => {
        const doc = s.redo.at(-1);
        return doc ? { doc, redo: s.redo.slice(0, -1), undo: [...s.undo, s.doc], dirty: true } : {};
      });
    },

    setEditing(tabId, editing, discard) {
      const start = editStarts.get(tabId);
      const s = get().byTab[tabId];
      if (editing && s && !s.editing) {
        editStarts.set(tabId, { doc: s.doc, dirty: s.dirty, undo: s.undo, redo: s.redo });
      }
      if (!editing) {
        editStarts.delete(tabId);
      }
      // A discard puts back the doc, and whether it was dirty, as they were when editing started.
      update(tabId, () => ({ editing, ...(!editing && discard && start ? start : {}) }));
    },

    saveValuesAsDefaults(tabId) {
      const values = get().byTab[tabId]?.values;
      if (!values) {
        return;
      }
      get().edit(tabId, (doc) => ({
        ...doc,
        parameters: doc.parameters.map((p) => ({ ...p, value: values.workbook[p.name] ?? p.value })),
        widgets: doc.widgets.map((w) => {
          const own = Object.entries(values.widgets[w.id] ?? {}).filter(([name]) => w.parameters[name]?.from !== 'fixed');
          return own.length === 0
            ? w
            : {
                ...w,
                parameters: {
                  ...w.parameters,
                  ...Object.fromEntries(own.map(([name, value]) => [name, { from: 'widget' as const, value }])),
                },
              };
        }),
      }));
    },

    copySavedIntoWidget(tabId, widgetId) {
      get().edit(tabId, (doc) => ({
        ...doc,
        widgets: doc.widgets.map((w) => (w.id === widgetId && w.query ? { ...w, query: { ...w.query, saved: null } } : w)),
      }));
      void get().runWidget(tabId, widgetId);
    },

    markUnsaved(tabId) {
      update(tabId, () => ({ dirty: true }));
      const start = editStarts.get(tabId);
      if (start) {
        editStarts.set(tabId, { ...start, dirty: true });
      }
    },

    markSaved(tabId, doc) {
      update(tabId, () => ({ doc, dirty: false }));
      // Saved while editing: a later discard returns to what was saved.
      const s = get().byTab[tabId];
      if (s && editStarts.has(tabId)) {
        editStarts.set(tabId, { doc, dirty: false, undo: s.undo, redo: s.redo });
      }
    },

    setSelection(tabId, widgetId, selected) {
      update(tabId, (s) => ({ selections: { ...s.selections, [widgetId]: { shown: null, ...s.selections[widgetId], selected } } }));
    },

    setSince(tabId, widgetId, since) {
      update(tabId, (s) => ({ since: { ...s.since, [widgetId]: since } }));
    },

    setParamsCollapsed(tabId, collapsed) {
      update(tabId, () => ({ paramsCollapsed: collapsed ? true : undefined }));
    },

    setShown(tabId, widgetId, shown) {
      const was = get().byTab[tabId]?.selections[widgetId];
      if (was?.shown && was.shown.length === shown.length && was.shown.every((v, i) => v === shown[i])) {
        return;
      }
      update(tabId, (s) => ({ selections: { ...s.selections, [widgetId]: { selected: [], ...s.selections[widgetId], shown } } }));
    },
  };
  return store;
});

/**
 * Keeps the workbook tabs and this store together (Ruling R1): a workbook tab that opens, or comes back with the session,
 * loads; one that closes unloads; and each workbook's doc and dirty flag are mirrored into its tab, so the session keeps
 * unsaved edits and closing asks. A document from the session goes through `parseWorkbook` first, so a damaged one is
 * repaired; one that can't be read stays in its tab as it is, `notify` says why, and it isn't tried again. Returns the
 * function that stops it.
 */
export function startWorkbookTabs(notify?: (message: string) => void): () => void {
  /** Tabs whose document couldn't be read or loaded. */
  const failed = new Set<string>();
  const fail = (id: string, title: string, why: string) => {
    failed.add(id);
    notify?.(`${title} couldn’t be opened: ${why}`);
  };
  const reconcile = () => {
    const { tabs } = useTabs.getState();
    const { byTab, load, unload } = useWorkbooks.getState();
    for (const id of failed) {
      if (!tabs.some((t) => t.id === id)) {
        failed.delete(id);
      }
    }
    for (const t of tabs) {
      if (t.workbook && !byTab[t.id] && !failed.has(t.id)) {
        const doc = parseWorkbook(t.workbook);
        if (typeof doc === 'string') {
          fail(t.id, t.title, doc);
        } else {
          load(t.id, doc, { dirty: t.dirty }).catch((e: unknown) => fail(t.id, t.title, e instanceof Error ? e.message : String(e)));
        }
      }
    }
    for (const id of Object.keys(byTab)) {
      if (!tabs.some((t) => t.id === id)) {
        unload(id);
      }
    }
  };
  const stopWorkbooks = useWorkbooks.subscribe((state, previous) => {
    for (const [id, s] of Object.entries(state.byTab)) {
      const was = previous.byTab[id];
      if (s.doc !== was?.doc || s.dirty !== was.dirty) {
        useTabs.getState().setWorkbook(id, s.doc, s.dirty);
      }
    }
  });
  const stopTabs = useTabs.subscribe((state, previous) => {
    if (state.tabs !== previous.tabs) {
      reconcile();
    }
  });
  reconcile();
  return () => {
    stopWorkbooks();
    stopTabs();
  };
}

/**
 * Linked widgets take their saved query's current source, text, options, parameters and name, so the file works without the
 * library entry (spec §9.2); a link the library no longer has (or an unreadable library) keeps its last copy.
 */
export async function withLinkedCopies(doc: WorkbookDoc): Promise<WorkbookDoc> {
  const library = await call<LibraryList>('library.list').then(
    (l) => new Map(l.queries.map((q) => [q.id, q])),
    () => new Map<string, SavedQuery>(),
  );
  const widgets = doc.widgets.map((w) => {
    const q = w.query?.saved ? library.get(w.query.saved.id) : undefined;
    return w.query && q && q.source !== 'raw'
      ? {
          ...w,
          query: {
            ...w.query,
            source: q.source,
            text: q.text,
            options: q.options ?? null,
            parameters: q.parameters,
            saved: { id: q.id, name: q.name },
          },
        }
      : w;
  });
  return { ...doc, widgets };
}

/**
 * Saves a workbook tab's document. Linked widgets first take their saved query's current source, text, options, parameters
 * and name, so the file works without the library entry (spec §9.2); a link the library no longer has keeps its last copy.
 * `as` names the workbook and puts it in a folder (the first save's dialog). Rejects with the host's refusal (a bad name or
 * folder). Allowed while editing.
 */
export async function saveWorkbook(tabId: string, as?: { name: string; folder: string | null }): Promise<void> {
  const base = useWorkbooks.getState().byTab[tabId]?.doc;
  if (!base) {
    throw new Error('The workbook is no longer open.');
  }
  const { widgets } = await withLinkedCopies(base);
  const { workbook } = await call<{ workbook: WorkbookDoc }>('workbook.save', { workbook: withFileVersion({ ...base, widgets, ...as }) });
  // An edit made while the save was out stays, unsaved.
  if (useWorkbooks.getState().byTab[tabId]?.doc === base) {
    useWorkbooks.getState().markSaved(tabId, workbook);
  }
  const tabs = useTabs.getState();
  tabs.markSaved(tabId, { savedId: workbook.id, title: workbook.name, text: tabs.tabs.find((t) => t.id === tabId)?.text ?? '' });
  const now = useWorkbooks.getState().byTab[tabId];
  if (now) {
    useTabs.getState().setWorkbook(tabId, now.doc, now.dirty);
  }
  useRevisions.getState().bump('library');
}
