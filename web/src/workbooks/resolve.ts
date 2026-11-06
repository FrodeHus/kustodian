import { findParams } from '../params/find-params';
import { runOptions } from '../tabs/tab-store';
import type { ParameterValue, QueryOptions } from '../wire';
import type { ParamFrom, Widget, WorkbookDoc } from './model';
import { isoTimespan } from './model';

/** Current values: the workbook's by parameter name, and each widget's shown/fixed ones by widget id. Never in the file. */
export interface ViewValues {
  workbook: Record<string, string>;
  widgets: Record<string, Record<string, string>>;
}

export interface ResolvedParam {
  name: string;
  type: string;
  value: string;
  required: boolean;
  from: ParamFrom;
}

/** Each placeholder of the widget's query, resolved (spec 6.2): a widget entry that is shown or fixed, else the workbook's
 * parameter of that name, else a shown one from the query's own definition (an undefined name is an empty, optional text). */
export function widgetParams(doc: WorkbookDoc, widget: Widget, values: ViewValues): ResolvedParam[] {
  if (!widget.query) {
    return [];
  }
  const { query } = widget;
  return findParams(query.text).map((name) => {
    const entry = widget.parameters[name];
    const own = values.widgets[widget.id]?.[name];
    const wb = doc.parameters.find((p) => p.name === name);
    const def = query.parameters.find((p) => p.name === name) ?? wb;
    const shape = { name, type: def?.type ?? 'text', required: def?.required ?? false };
    if (entry?.from === 'fixed') {
      return { ...shape, value: entry.value, from: 'fixed' as const };
    }
    if (entry?.from === 'widget') {
      return { ...shape, value: own ?? entry.value, from: 'widget' as const };
    }
    if (wb) {
      // The workbook parameter owns type and required for the widgets that take it (spec 6.2/6.3).
      return { name, type: wb.type, required: wb.required, value: values.workbook[name] ?? wb.value, from: 'workbook' as const };
    }
    return { ...shape, value: own ?? def?.value ?? '', from: 'widget' as const };
  });
}

/** Names of required parameters without a value. */
export function missingRequired(params: ResolvedParam[]): string[] {
  return params.filter((p) => p.required && p.value.trim() === '').map((p) => p.name);
}

export function toParameterValues(params: ResolvedParam[]): ParameterValue[] {
  return params.map(({ name, type, value, required }) => ({ name, type, value, required }));
}

/** Widgets a change to workbook parameter `name` reruns: data widgets whose resolved `name` comes from the workbook. */
export function widgetsUsing(doc: WorkbookDoc, name: string): string[] {
  const none: ViewValues = { workbook: {}, widgets: {} };
  return doc.widgets
    .filter((w) => widgetParams(doc, w, none).some((p) => p.name === name && p.from === 'workbook'))
    .map((w) => w.id);
}

/** The hunting timespan a widget sends: the huntingTimespan parameter's ISO value, else the widget's own options. */
export function widgetRunOptions(doc: WorkbookDoc, widget: Widget, values: ViewValues): QueryOptions | null | { problem: string } {
  if (!widget.query) {
    return null;
  }
  const hunting = widget.query.source === 'hunting' ? doc.parameters.find((p) => p.huntingTimespan) : undefined;
  if (hunting) {
    const entry = widget.parameters[hunting.name];
    // A widget that sets the parameter itself (shown or fixed) overrides the workbook's value (spec 6.4).
    const value =
      entry?.from === 'fixed'
        ? entry.value
        : entry?.from === 'widget'
          ? (values.widgets[widget.id]?.[hunting.name] ?? entry.value)
          : (values.workbook[hunting.name] ?? hunting.value);
    const timespan = isoTimespan(value.trim());
    return timespan ? { timespan, scope: null } : { problem: `${hunting.name}: at most 30 days for Defender hunting.` };
  }
  return runOptions({ source: widget.query.source, options: widget.query.options ?? undefined }) ?? null;
}

/** The workbook's values on opening: each parameter's default, or the remembered value for those marked `remember`. */
export function initialValues(doc: WorkbookDoc, remembered: Record<string, string>): ViewValues {
  const workbook: Record<string, string> = {};
  for (const p of doc.parameters) {
    workbook[p.name] = (p.remember ? remembered[p.name] : undefined) ?? p.value;
  }
  return { workbook, widgets: {} };
}
