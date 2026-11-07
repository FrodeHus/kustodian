import type { StoreApi, UseBoundStore } from 'zustand';
import { create } from 'zustand';

interface SolutionDialogState {
  /** The solution the dialog shows; null when it is closed. */
  id: string | null;
  /** False when the solution needs a newer Kustodian (the catalog's `compatible`): Install is off. */
  compatible: boolean;
  open(id: string, compatible?: boolean): void;
  close(): void;
}

export const useSolutionDialog: UseBoundStore<StoreApi<SolutionDialogState>> = create<SolutionDialogState>()((set) => ({
  id: null,
  compatible: true,
  open: (id, compatible = true) => set({ id, compatible }),
  close: () => set({ id: null }),
}));
