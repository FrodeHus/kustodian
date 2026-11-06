import type { StoreApi, UseBoundStore } from 'zustand';
import { create } from 'zustand';
import { call } from '../bridge';
import { useRevisions } from '../library/saving';
import type { Picked } from '../results/chart-view';
import { newId } from '../shell/ids';
import { useTabs } from '../tabs/tab-store';
import type { LibraryList, QueryRunParams, RunResult, SavedQuery, Source } from '../wire';
import type { Widget, WorkbookDoc } from './model';
import { parseWorkbook } from './model';
import type { ViewValues } from './resolve';
import { initialValues, missingRequired, toParameterValues, widgetParams, widgetRunOptions, widgetsUsing } from './resolve';

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
  /** Chart picks changed outside edit mode, by widget id: view state, never in the doc (Ruling R3). */
  viewCharts: Record<string, Picked>;
}

export interface WorkbookActions {
  load(tabId: string, doc: WorkbookDoc, opts?: { dirty?: boolean }): Promise<void>; // reads remembered values and the library, then runAll
  unload(tabId: string): void; // cancels its runs
  runWidget(tabId: string, widgetId: string, opts?: { refresh?: boolean }): Promise<void>;
  /** Runs a draft of a widget (the widget editor's preview) as `runWidget` would, under the run tab id `tab/preview`; only the
   * latest call answers, the others reject. Rejects with the reason when it can't run. Its result isn't kept in `runs`. */
  runDraft(tabId: string, widget: Widget): Promise<RunResult>;
  runAll(tabId: string, opts?: { refresh?: boolean }): Promise<void>;
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
  setViewChart(tabId: string, widgetId: string, picked: Picked): void;
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
const editStarts = new Map<string, Pick<WorkbookState, 'doc' | 'dirty' | 'undo' | 'redo'>>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
/** The current load of each tab; a read that finishes after an unload or a newer load is dropped. */
const loads = new Map<string, symbol>();

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
  on: { onStart: (runId: string) => void; onAnswer: (run: WidgetRun) => void; onDropped: () => void },
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
        on.onAnswer(run);
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
  const setRun = (tabId: string, widgetId: string, run: WidgetRun) =>
    update(tabId, (s) => ({ runs: { ...s.runs, [widgetId]: run } }));

  /** Writes the values of the parameters marked `remember`, debounced. */
  const remember = (tabId: string) => {
    const doc = get().byTab[tabId]?.doc;
    if (!doc?.parameters.some((p) => p.remember)) {
      return;
    }
    debounce(`${tabId}:remember`, () => {
      const s = get().byTab[tabId];
      if (s) {
        const values = Object.fromEntries(s.doc.parameters.filter((p) => p.remember).map((p) => [p.name, s.values.workbook[p.name] ?? p.value]));
        void call('workbook.values.save', { id: s.doc.id, values }).catch(() => undefined);
      }
    });
  };

  const store: Store = {
    byTab: {},

    async load(tabId, doc, opts) {
      const fresh: WorkbookState = { doc, values: initialValues(doc, {}), runs: {}, editing: false, undo: [], redo: [], dirty: opts?.dirty ?? false, viewCharts: {} };
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
      return new Promise<void>((settle) => {
        const queued = queue(tabId, `${tabId}/${widgetId}`, own, opts?.refresh ?? false, {
          onStart: (runId) => setRun(tabId, widgetId, { state: 'running', runId, startedAt: Date.now() }),
          onAnswer: (run) => {
            setRun(tabId, widgetId, run);
            settle();
          },
          onDropped: settle,
        });
        setRun(tabId, widgetId, queued);
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
          onAnswer: (run) => (run.state === 'done' ? resolve(run.result) : reject(run.state === 'failed' ? run.error : new Error(run.state))),
          onDropped: () => reject(new DOMException('A newer preview replaced this one.', 'AbortError')),
        });
        pump();
        if (queued.state !== 'waiting') {
          reject(new Error(queued.state === 'blocked' ? queued.reason : queued.state === 'gone' ? 'This saved query is gone.' : 'No query yet.'));
        }
      });
    },

    async runAll(tabId, opts) {
      if (opts?.refresh) {
        await readLibrary(tabId);
      }
      const doc = get().byTab[tabId]?.doc;
      await Promise.all((doc?.widgets ?? []).filter((w) => w.query).map((w) => get().runWidget(tabId, w.id, opts)));
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
        for (const id of widgetsUsing(running, name)) {
          void get().runWidget(tabId, id);
        }
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
            : { ...w, parameters: { ...w.parameters, ...Object.fromEntries(own.map(([name, value]) => [name, { from: 'widget' as const, value }])) } };
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

    markSaved(tabId, doc) {
      update(tabId, () => ({ doc, dirty: false }));
      // Saved while editing: a later discard returns to what was saved.
      const s = get().byTab[tabId];
      if (s && editStarts.has(tabId)) {
        editStarts.set(tabId, { doc, dirty: false, undo: s.undo, redo: s.redo });
      }
    },

    setViewChart(tabId, widgetId, picked) {
      update(tabId, (s) => ({ viewCharts: { ...s.viewCharts, [widgetId]: picked } }));
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
 * Saves a workbook tab's document. Linked widgets first take their saved query's current source, text, options, parameters
 * and name, so the file works without the library entry (spec §9.2); a link the library no longer has keeps its last copy.
 * `as` names the workbook and puts it in a folder (the first save's dialog). Rejects with the host's refusal (a bad name or
 * folder). Allowed while editing.
 */
export async function saveWorkbook(tabId: string, as?: { name: string; folder: string | null }): Promise<void> {
  if (!useWorkbooks.getState().byTab[tabId]) {
    throw new Error('The workbook is no longer open.');
  }
  // Unreadable library: the widgets keep their last copies.
  const library = await call<LibraryList>('library.list').then(
    (l) => new Map(l.queries.map((q) => [q.id, q])),
    () => new Map<string, SavedQuery>(),
  );
  const base = useWorkbooks.getState().byTab[tabId]?.doc;
  if (!base) {
    throw new Error('The workbook is no longer open.');
  }
  const widgets = base.widgets.map((w) => {
    const q = w.query?.saved ? library.get(w.query.saved.id) : undefined;
    return w.query && q && q.source !== 'raw'
      ? { ...w, query: { ...w.query, source: q.source, text: q.text, options: q.options ?? null, parameters: q.parameters, saved: { id: q.id, name: q.name } } }
      : w;
  });
  const { workbook } = await call<{ workbook: WorkbookDoc }>('workbook.save', { workbook: { ...base, widgets, ...as } });
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
