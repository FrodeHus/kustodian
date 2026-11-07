import { useMemo } from 'react';
import { ResultGrid, type GridSelection } from '../../results/result-grid';
import type { Widget } from '../model';
import { useWorkbooks, type WidgetRun } from '../workbook-store';

/** A table widget: the result grid, its tools in a bar of their own. With a `tabId` its row selection lives in the store, for
 * its tool buttons; without one (the editor's preview) the grid keeps its own. */
export function TableWidget({ widget, run, tabId }: { widget: Widget; run: WidgetRun; tabId?: string }) {
  const kept = useWorkbooks((s) => (tabId ? s.byTab[tabId]?.selections[widget.id]?.selected : undefined));
  const mode = widget.selection ?? 'multi';
  // The store keeps the old selection until the rerun answers; with selection off it counts as empty.
  const selected = useMemo(() => new Set(mode === 'none' ? [] : (kept ?? [])), [kept, mode]);
  const selection: GridSelection | 'none' | undefined =
    tabId === undefined
      ? undefined
      : mode === 'none'
        ? 'none'
        : { mode, selected, onChange: (s) => useWorkbooks.getState().setSelection(tabId, widget.id, [...s]) };
  return run.state === 'done' ? (
    <div className="flex min-h-0 flex-1 flex-col">
      <ResultGrid
        columns={run.result.columns}
        rows={run.result.rows}
        selection={selection}
        onShownChange={tabId === undefined ? undefined : (shown) => useWorkbooks.getState().setShown(tabId, widget.id, shown)}
      />
    </div>
  ) : null;
}
