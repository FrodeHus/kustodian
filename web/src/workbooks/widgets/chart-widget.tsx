import { Suspense, lazy } from 'react';
import type { Picked } from '../../results/chart-view';
import { ChartFailed } from '../../results/result-panel';
import type { Widget } from '../model';
import type { WidgetRun } from '../workbook-store';

// The same chunk the result panel's Chart tab loads.
const ChartView = lazy(() => import('../../results/chart-view'));

/** A chart widget: the result panel's chart, with the picks the workbook view holds. */
export function ChartWidget({ widget, run, picked, onChart }: { widget: Widget; run: WidgetRun; picked: Picked; onChart?: (picked: Picked) => void }) {
  if (run.state !== 'done') {
    return null;
  }
  return (
    <ChartFailed>
      <Suspense fallback={<p className="faint m-0 p-4 text-[12px]">Loading the chart…</p>}>
        <ChartView
          columns={run.result.columns}
          rows={run.result.rows}
          kql={widget.query?.text ?? ''}
          picked={picked}
          setPicked={(p) => onChart?.(p)}
        />
      </Suspense>
    </ChartFailed>
  );
}
