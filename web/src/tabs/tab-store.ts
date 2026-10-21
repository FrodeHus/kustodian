import { create } from 'zustand';
import { BridgeError, call, on } from '../bridge';
import { blockAt } from '../editor/block-at';
import type { ParameterDef, ParameterValue, RunProgress, RunResult, Session, Source } from '../wire';

export type { Source } from '../wire';

export interface TabRun {
  state: 'running' | 'done';
  /** The id sent with `query.run`; progress events for any other run of the tab are stale. */
  runId: string;
  /** The latest `query.progress` stage while running (planning, fetching, probing, per-object, engine). */
  stage?: string;
  /** What the stage is working on, such as the table being fetched. */
  detail?: string;
  result?: RunResult;
  /** The run was cancelled before it answered; there is no result. */
  cancelled?: boolean;
  startedAt: number;
  /** Where the text sent begins in the editor (lines and columns from 1). The host counts an error's position within the text
   * sent; this turns it back into the editor's. */
  origin: { line: number; column: number };
}

/** A query error's position in the editor: the host's position within the text sent, moved by where that text began. The
 * column moves only on the text's first line (a selection can start mid-line). */
export function editorPosition(origin: TabRun['origin'], error: { line: number; column: number }): { line: number; column: number } {
  return {
    line: origin.line + error.line - 1,
    column: error.line === 1 ? origin.column + error.column - 1 : error.column,
  };
}

export interface Tab {
  id: string;
  source: Source;
  title: string;
  text: string;
  dirty: boolean;
  /** The saved query this tab is, once saved to (or opened from) the library. */
  savedId?: string;
  /** The `.kql` file this tab was opened from or saved to. */
  filePath?: string;
  parameters: ParameterDef[];
  run?: TabRun;
  /** A result kept to compare later runs with. */
  pinned?: RunResult;
  /** The tab's latest results, newest first, at most {@link HISTORY_SIZE}. */
  history: RunResult[];
}

export const HISTORY_SIZE = 5;

/** What a new tab starts with: `openWith`'s argument. */
export interface TabSeed {
  source: Source;
  title: string;
  text: string;
  savedId?: string;
  filePath?: string;
  parameters?: ParameterDef[];
}

/** Where the editor's cursor is in a tab, and the selected text (empty when nothing is selected) with where it starts. Lines and
 * columns count from 1. */
export interface TabCursor {
  line: number;
  column: number;
  selection: string;
  selectionLine: number;
  selectionColumn: number;
}

/** `block`: the block at the cursor; `selection`: the selected text; `all`: the whole tab (spec 6.2). */
export type RunMode = 'block' | 'selection' | 'all';

interface TabsState {
  tabs: Tab[];
  activeId: string | null;
  cursors: Record<string, TabCursor>;
  /** Opens a new empty tab for `source`, titled after the tabs already open, makes it active and returns its id. */
  open(source: Source): string;
  /** Opens a new tab with this text and title, not dirty, makes it active and returns its id. */
  openWith(seed: TabSeed): string;
  /** Replaces the open tabs with a saved session's, unsaved text included. */
  restore(session: Session): void;
  setTitle(id: string, title: string): void;
  /** The tab was saved (to the library, a file, or both): it takes the new name and is no longer dirty. */
  markSaved(id: string, saved: { savedId?: string; filePath?: string; title: string }): void;
  setParameters(id: string, parameters: ParameterDef[]): void;
  /** Keeps the tab's current result to compare with. */
  pin(id: string): void;
  unpin(id: string): void;
  close(id: string): void;
  activate(id: string): void;
  setText(id: string, text: string): void;
  setCursor(id: string, cursor: TabCursor): void;
  /** Runs the tab's query with its parameters; resolves when the run has ended, however it ended. `refresh` skips the
   * host's cache. A raw request tab never runs. */
  run(id: string, mode: RunMode, opts?: { refresh?: boolean }): Promise<void>;
  cancel(id: string): void;
}

/** One controller per running tab. A new run on a tab replaces the one before. */
const controllers = new Map<string, AbortController>();
let unsubscribeProgress: (() => void) | undefined;

function failed(message: string, runId: string): RunResult {
  return { outcome: 'failed', message, error: null, columns: [], rows: [], total: 0, tables: [], durationMs: 0, droppedValues: 0, runId, diagnostics: [] };
}

export const useTabs = create<TabsState>()((set, get) => {
  const update = (id: string, change: (tab: Tab) => Partial<Tab>) =>
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, ...change(t) } : t)) }));

  // Progress events reach whichever tab is running; subscribed on the first run, so loading the store sends nothing.
  const listen = () => {
    unsubscribeProgress ??= on('query.progress', (data) => {
      const { tabId, runId, stage, detail } = data as RunProgress;
      update(tabId, (t) => (t.run?.state === 'running' && t.run.runId === runId ? { run: { ...t.run, stage, detail } } : {}));
    });
  };

  return {
    tabs: [],
    activeId: null,
    cursors: {},

    open(source) {
      // Numbered after the tabs already open, so a fresh window starts at Query 1.
      const used = new Set(get().tabs.map((t) => t.title));
      let n = 1;
      while (used.has(`Query ${n}`)) {
        n++;
      }
      return get().openWith({ source, title: `Query ${n}`, text: '' });
    },

    openWith({ source, title, text, savedId, filePath, parameters }) {
      const id = crypto.randomUUID();
      const tab: Tab = { id, source, title, text, dirty: false, savedId, filePath, parameters: parameters ?? [], history: [] };
      set((s) => ({ tabs: [...s.tabs, tab], activeId: id }));
      return id;
    },

    restore(session) {
      for (const id of controllers.keys()) {
        get().cancel(id);
      }
      const tabs: Tab[] = session.tabs.map((t) => ({
        id: t.id,
        source: t.source,
        title: t.title,
        text: t.text,
        dirty: t.dirty,
        savedId: t.savedId ?? undefined,
        filePath: t.filePath ?? undefined,
        parameters: t.parameters,
        history: [],
      }));
      const activeId = tabs.some((t) => t.id === session.activeId) ? session.activeId : (tabs[0]?.id ?? null);
      set({ tabs, activeId, cursors: {} });
    },

    setTitle(id, title) {
      update(id, () => ({ title }));
    },

    markSaved(id, { savedId, filePath, title }) {
      update(id, (t) => ({ title, dirty: false, savedId: savedId ?? t.savedId, filePath: filePath ?? t.filePath }));
    },

    setParameters(id, parameters) {
      update(id, () => ({ parameters }));
    },

    pin(id) {
      update(id, (t) => (t.run?.result ? { pinned: t.run.result } : {}));
    },

    unpin(id) {
      update(id, () => ({ pinned: undefined }));
    },

    close(id) {
      get().cancel(id);
      set((s) => {
        const index = s.tabs.findIndex((t) => t.id === id);
        const tabs = s.tabs.filter((t) => t.id !== id);
        const cursors = { ...s.cursors };
        delete cursors[id];
        const activeId = s.activeId === id ? (tabs[Math.min(index, tabs.length - 1)]?.id ?? null) : s.activeId;
        return { tabs, activeId, cursors };
      });
    },

    activate(id) {
      if (get().tabs.some((t) => t.id === id)) {
        set({ activeId: id });
      }
    },

    setText(id, text) {
      update(id, (t) => (t.text === text ? {} : { text, dirty: true }));
    },

    setCursor(id, cursor) {
      set((s) => ({ cursors: { ...s.cursors, [id]: cursor } }));
    },

    async run(id, mode, opts) {
      const tab = get().tabs.find((t) => t.id === id);
      // Ruling 1: a raw request tab sends its request through `raw.send`, never `query.run`.
      if (!tab || tab.source === 'raw') {
        return;
      }
      const cursor = get().cursors[id] ?? { line: 1, column: 1, selection: '', selectionLine: 1, selectionColumn: 1 };
      let kql: string;
      let origin: TabRun['origin'];
      if (mode === 'all') {
        kql = tab.text;
        origin = { line: 1, column: 1 };
      } else if (mode === 'selection' && cursor.selection) {
        kql = cursor.selection;
        origin = { line: cursor.selectionLine, column: cursor.selectionColumn };
      } else {
        const block = blockAt(tab.text, cursor.line);
        kql = block.text;
        origin = { line: block.start, column: 1 };
      }
      if (kql.trim() === '') {
        return;
      }

      listen();
      controllers.get(id)?.abort();
      const controller = new AbortController();
      controllers.set(id, controller);
      const startedAt = Date.now();
      // Ruling 19: the page names the run, so progress for an older run of this tab can be told apart from the first event.
      const runId = crypto.randomUUID();
      update(id, () => ({ run: { state: 'running', runId, startedAt, origin } }));
      const parameters: ParameterValue[] = tab.parameters.map(({ name, type, value, required }) => ({ name, type, value, required }));

      let run: TabRun;
      try {
        const result = await call<RunResult>(
          'query.run',
          { tabId: id, source: tab.source, kql, refresh: opts?.refresh ?? false, parameters, runId },
          controller.signal,
        );
        run = { state: 'done', runId, result, startedAt, origin };
      } catch (error) {
        run =
          error instanceof BridgeError && error.code === 'cancelled'
            ? { state: 'done', runId, cancelled: true, startedAt, origin }
            : { state: 'done', runId, result: failed(error instanceof Error ? error.message : String(error), runId), startedAt, origin };
      }

      // A newer run on the tab owns it now; this one's answer is stale.
      if (controllers.get(id) === controller) {
        controllers.delete(id);
        const result = run.result;
        update(id, (t) => ({ run, history: result ? [result, ...t.history].slice(0, HISTORY_SIZE) : t.history }));
      }
    },

    cancel(id) {
      controllers.get(id)?.abort();
    },
  };
});
