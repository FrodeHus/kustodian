import { useId, useMemo, useState } from 'react';
import type { Row } from '../../results/export';
import { ResultGrid, type GridSelection } from '../../results/result-grid';
import { RowDetails } from '../../results/row-details';
import type { Widget } from '../model';
import { useWorkbooks, type WidgetRun } from '../workbook-store';

/** A table widget: the result grid, its tools in a bar of their own. With a `tabId` its row selection lives in the store, for
 * its tool buttons; without one (the editor's preview) the grid keeps its own. */
export function TableWidget({ widget, run, tabId }: { widget: Widget; run: WidgetRun; tabId?: string }) {
  const kept = useWorkbooks((s) => (tabId ? s.byTab[tabId]?.selections[widget.id]?.selected : undefined));
  const mode = widget.selection ?? 'multi';
  const id = useId();
  // The opened row, with the rows it indexes: a rerun's new rows close it.
  const [details, setDetails] = useState<{ rows: Row[]; index: number } | null>(null);
  // The store keeps the old selection until the rerun answers; with selection off it counts as empty.
  const selected = useMemo(() => new Set(mode === 'none' ? [] : (kept ?? [])), [kept, mode]);
  const selection: GridSelection | 'none' | undefined =
    tabId === undefined
      ? undefined
      : mode === 'none'
        ? 'none'
        : { mode, selected, onChange: (s) => useWorkbooks.getState().setSelection(tabId, widget.id, [...s]) };
  if (run.state !== 'done') {
    return null;
  }
  const inspected = details?.rows === run.result.rows ? details.index : null;
  const detailsRow = inspected === null ? undefined : run.result.rows[inspected];
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <ResultGrid
        columns={run.result.columns}
        rows={run.result.rows}
        selection={selection}
        onOpenRow={(index) => setDetails(index === null ? null : { rows: run.result.rows, index })}
        inspected={inspected}
        inspectorId={`${id}-details`}
        onShownChange={tabId === undefined ? undefined : (shown) => useWorkbooks.getState().setShown(tabId, widget.id, shown)}
      />
      {detailsRow && <RowDetails id={`${id}-details`} columns={run.result.columns} row={detailsRow} onClose={() => setDetails(null)} />}
    </div>
  );
}
