import { findParams } from '../params/find-params';
import { NUMERIC } from '../results/column-stats';
import type { Picked } from '../results/chart-view';
import type { Tab } from '../tabs/tab-store';
import type { ParameterDef, RunResult } from '../wire';
import { COLUMNS } from './layout';
import { MAX_WIDGETS, MIN_SIZE, newWidget, withHighlights } from './model';
import type { Widget, WidgetQuery, WorkbookDoc, WorkbookParameter } from './model';

export type AddKind = 'table' | 'chart' | 'stat';
export type ResultView = 'rows' | 'chart' | 'json' | 'diagnostics' | 'compare';

/** Chart when the view is the chart, Stat for a one-row single-number result, Table otherwise. */
export function defaultKind(result: RunResult, view: ResultView | undefined): AddKind {
  if (view === 'chart') {
    return 'chart';
  }
  return result.rows.length === 1 && result.columns.length === 1 && NUMERIC.has(result.columns[0]?.type ?? '') ? 'stat' : 'table';
}

/** Whether the widget will link to the tab's saved query (saved and not dirty). */
export const linksSaved = (tab: Pick<Tab, 'savedId' | 'dirty'>): boolean => !!tab.savedId && !tab.dirty;

/** The widget for the tab: query linked or copied, chart picks for a chart, title; layout x/y left 0 (addWidget places it). */
export function widgetFromTab(tab: Tab, kind: AddKind, title: string, chart: Picked | undefined): Widget {
  const widget = newWidget(kind, { x: 0, y: 0, ...MIN_SIZE[kind] });
  widget.title = title;
  const query: WidgetQuery = {
    // Callers offer query tabs only (never raw or workbook).
    source: tab.source as WidgetQuery['source'],
    text: tab.text,
    options: tab.options ?? null,
    parameters: tab.parameters,
    saved: linksSaved(tab) ? { id: tab.savedId!, name: tab.title } : null,
  };
  widget.query = withHighlights(query, tab.highlights);
  if (kind === 'chart' && chart) {
    widget.chart = chart;
  }
  return widget;
}

/** The doc with the widget placed below the lowest top-level widget and the tab's {name} parameters added where missing. */
export function addWidget(doc: WorkbookDoc, widget: Widget, tabParameters: ParameterDef[]): WorkbookDoc {
  const y = Math.max(0, ...doc.widgets.filter((w) => !w.in).map((w) => w.layout.y + w.layout.h));
  const min = MIN_SIZE[widget.type];
  const layout = widget.type === 'stat' ? { x: 0, y, ...min } : { x: 0, y, w: COLUMNS, h: min.h };
  const names = findParams(widget.query?.text ?? '');
  const added: WorkbookParameter[] = names
    .filter((n) => !doc.parameters.some((p) => p.name === n))
    .map((name) => ({
      ...(tabParameters.find((p) => p.name === name) ?? { name, type: 'text', value: '', required: false, choices: null }),
      label: null,
      multi: false,
      all: false,
      remember: false,
      huntingTimespan: false,
    }));
  const parameters = Object.fromEntries(names.map((n) => [n, { from: 'workbook' as const, value: '' }]));
  return { ...doc, parameters: [...doc.parameters, ...added], widgets: [...doc.widgets, { ...widget, layout, parameters }] };
}

export const isFull = (doc: Pick<WorkbookDoc, 'widgets'>): boolean => doc.widgets.length >= MAX_WIDGETS;
