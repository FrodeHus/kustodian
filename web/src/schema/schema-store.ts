import { create } from 'zustand';
import { BridgeError, call } from '../bridge';
import { errorText } from '../shell/errors';
import { useTabs } from '../tabs/tab-store';
import type { ArmResourceTypesAnswer, SchemaView, Source } from '../wire';

/** The sources with a schema of their own. A raw request tab completes against Graph's. */
export type SchemaSource = Exclude<Source, 'raw'>;

/** The schema a tab of `source` uses: a raw request tab uses Graph's. */
export const schemaSourceOf = (source: Source): SchemaSource => (source === 'raw' ? 'graph' : source);

interface SchemasState {
  /** Each source's schema, once read. */
  byKey: Record<Source, SchemaView | undefined>;
  /** Why a source's schema couldn't be read; it isn't read again until "Refresh schema" or another account. */
  errors: Partial<Record<SchemaSource, string>>;
  /** The sources being read now. */
  loading: Partial<Record<SchemaSource, boolean>>;
  /** The account's Resource Graph resource types (`arm.resourceTypes`), read with the Resource Graph schema. */
  resourceTypes: string[] | undefined;
  /** Why the resource types couldn't be read (an Azure consent, for one). */
  resourceTypesError: string | null;
  /** What helps when they couldn't be read: granting Azure access, signing in again, or nothing the panel can offer. */
  resourceTypesFix: ResourceTypesFix;
  /** Reads `source`'s schema (`schema.get`); `refresh` skips the host's cache. Resolves once it is read or has failed. */
  load(source: SchemaSource, opts?: { refresh?: boolean }): Promise<void>;
  /** Reads the resource types again (Azure access was granted, or the account signed in again), when a Resource Graph tab is
   * open; else does nothing, so no ARM token is asked for before one is needed (spec 6.7). */
  reloadResourceTypes(): Promise<void>;
  /** Forgets every schema (the active account changed): the open tabs' sources are read again. */
  reset(): void;
}

export type ResourceTypesFix = 'consent' | 'signIn' | null;

const empty = (): Pick<SchemasState, 'byKey' | 'errors' | 'loading' | 'resourceTypes' | 'resourceTypesError' | 'resourceTypesFix'> => ({
  byKey: { graph: undefined, hunting: undefined, arg: undefined, raw: undefined },
  errors: {},
  loading: {},
  resourceTypes: undefined,
  resourceTypesError: null,
  resourceTypesFix: null,
});

const fixOf = (e: unknown): ResourceTypesFix =>
  e instanceof BridgeError && e.code === 'consentNeeded' ? 'consent' : e instanceof BridgeError && e.code === 'signInNeeded' ? 'signIn' : null;

/** Counts resets: an answer to a read started before the last one belongs to another account and is dropped. */
let generation = 0;
/** Counts each source's reads, and the resource types' reads: only the latest read's answer is kept, so an older read that answers
 * after a refresh can't replace it. */
const requests: Record<SchemaSource | 'types', number> = { graph: 0, hunting: 0, arg: 0, types: 0 };

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

  async load(source, opts) {
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
      }
    } catch (e) {
      if (latest()) {
        set((s) => ({ errors: { ...s.errors, [source]: errorText(e) } }));
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
      useSchemas.setState({ resourceTypesError: errorText(e), resourceTypesFix: fixOf(e) });
    }
  }
}

/** Reads the schema of every source an open tab has that isn't read, being read, or failed. */
function loadMissing() {
  const { byKey, errors, loading, load } = useSchemas.getState();
  const needed = new Set(useTabs.getState().tabs.map((t) => schemaSourceOf(t.source)));
  for (const source of needed) {
    if (!byKey[source] && !errors[source] && !loading[source]) {
      void load(source);
    }
  }
}

/** Starts reading schemas as tabs of each source open, and again after a reset; returns the function that stops it. */
export function startSchemaLoading(): () => void {
  const stopTabs = useTabs.subscribe((state, previous) => {
    if (state.tabs !== previous.tabs) {
      loadMissing();
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
