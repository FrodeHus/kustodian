import { create } from 'zustand';
import { BridgeError, call } from '../bridge';
import { errorText } from '../shell/errors';
import { reportIdOf } from '../shell/report-id';
import { useTabs } from '../tabs/tab-store';
import type { ArmResourceTypesAnswer, ListedByDefault, SchemaLicenses, SchemaView, Source, TabSource } from '../wire';

/** The sources with a schema of their own. A raw request tab completes against Graph's. */
export type SchemaSource = Exclude<Source, 'raw'>;

/** The schema a tab of `source` uses: a raw request tab, and a workbook tab, use Graph's. */
export const schemaSourceOf = (source: TabSource): SchemaSource => (source === 'raw' || source === 'workbook' ? 'graph' : source);

interface SchemasState {
  /** Each source's schema, once read. */
  byKey: Record<Source, SchemaView | undefined>;
  /** Each Log Analytics workspace's schema by customer ID, once read: a `logs` tab completes against its workspace's. */
  logsByWorkspace: Record<string, SchemaView>;
  /** Why a workspace's schema couldn't be read, by customer ID. */
  logsErrors: Record<string, string>;
  /** The workspaces whose read needs Log Analytics consent, by customer ID. */
  logsConsent: Record<string, boolean>;
  /** The workspaces being read now, by customer ID. */
  logsLoading: Record<string, boolean>;
  /** Reads a workspace's schema (`schema.get`); only the latest read of that workspace is kept. */
  loadLogs(customerId: string, opts?: { refresh?: boolean }): Promise<void>;
  /** Forgets the workspace read errors and reads the open tabs' workspaces again (Log Analytics consent was granted). */
  reloadLogs(): void;
  /** Why a source's schema couldn't be read; it isn't read again until "Refresh schema" or another account. */
  errors: Partial<Record<SchemaSource, string>>;
  /** The report ID the host gave each of those errors, if it did. */
  errorReportIds: Partial<Record<SchemaSource, string>>;
  /** The sources being read now. */
  loading: Partial<Record<SchemaSource, boolean>>;
  /** The account's Resource Graph resource types (`arm.resourceTypes`), read with the Resource Graph schema. */
  resourceTypes: string[] | undefined;
  /** Why the resource types couldn't be read (an Azure consent, for one). */
  resourceTypesError: string | null;
  /** The report ID the host gave that error, if it did. */
  resourceTypesReportId: string | undefined;
  /** What helps when they couldn't be read: granting Azure access, signing in again, or nothing the panel can offer. */
  resourceTypesFix: ResourceTypesFix;
  /** For the active account, the columns Graph lists by default for each Graph table read so far, by table name
   * (`schema.listedByDefault`). A table not in it hasn't been read yet, so its columns get no "default" tag. */
  listedByDefault: Record<string, string[]>;
  /** Reads `listedByDefault` again: after the Graph schema is read, and after each Graph run, which may have read new tables. */
  loadListedByDefault(): Promise<void>;
  /** For the active account, the licenses Graph tables and columns need and whether its tenant has them (`schema.licenses`);
   * null until read, or when they couldn't be: then no table or column gets a license tag. */
  licenses: SchemaLicenses | null;
  /** Reads `licenses`: with the Graph schema, and again (from Graph, not the host's cache) when it is refreshed. */
  loadLicenses(opts?: { refresh?: boolean }): Promise<void>;
  /** Reads `source`'s schema (`schema.get`); `refresh` skips the host's cache. Resolves once it is read or has failed. */
  load(source: SchemaSource, opts?: { refresh?: boolean }): Promise<void>;
  /** Reads the resource types again (Azure access was granted, or the account signed in again), when a Resource Graph tab is
   * open; else does nothing, so no ARM token is asked for before one is needed (spec 6.7). */
  reloadResourceTypes(): Promise<void>;
  /** Forgets every schema (the active account changed): the open tabs' sources are read again. */
  reset(): void;
}

export type ResourceTypesFix = 'consent' | 'signIn' | null;

const empty = (): Pick<
  SchemasState,
  | 'byKey'
  | 'logsByWorkspace'
  | 'logsErrors'
  | 'logsConsent'
  | 'logsLoading'
  | 'errors'
  | 'errorReportIds'
  | 'loading'
  | 'resourceTypes'
  | 'resourceTypesError'
  | 'resourceTypesReportId'
  | 'resourceTypesFix'
  | 'listedByDefault'
  | 'licenses'
> => ({
  byKey: { graph: undefined, hunting: undefined, arg: undefined, logs: undefined, raw: undefined },
  logsByWorkspace: {},
  logsErrors: {},
  logsConsent: {},
  logsLoading: {},
  errors: {},
  errorReportIds: {},
  loading: {},
  resourceTypes: undefined,
  resourceTypesError: null,
  resourceTypesReportId: undefined,
  resourceTypesFix: null,
  listedByDefault: {},
  licenses: null,
});

const fixOf = (e: unknown): ResourceTypesFix =>
  e instanceof BridgeError && e.code === 'consentNeeded'
    ? 'consent'
    : e instanceof BridgeError && e.code === 'signInNeeded'
      ? 'signIn'
      : null;

/** Counts resets: an answer to a read started before the last one belongs to another account and is dropped. */
let generation = 0;
/** Counts each source's reads, and the resource types' reads: only the latest read's answer is kept, so an older read that answers
 * after a refresh can't replace it. */
const requests: Record<SchemaSource | 'types' | 'defaults' | 'licenses', number> = {
  graph: 0,
  hunting: 0,
  arg: 0,
  logs: 0,
  types: 0,
  defaults: 0,
  licenses: 0,
};

/** Counts each workspace's reads, so an answer for a workspace the tab has since left lands under its own ID only. */
const logsRequests = new Map<string, number>();

/**
 * One schema per source (spec 8), read lazily: a source is read when its first tab opens ({@link startSchemaLoading}), and read
 * again after the active account changes ({@link SchemasState.reset}). Resource Graph's resource types come from ARM, so they are
 * only asked for once a Resource Graph tab is open (spec 6.7: no ARM token before an ARG tab needs one).
 */
export const useSchemas = create<SchemasState>()((set) => ({
  ...empty(),

  async reloadResourceTypes() {
    if (!useTabs.getState().tabs.some((t) => t.source === 'arg')) {
      return;
    }
    // While they are read again, the panel says so rather than the problem just fixed.
    set((s) => (s.resourceTypesError ? { resourceTypesError: null, resourceTypesFix: null } : s));
    await readTypes();
  },

  async loadListedByDefault() {
    const at = generation;
    const request = ++requests.defaults;
    try {
      const answer = await call<ListedByDefault>('schema.listedByDefault', { source: 'graph' });
      if (at === generation && request === requests.defaults) {
        set({ listedByDefault: answer.tables });
      }
    } catch {
      // Only the tags are missing; the schema itself is unaffected, so nothing is shown.
    }
  },

  async loadLicenses(opts) {
    const at = generation;
    const request = ++requests.licenses;
    try {
      const answer = await call<SchemaLicenses>('schema.licenses', { source: 'graph', refresh: opts?.refresh ?? false });
      if (at === generation && request === requests.licenses) {
        set({ licenses: answer });
      }
    } catch {
      // Only the tags are missing; runs are unaffected, so nothing is shown.
    }
  },

  async loadLogs(customerId, opts) {
    const refresh = opts?.refresh ?? false;
    const at = generation;
    const request = (logsRequests.get(customerId) ?? 0) + 1;
    logsRequests.set(customerId, request);
    const latest = () => at === generation && request === logsRequests.get(customerId);
    set((s) => ({ logsLoading: { ...s.logsLoading, [customerId]: true } }));
    try {
      const view = await call<SchemaView>('schema.get', { source: 'logs', workspace: customerId, refresh });
      if (latest()) {
        set((s) => {
          const logsErrors = { ...s.logsErrors };
          delete logsErrors[customerId];
          const logsConsent = { ...s.logsConsent };
          delete logsConsent[customerId];
          return { logsByWorkspace: { ...s.logsByWorkspace, [customerId]: view }, logsErrors, logsConsent };
        });
      }
    } catch (e) {
      if (latest()) {
        set((s) => ({
          logsErrors: { ...s.logsErrors, [customerId]: errorText(e) },
          logsConsent: { ...s.logsConsent, [customerId]: e instanceof BridgeError && e.code === 'consentNeeded' },
        }));
      }
    } finally {
      if (latest()) {
        set((s) => ({ logsLoading: { ...s.logsLoading, [customerId]: false } }));
      }
    }
  },

  reloadLogs() {
    set({ logsErrors: {}, logsConsent: {} });
    loadMissing();
  },

  async load(source, opts) {
    // A Log Analytics schema belongs to a workspace: loadLogs reads it.
    if (source === 'logs') {
      return;
    }
    const refresh = opts?.refresh ?? false;
    const at = generation;
    const request = ++requests[source];
    const latest = () => at === generation && request === requests[source];
    set((s) => ({ loading: { ...s.loading, [source]: true } }));
    const types = source === 'arg' ? readTypes() : Promise.resolve();
    try {
      const view = await call<SchemaView>('schema.get', { source, refresh });
      if (latest()) {
        set((s) => {
          const errors = { ...s.errors };
          delete errors[source];
          return { byKey: { ...s.byKey, [source]: view }, errors };
        });
        if (source === 'graph') {
          void useSchemas.getState().loadListedByDefault();
          void useSchemas.getState().loadLicenses({ refresh });
        }
      }
    } catch (e) {
      if (latest()) {
        set((s) => ({ errors: { ...s.errors, [source]: errorText(e) }, errorReportIds: { ...s.errorReportIds, [source]: reportIdOf(e) } }));
      }
    } finally {
      if (latest()) {
        set((s) => ({ loading: { ...s.loading, [source]: false } }));
      }
    }
    await types;
  },

  reset() {
    generation++;
    set(empty());
  },
}));

/** Reads the resource types (`arm.resourceTypes`); only the latest read's answer is kept. */
async function readTypes() {
  const at = generation;
  const request = ++requests.types;
  const latest = () => at === generation && request === requests.types;
  try {
    const answer = await call<ArmResourceTypesAnswer>('arm.resourceTypes');
    if (latest()) {
      useSchemas.setState({ resourceTypes: answer.types, resourceTypesError: null, resourceTypesFix: null });
    }
  } catch (e) {
    if (latest()) {
      useSchemas.setState({ resourceTypesError: errorText(e), resourceTypesReportId: reportIdOf(e), resourceTypesFix: fixOf(e) });
    }
  }
}

/** Reads the schema of every source an open tab has that isn't read, being read, or failed. */
function loadMissing() {
  const { byKey, errors, loading, load, logsByWorkspace, logsErrors, logsLoading, loadLogs } = useSchemas.getState();
  const tabs = useTabs.getState().tabs;
  for (const source of new Set(tabs.map((t) => schemaSourceOf(t.source)))) {
    if (!byKey[source] && !errors[source] && !loading[source]) {
      void load(source);
    }
  }
  for (const id of new Set(tabs.flatMap((t) => (t.source === 'logs' ? [t.options?.workspaces?.[0]?.customerId] : [])))) {
    if (id && !logsByWorkspace[id] && !logsErrors[id] && !logsLoading[id]) {
      void loadLogs(id);
    }
  }
}

type Tabs = ReturnType<typeof useTabs.getState>['tabs'];

/** Whether a Graph run finished since `previous`: the host may have learnt a table's default columns during it. */
function graphRunFinished(tabs: Tabs, previous: Tabs): boolean {
  const before = new Map(previous.map((t) => [t.id, t.run]));
  return tabs.some(
    (t) =>
      t.run &&
      t.run !== before.get(t.id) &&
      t.run.state === 'done' &&
      (t.run.source ?? 'graph') === 'graph' &&
      before.get(t.id)?.state === 'running',
  );
}

/** Starts reading schemas as tabs of each source open, and again after a reset; returns the function that stops it. */
export function startSchemaLoading(): () => void {
  const stopTabs = useTabs.subscribe((state, previous) => {
    if (state.tabs !== previous.tabs) {
      loadMissing();
      if (graphRunFinished(state.tabs, previous.tabs)) {
        void useSchemas.getState().loadListedByDefault();
      }
    }
  });
  const stopSchemas = useSchemas.subscribe((state, previous) => {
    if (state.byKey !== previous.byKey && Object.values(state.byKey).every((v) => v === undefined)) {
      loadMissing();
    }
  });
  loadMissing();
  return () => {
    stopTabs();
    stopSchemas();
  };
}
