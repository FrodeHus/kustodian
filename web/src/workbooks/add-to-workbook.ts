import { findParams } from '../params/find-params';
import { NUMERIC } from '../results/column-stats';
import type { Picked } from '../results/chart-shape';
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

/** An added Table's or Chart's height: MIN_SIZE shows about one row. */
const ADDED_HEIGHT = 16;

/** The text the tab's last run sent (a block or selection, often), or the tab's text when it hasn't run. */
const ranText = (tab: Pick<Tab, 'text' | 'run'>): string => tab.run?.kql ?? tab.text;

/** Whether the widget will link to the tab's saved query: saved, not dirty, and the run sent the whole text. */
export const linksSaved = (tab: Pick<Tab, 'savedId' | 'dirty' | 'text' | 'run'>): boolean =>
  !!tab.savedId && !tab.dirty && ranText(tab).trim() === tab.text.trim();

/** The widget for the tab: the query that ran, linked or copied, chart picks for a chart, title; addWidget places it. */
export function widgetFromTab(tab: Tab, kind: AddKind, title: string, chart: Picked | undefined): Widget {
  const widget = newWidget(kind, { x: 0, y: 0, ...MIN_SIZE[kind] });
  widget.title = title;
  const text = ranText(tab);
  const linked = linksSaved(tab);
  const names = findParams(text);
  const query: WidgetQuery = {
    // Callers offer query tabs only (never raw or workbook).
    source: tab.source as WidgetQuery['source'],
    text,
    options: tab.options ?? null,
    // A linked query keeps the saved query's parameters; a copy takes those its text uses.
    parameters: linked ? tab.parameters : tab.parameters.filter((p) => names.includes(p.name)),
    saved: linked ? { id: tab.savedId!, name: tab.title } : null,
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
  const layout = widget.type === 'stat' ? { x: 0, y, ...MIN_SIZE.stat } : { x: 0, y, w: COLUMNS, h: ADDED_HEIGHT };
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
