import type { StoreApi, UseBoundStore } from 'zustand';
import { create } from 'zustand';
import { call } from '../bridge';
import type { Picked } from '../results/chart-view';
import { newId } from '../shell/ids';
import type { LibraryList, QueryRunParams, RunResult, SavedQuery, Source } from '../wire';
import type { Widget, WorkbookDoc } from './model';
import type { ViewValues } from './resolve';
import { initialValues, missingRequired, toParameterValues, widgetParams, widgetRunOptions, widgetsUsing } from './resolve';

export type WidgetRun =
  | { state: 'idle' }
  | { state: 'waiting' }
  | { state: 'running'; runId: string; startedAt: number }
  | { state: 'done'; result: RunResult }
  | { state: 'blocked'; reason: string } // a required value is missing, or widgetRunOptions gave a problem
  | { state: 'gone' } // the linked saved query no longer exists
  | { state: 'failed'; error: unknown };

export interface WorkbookState {
  doc: WorkbookDoc;
  values: ViewValues;
  runs: Record<string, WidgetRun>;
  editing: boolean;
  undo: WorkbookDoc[];
  redo: WorkbookDoc[];
  /** The doc differs from the file (Ruling R1); Task 9 mirrors it into the tab. */
  dirty: boolean;
  /** Chart picks changed outside edit mode, by widget id: view state, never in the doc (Ruling R3). */
  viewCharts: Record<string, Picked>;
}

export interface WorkbookActions {
  load(tabId: string, doc: WorkbookDoc, opts?: { dirty?: boolean }): Promise<void>; // reads remembered values and the library, then runAll
  unload(tabId: string): void; // cancels its runs
  runWidget(tabId: string, widgetId: string, opts?: { refresh?: boolean }): Promise<void>;
  runAll(tabId: string, opts?: { refresh?: boolean }): Promise<void>;
  setWorkbookValue(tabId: string, name: string, value: string, opts?: { now?: boolean }): void; // reruns widgetsUsing; text is debounced unless now
  setWidgetValue(tabId: string, widgetId: string, name: string, value: string): void; // reruns that widget
  edit(tabId: string, change: (doc: WorkbookDoc) => WorkbookDoc): void; // pushes undo, marks the tab dirty (Task 9)
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
  /** Resolves the job's `runWidget` promise. */
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

async function readLibrary(tabId: string) {
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

export const useWorkbooks: UseBoundStore<StoreApi<Store>> = create<Store>()((set, get) => {
  const update = (tabId: string, change: (s: WorkbookState) => Partial<WorkbookState>) =>
    set((st) => {
      const s = st.byTab[tabId];
      return s ? { byTab: { ...st.byTab, [tabId]: { ...s, ...change(s) } } } : st;
    });
  const setRun = (tabId: string, widgetId: string, run: WidgetRun) =>
    update(tabId, (s) => ({ runs: { ...s.runs, [widgetId]: run } }));

  /** The widget as it runs: a linked one takes the library query's text, source, options and parameters. Null when gone. */
  const effective = (tabId: string, widget: Widget): Widget | null => {
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
  };

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
      const s = get().byTab[tabId];
      const own = s?.doc.widgets.find((w) => w.id === widgetId);
      if (!s || !own?.query) {
        return Promise.resolve();
      }
      const key = `${tabId}/${widgetId}`;
      drop(key);
      const widget = effective(tabId, own);
      if (!widget?.query) {
        setRun(tabId, widgetId, { state: 'gone' });
        pump();
        return Promise.resolve();
      }
      const params = widgetParams(s.doc, widget, s.values);
      const options = widgetRunOptions(s.doc, widget, s.values);
      const blocked = missingRequired(params).length > 0 ? NEEDS_VALUE : options && 'problem' in options ? options.problem : null;
      if (blocked || widget.query.text.trim() === '') {
        setRun(tabId, widgetId, blocked ? { state: 'blocked', reason: blocked } : { state: 'idle' });
        pump();
        return Promise.resolve();
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
        refresh: opts?.refresh ?? false,
        addToRecent: false,
      };
      return new Promise<void>((settle) => {
        const job: Job = {
          key,
          source,
          runId,
          started: false,
          controller,
          settle,
          start: async () => {
            setRun(tabId, widgetId, { state: 'running', runId, startedAt: Date.now() });
            let run: WidgetRun;
            try {
              run = { state: 'done', result: await call<RunResult>('query.run', runParams, controller.signal) };
            } catch (error) {
              run = { state: 'failed', error };
            }
            // Review Focus 2: an answer for any run but the widget's latest is stale.
            if (jobs.get(key) === job) {
              jobs.delete(key);
              setRun(tabId, widgetId, run);
              settle();
              pump();
            }
          },
        };
        jobs.set(key, job);
        setRun(tabId, widgetId, { state: 'waiting' });
        pump();
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
        const running = { ...doc, widgets: doc.widgets.map((w) => effective(tabId, w) ?? w) };
        for (const id of widgetsUsing(running, name)) {
          void get().runWidget(tabId, id);
        }
      };
      const key = `${tabId}:value:${name}`;
      if (!opts?.now && s.doc.parameters.find((p) => p.name === name)?.type === 'text') {
        debounce(key, rerun);
      } else {
        clearTimeout(timers.get(key));
        timers.delete(key);
        rerun();
      }
    },

    setWidgetValue(tabId, widgetId, name, value) {
      update(tabId, (s) => ({
        values: { ...s.values, widgets: { ...s.values.widgets, [widgetId]: { ...s.values.widgets[widgetId], [name]: value } } },
      }));
      void get().runWidget(tabId, widgetId);
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
