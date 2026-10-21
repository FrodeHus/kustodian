import { create } from 'zustand';
import { BridgeError, call, on } from '../bridge';
import { blockAt } from '../editor/block-at';
import type { RunProgress, RunResult, Source } from '../wire';

export type { Source } from '../wire';

export interface TabRun {
  state: 'running' | 'done';
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
  run?: TabRun;
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
  /** Opens a new tab for `source`, makes it active and returns its id. */
  open(source: Source): string;
  close(id: string): void;
  activate(id: string): void;
  setText(id: string, text: string): void;
  setCursor(id: string, cursor: TabCursor): void;
  /** Runs the tab's query; resolves when the run has ended, however it ended. */
  run(id: string, mode: RunMode): Promise<void>;
  cancel(id: string): void;
}

/** One controller per running tab. A new run on a tab replaces the one before. */
const controllers = new Map<string, AbortController>();
let unsubscribeProgress: (() => void) | undefined;
let counter = 0;

function failed(message: string): RunResult {
  return { outcome: 'failed', message, error: null, columns: [], rows: [], total: 0, tables: [], durationMs: 0, droppedValues: 0, runId: '', diagnostics: [] };
}

export const useTabs = create<TabsState>()((set, get) => {
  const update = (id: string, change: (tab: Tab) => Partial<Tab>) =>
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, ...change(t) } : t)) }));

  // Progress events reach whichever tab is running; subscribed on the first run, so loading the store sends nothing.
  const listen = () => {
    unsubscribeProgress ??= on('query.progress', (data) => {
      const { tabId, stage, detail } = data as RunProgress;
      update(tabId, (t) => (t.run?.state === 'running' ? { run: { ...t.run, stage, detail } } : {}));
    });
  };

  return {
    tabs: [],
    activeId: null,
    cursors: {},

    open(source) {
      const id = `tab-${++counter}`;
      // Numbered after the tabs already open, so a fresh window starts at Query 1.
      const used = new Set(get().tabs.map((t) => t.title));
      let n = 1;
      while (used.has(`Query ${n}`)) {
        n++;
      }
      set((s) => ({ tabs: [...s.tabs, { id, source, title: `Query ${n}`, text: '', dirty: false }], activeId: id }));
      return id;
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

    async run(id, mode) {
      const tab = get().tabs.find((t) => t.id === id);
      if (!tab) {
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
      update(id, () => ({ run: { state: 'running', startedAt, origin } }));

      let run: TabRun;
      try {
        const result = await call<RunResult>('query.run', { tabId: id, source: tab.source, kql, refresh: false }, controller.signal);
        run = { state: 'done', result, startedAt, origin };
      } catch (error) {
        run =
          error instanceof BridgeError && error.code === 'cancelled'
            ? { state: 'done', cancelled: true, startedAt, origin }
            : { state: 'done', result: failed(error instanceof Error ? error.message : String(error)), startedAt, origin };
      }

      // A newer run on the tab owns it now; this one's answer is stale.
      if (controllers.get(id) === controller) {
        controllers.delete(id);
        update(id, () => ({ run }));
      }
    },

    cancel(id) {
      controllers.get(id)?.abort();
    },
  };
});
