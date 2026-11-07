import { ResultGrid } from '../../results/result-grid';
import type { Widget } from '../model';
import type { WidgetRun } from '../workbook-store';

/** A table widget: the result grid, its tools in a bar of their own. */
export function TableWidget({ run }: { widget: Widget; run: WidgetRun }) {
  return run.state === 'done' ? (
    <div className="flex min-h-0 flex-1 flex-col">
      <ResultGrid columns={run.result.columns} rows={run.result.rows} />
    </div>
  ) : null;
}
