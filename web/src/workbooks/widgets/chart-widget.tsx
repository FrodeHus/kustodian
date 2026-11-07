import { Suspense, lazy } from 'react';
import { ChartFailed } from '../../results/result-panel';
import type { Widget } from '../model';
import type { WidgetRun } from '../workbook-store';

// The same chunk the result panel's Chart tab loads.
const ChartView = lazy(() => import('../../results/chart-view'));

/** A chart widget: the result panel's chart alone, drawn as the widget's own chart settings say. They are set in the widget
 * editor's Visualization tab, so the widget has no pickers of its own, in view mode, edit mode or full screen. */
export function ChartWidget({ widget, run }: { widget: Widget; run: WidgetRun }) {
  if (run.state !== 'done') {
    return null;
  }
  return (
    <ChartFailed>
      <Suspense fallback={<p className="faint m-0 p-4 text-[12px]">Loading the chart…</p>}>
        <ChartView columns={run.result.columns} rows={run.result.rows} kql={widget.query?.text ?? ''} picked={widget.chart ?? {}} controls={false} />
      </Suspense>
    </ChartFailed>
  );
}
