import type { StoreApi, UseBoundStore } from 'zustand';
import { create } from 'zustand';
import { call } from '../bridge';
import type { GraphSchemaStatus } from '../wire';

interface GraphSchemaUpdateState {
  /** The host's last answer; null until the first one. */
  status: GraphSchemaStatus | null;
  /** True while `schema.checkGraph` runs. */
  checking: boolean;
  /** Asks the repository for a newer schema (`force`: download it again even when it is the one in use). Rejects with the
   * host's error; the status stays as it was then. */
  check(force?: boolean): Promise<GraphSchemaStatus>;
  /** Reads the status without asking the repository. */
  load(): Promise<void>;
}

/** The Graph schema in use and any newer one downloaded since the start (the footer and Settings both show it). */
export const useGraphSchemaUpdate: UseBoundStore<StoreApi<GraphSchemaUpdateState>> = create<GraphSchemaUpdateState>()((set) => ({
  status: null,
  checking: false,
  async check(force = false) {
    set({ checking: true });
    try {
      const status = await call<GraphSchemaStatus>('schema.checkGraph', { force });
      set({ status });
      return status;
    } finally {
      set({ checking: false });
    }
  },
  async load() {
    set({ status: await call<GraphSchemaStatus>('schema.graphStatus') });
  },
}));
