import { Suspense, lazy, useContext, useMemo } from 'react';
import { ChartFailed } from '../../results/result-panel';
import { HistoryData, withGaps } from '../history';
import type { Widget } from '../model';
import type { WidgetRun } from '../workbook-store';

// The same chunk the result panel's Chart tab loads.
const ChartView = lazy(() => import('../../results/chart-view'));

/** A chart widget: the result panel's chart alone, drawn as the widget's own chart settings say. They are set in the widget
 * editor's Visualization tab, so the widget has no pickers of its own, in view mode, edit mode or full screen. With Values
 * history it plots every retained snapshot against a `Snapshot` axis, with a gap on each day that has none. */
export function ChartWidget({ widget, run }: { widget: Widget; run: WidgetRun }) {
  const { values } = useContext(HistoryData);
  const history = widget.history;
  // Stable inputs, so the chart's own memo holds across the workbook's re-renders.
  const gapped = useMemo(
    () => (history?.mode === 'values' && values?.snapshots.length ? withGaps(values.snapshots, history.interval) : null),
    [history, values],
  );
  const chart = widget.chart;
  const picked = useMemo(() => (gapped ? { ...chart, x: 'Snapshot' } : (chart ?? {})), [gapped, chart]);
  if (run.state !== 'done') {
    return null;
  }
  const table = gapped ?? run.result;
  return (
    <ChartFailed>
      <Suspense fallback={<p className="faint m-0 p-4 text-[12px]">Loading the chart…</p>}>
        <ChartView
          columns={table.columns}
          rows={table.rows}
          kql={widget.query?.text ?? ''}
          picked={picked}
          controls={false}
        />
      </Suspense>
    </ChartFailed>
  );
}
