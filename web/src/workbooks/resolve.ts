import { findParams } from '../params/find-params';
import { runOptions } from '../tabs/tab-store';
import type { ParameterValue, QueryOptions } from '../wire';
import type { ParamFrom, Widget, WorkbookDoc, WorkbookParameter } from './model';
import { isoTimespan } from './model';

/** Current values: the workbook's by parameter name, and each widget's shown/fixed ones by widget id. Never in the file. */
export interface ViewValues {
  workbook: Record<string, string>;
  widgets: Record<string, Record<string, string>>;
}

/** `o[key]` when `o` has it as its own key; names come from query text, so `constructor` must not read Object's. */
const at = <T>(o: Record<string, T> | undefined, key: string): T | undefined => (o && Object.hasOwn(o, key) ? o[key] : undefined);

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
    const entry = at(widget.parameters, name);
    const own = at(at(values.widgets, widget.id), name);
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
      return { name, type: wb.type, required: wb.required, value: at(values.workbook, name) ?? wb.value, from: 'workbook' as const };
    }
    return { ...shape, value: own ?? def?.value ?? '', from: 'widget' as const };
  });
}

/** Names of required parameters without a value. */
export function missingRequired(params: ResolvedParam[]): string[] {
  return params.filter((p) => p.required && p.value.trim() === '').map((p) => p.name);
}

export function toParameterValues(params: ResolvedParam[]): ParameterValue[] {
  return params.map(({ name, type, value, required }) => ({ name, type: type === 'workspace' ? 'text' : type, value, required }));
}

/** Widgets a change to workbook parameter `name` reruns: data widgets whose resolved `name` comes from the workbook, and,
 * for the huntingTimespan parameter, the hunting and Log Analytics widgets that send its value as their timespan. */
export function widgetsUsing(doc: WorkbookDoc, name: string): string[] {
  const none: ViewValues = { workbook: {}, widgets: {} };
  const sends = doc.parameters.find((p) => p.huntingTimespan)?.name === name || workspaceParameter(doc)?.name === name;
  return doc.widgets
    .filter(
      (w) =>
        widgetParams(doc, w, none).some((p) => p.name === name && p.from === 'workbook') ||
        (sends && takesTimespan(w.query?.source) && (at(w.parameters, name)?.from ?? 'workbook') === 'workbook'),
    )
    .map((w) => w.id);
}

const takesTimespan = (source: string | undefined) => source === 'hunting' || source === 'logs';

/** The workspace parameter picker's copy, in place of the hunting tab's. */
export const PARAM_NONE = 'Log Analytics widgets wait for a workspace; hunting widgets use your primary workspace.';
export const PARAM_FOOTER = 'Every Log Analytics and hunting widget in this workbook uses it.';

/** A GUID in "D" format, as a workspace's customer id is. */
export const isGuid = (v: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

/** The workbook's workspace parameter: the first one. */
export const workspaceParameter = (doc: WorkbookDoc): WorkbookParameter | undefined => doc.parameters.find((p) => p.type === 'workspace');

/** A parameter's value for a widget: its shown or fixed entry, else the workbook's current value (spec 6.4). */
function valueFor(widget: Widget, values: ViewValues, p: WorkbookParameter): string {
  const entry = at(widget.parameters, p.name);
  return entry?.from === 'fixed'
    ? entry.value
    : entry?.from === 'widget'
      ? (at(at(values.widgets, widget.id), p.name) ?? entry.value)
      : (at(values.workbook, p.name) ?? p.value);
}

/** The workspace a Log Analytics or hunting widget runs against: `set` false without a workspace parameter (the widget's own
 * options apply), else the resolved customer id, '' for none. */
export function widgetWorkspace(doc: WorkbookDoc, widget: Widget, values: ViewValues): { set: boolean; customerId: string } {
  const p = workspaceParameter(doc);
  return p ? { set: true, customerId: valueFor(widget, values, p).trim() } : { set: false, customerId: '' };
}

/** The hunting timespan a widget sends: the huntingTimespan parameter's ISO value, else the widget's own options. */
export function widgetRunOptions(doc: WorkbookDoc, widget: Widget, values: ViewValues): QueryOptions | null | { problem: string } {
  if (!widget.query) {
    return null;
  }
  const ws = takesTimespan(widget.query.source) ? widgetWorkspace(doc, widget, values) : { set: false, customerId: '' };
  const hunting = takesTimespan(widget.query.source) ? doc.parameters.find((p) => p.huntingTimespan) : undefined;
  if (hunting) {
    const value = valueFor(widget, values, hunting);
    // Only the timespan is replaced; a workspace reaches back further (host: 730 days) than the default 30, and Log Analytics always does.
    const workspaces = workspacesOf(widget, ws);
    const logs = widget.query.source === 'logs';
    const maxDays = logs || workspaces?.length ? 730 : 30;
    const timespan = isoTimespan(value.trim(), maxDays);
    return timespan
      ? { timespan, scope: null, ...(workspaces && { workspaces }) }
      : { problem: huntingTimespanProblem(hunting.name, value, maxDays, logs ? 'Log Analytics' : 'Defender hunting') ?? '' };
  }
  const base = runOptions({ source: widget.query.source, options: widget.query.options ?? undefined }) ?? null;
  return base && ws.set ? { ...base, workspaces: workspacesOf(widget, ws) ?? null } : base;
}

/** The workspaces a widget sends: the parameter's when the workbook has one (none when empty), else the widget's own. */
const workspacesOf = (widget: Widget, ws: { set: boolean; customerId: string }) =>
  ws.set ? (ws.customerId ? [{ customerId: ws.customerId, name: '', resourceId: '' }] : undefined) : widget.query?.options?.workspaces;

/** The workbook's values on opening: each parameter's default, or the remembered value for those marked `remember`. */
export function initialValues(doc: WorkbookDoc, remembered: Record<string, string>): ViewValues {
  const workbook: Record<string, string> = {};
  for (const p of doc.parameters) {
    workbook[p.name] = (p.remember ? remembered[p.name] : undefined) ?? p.value;
  }
  return { workbook, widgets: {} };
}

/** Each workbook parameter's current value: the one set in the view, else its default (a parameter added since opening has
 * no view value yet). */
export function workbookValues(doc: WorkbookDoc, values: ViewValues): Record<string, string> {
  return Object.fromEntries(doc.parameters.map((p) => [p.name, at(values.workbook, p.name) ?? p.value]));
}

/** Why `value` can't be the Defender hunting timespan, said on the parameter and on the widgets it stops; null when it can. */
export function huntingTimespanProblem(name: string, value: string, maxDays = 30, what = 'Defender hunting'): string | null {
  const v = value.trim();
  if (isoTimespan(v, maxDays)) {
    return null;
  }
  // The KQL form, but zero or over the limit; anything else isn't a timespan Kustodian converts.
  const inRange = /^([0-9]+(?:\.[0-9]+)?)(d|h|m|s|ms)$/.exec(v);
  return inRange && Number(inRange[1]) > 0
    ? `${name}: at most ${maxDays} days for ${what}.`
    : `${name}: a timespan such as 7d, 12h or 30m for ${what}.`;
}
