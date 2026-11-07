import type { Picked } from '../results/chart-view';
import type { ParameterDef, QueryOptions, Source } from '../wire';

export const WORKBOOK_KIND = 'kustodian.workbook';
export const WORKBOOK_VERSION = 1;
/** As the host's WorkbookService.MaxWidgets: a save with more is refused, so the editor stops adding at this many. */
export const MAX_WIDGETS = 100;

export type WidgetType = 'markdown' | 'chart' | 'table' | 'stat';
export interface WidgetLayout {
  x: number;
  y: number;
  w: number;
  h: number;
}
export type ParamFrom = 'workbook' | 'widget' | 'fixed';
export interface WidgetParam {
  from: ParamFrom;
  value: string;
}
export interface WidgetQuery {
  source: Exclude<Source, 'raw'>;
  text: string;
  options: QueryOptions | null;
  parameters: ParameterDef[];
  /** Set for a linked saved query; text, source, options and parameters are then the last copy of it (spec §9.2). */
  saved: { id: string; name: string } | null;
}
export type RowSelectionMode = 'multi' | 'single' | 'none';
export interface ToolButton {
  label: string;
  /** A tool's name in the user's tools.json. Never a command (spec §4). */
  tool: string;
  /** Tool parameter → result column; '' or missing means "as defaultMapping picks". */
  mapping: Record<string, string>;
  runsOn: 'selectedOrAll' | 'selected';
  after: 'refreshWidget' | 'refreshWorkbook' | 'none';
  placement: 'header' | 'menu';
}
export interface Widget {
  id: string;
  type: WidgetType;
  title: string;
  /** Out of edit mode, the widget shows no title bar (and so no ⋯ menu); edit mode always shows it. */
  hideTitle?: boolean;
  layout: WidgetLayout;
  markdown?: string;
  query?: WidgetQuery;
  parameters: Record<string, WidgetParam>;
  chart?: Picked;
  stat?: { value: string | null; compare: string | null };
  selection?: RowSelectionMode; // table widgets only
  tools?: ToolButton[]; // table widgets only
  history?: WidgetHistory; // stat, chart and table widgets only
}
/** What the widget keeps between runs. `since` is `'previous'`, `'P1D'`, `'P7D'`, `'P30D'` or a `YYYY-MM-DD` date. */
export interface WidgetHistory {
  mode: 'values' | 'rows';
  interval: 'run' | 'day' | 'week';
  retentionDays: 30 | 90 | 365;
  keys: string[];
  keep: string[];
  since: string;
}
export interface WorkbookParameter extends ParameterDef {
  label: string | null;
  multi: boolean;
  all: boolean;
  remember: boolean;
  huntingTimespan: boolean;
}
export interface WorkbookDoc {
  kind: typeof WORKBOOK_KIND;
  version: typeof WORKBOOK_VERSION;
  id: string;
  name: string;
  folder: string | null;
  parameters: WorkbookParameter[];
  widgets: Widget[];
  modifiedAt?: string;
}

const COLUMNS = 12;
const WIDGET_TYPES: WidgetType[] = ['markdown', 'chart', 'table', 'stat'];
const SOURCES = ['graph', 'hunting', 'arg'];

export const MIN_SIZE: Record<WidgetType, { w: number; h: number }> = {
  markdown: { w: 2, h: 3 },
  stat: { w: 2, h: 6 },
  table: { w: 3, h: 8 },
  chart: { w: 3, h: 12 },
};

export function newWorkbook(name: string): WorkbookDoc {
  return {
    kind: WORKBOOK_KIND,
    version: WORKBOOK_VERSION,
    id: crypto.randomUUID(),
    name,
    folder: null,
    parameters: [],
    widgets: [],
  };
}

const emptyQuery = (): WidgetQuery => ({ source: 'graph', text: '', options: null, parameters: [], saved: null });

const newWidgetId = () => `w${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}`;

export function newWidget(type: WidgetType, layout: WidgetLayout): Widget {
  const widget: Widget = { id: newWidgetId(), type, title: '', layout, parameters: {} };
  if (type !== 'markdown') {
    widget.query = emptyQuery();
  }
  if (type === 'table') {
    widget.selection = 'multi';
    widget.tools = [];
  }
  return widget;
}

export const newToolButton = (): ToolButton => ({
  label: '',
  tool: '',
  mapping: {},
  runsOn: 'selectedOrAll',
  after: 'refreshWidget',
  placement: 'header',
});

export const defaultHistory = (type: WidgetType): WidgetHistory => ({
  mode: type === 'table' ? 'rows' : 'values',
  interval: 'day',
  retentionDays: 90,
  keys: [],
  keep: [],
  since: 'P7D',
});

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, fallback: string) => (typeof v === 'string' ? v : fallback);
const strOrNull = (v: unknown) => (typeof v === 'string' ? v : null);
const bool = (v: unknown) => v === true;
const choices = (v: unknown) => (Array.isArray(v) && v.every((c) => typeof c === 'string') ? v : null);
const FROMS: unknown[] = ['workbook', 'widget', 'fixed'] satisfies ParamFrom[];

/** A query's own parameter definition; null when it isn't one. */
function parseParamDef(v: unknown): ParameterDef | null {
  if (!isObj(v) || typeof v.name !== 'string' || typeof v.type !== 'string' || typeof v.value !== 'string' || typeof v.required !== 'boolean') {
    return null;
  }
  return { ...v, name: v.name, type: v.type, value: v.value, required: v.required, choices: choices(v.choices) };
}

function parseWidgetParams(v: unknown): Record<string, WidgetParam> {
  const entries = Object.entries(isObj(v) ? v : {}).filter(
    (e): e is [string, WidgetParam] => isObj(e[1]) && FROMS.includes(e[1].from) && typeof e[1].value === 'string',
  );
  return Object.fromEntries(entries.map(([name, p]) => [name, { ...p, from: p.from, value: p.value }]));
}

function parseQuery(v: unknown): WidgetQuery | null | undefined {
  if (v === undefined || v === null) {
    return undefined;
  }
  if (!isObj(v) || typeof v.source !== 'string' || !SOURCES.includes(v.source)) {
    return null;
  }
  const saved = isObj(v.saved) && typeof v.saved.id === 'string' ? v.saved : null;
  return {
    ...v,
    source: v.source as WidgetQuery['source'],
    text: str(v.text, ''),
    options: isObj(v.options) ? (v.options as unknown as QueryOptions) : null,
    parameters: Array.isArray(v.parameters) ? v.parameters.flatMap((p) => parseParamDef(p) ?? []) : [],
    saved: saved ? { id: saved.id as string, name: str(saved.name, '') } : null,
  };
}

const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : fallback);

function clampLayout(type: WidgetType, v: unknown): WidgetLayout {
  const min = MIN_SIZE[type];
  const l = isObj(v) ? v : {};
  const w = Math.min(COLUMNS, Math.max(min.w, num(l.w, min.w)));
  return {
    x: Math.min(COLUMNS - w, Math.max(0, num(l.x, 0))),
    y: Math.max(0, num(l.y, 0)),
    w,
    h: Math.max(min.h, num(l.h, min.h)),
  };
}

const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
  allowed.includes(v as T) ? (v as T) : fallback;

/**
 * Unlike the rest of the model this builds a new object from the six known fields only: a workbook file is shared, and
 * an unknown field such as `command` must never ride along into something that runs (spec §4).
 */
function parseToolButton(v: unknown): ToolButton | null {
  if (!isObj(v) || typeof v.tool !== 'string' || v.tool === '') {
    return null;
  }
  const mapping = Object.entries(isObj(v.mapping) ? v.mapping : {}).filter((e): e is [string, string] => typeof e[1] === 'string');
  return {
    label: typeof v.label === 'string' && v.label.trim() !== '' ? v.label.trim() : v.tool,
    tool: v.tool,
    mapping: Object.fromEntries(mapping),
    runsOn: oneOf(v.runsOn, ['selectedOrAll', 'selected'], 'selectedOrAll'),
    after: oneOf(v.after, ['refreshWidget', 'refreshWorkbook', 'none'], 'refreshWidget'),
    placement: oneOf(v.placement, ['header', 'menu'], 'header'),
  };
}

function parseHistory(v: unknown): WidgetHistory | null {
  if (!isObj(v) || (v.mode !== 'values' && v.mode !== 'rows')) {
    return null;
  }
  const names = (n: unknown) => (Array.isArray(n) ? n.filter((c): c is string => typeof c === 'string') : []);
  return {
    mode: v.mode,
    interval: oneOf(v.interval, ['run', 'day', 'week'], 'day'),
    retentionDays: [30, 90, 365].includes(v.retentionDays as number) ? (v.retentionDays as 30 | 90 | 365) : 90,
    keys: names(v.keys),
    keep: names(v.keep),
    since: typeof v.since === 'string' && /^(previous|P1D|P7D|P30D|\d{4}-\d{2}-\d{2})$/.test(v.since) ? v.since : 'P7D',
  };
}

function parseWidget(v: unknown): Widget | null {
  if (!isObj(v) || !WIDGET_TYPES.includes(v.type as WidgetType) || typeof v.id !== 'string') {
    return null;
  }
  const type = v.type as WidgetType;
  const parsed = parseQuery(v.query);
  if (parsed === null) {
    return null;
  }
  // Data widgets always have a query, as newWidget makes them.
  const query = parsed ?? (type === 'markdown' ? undefined : emptyQuery());
  const parsedHistory = type === 'markdown' ? null : parseHistory(v.history);
  const { query: _query, chart, stat, tools, selection, history: _history, hideTitle, ...rest } = v;
  return {
    ...rest,
    id: v.id,
    type,
    title: str(v.title, ''),
    ...(hideTitle === true ? { hideTitle: true } : {}),
    layout: clampLayout(type, v.layout),
    parameters: parseWidgetParams(v.parameters),
    ...(query ? { query } : {}),
    ...('markdown' in v ? { markdown: str(v.markdown, '') } : {}),
    ...(isObj(chart) ? { chart: chart as Picked } : {}),
    ...(type === 'table'
      ? {
          selection: oneOf(selection, ['single', 'none'], 'multi') as RowSelectionMode,
          tools: Array.isArray(tools) ? tools.flatMap((t) => parseToolButton(t) ?? []) : [],
        }
      : {}),
    ...(parsedHistory ? { history: parsedHistory } : {}),
    ...(isObj(stat) ? { stat: { ...stat, value: strOrNull(stat.value), compare: strOrNull(stat.compare) } } : {}),
  };
}

const overlaps = (a: WidgetLayout, b: WidgetLayout) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** Gives each widget whose id an earlier one has a new id. */
function uniqueIds(widgets: Widget[]): Widget[] {
  const seen = new Set<string>();
  return widgets.map((w) => {
    const id = seen.has(w.id) ? newWidgetId() : w.id;
    seen.add(id);
    return id === w.id ? w : { ...w, id };
  });
}

/** Moves each widget (in y, x order) below whatever it overlaps. */
function repairOverlaps(widgets: Widget[]): Widget[] {
  const placed: Widget[] = [];
  for (const w of [...widgets].sort((a, b) => a.layout.y - b.layout.y || a.layout.x - b.layout.x)) {
    let hit = placed.find((p) => overlaps(p.layout, w.layout));
    while (hit) {
      w.layout.y = hit.layout.y + hit.layout.h;
      hit = placed.find((p) => overlaps(p.layout, w.layout));
    }
    placed.push(w);
  }
  return widgets;
}

function parseParameter(v: unknown): WorkbookParameter | null {
  if (!isObj(v) || typeof v.name !== 'string') {
    return null;
  }
  return {
    ...v,
    name: v.name,
    type: str(v.type, 'text'),
    value: str(v.value, ''),
    required: bool(v.required),
    label: strOrNull(v.label),
    choices: choices(v.choices),
    multi: bool(v.multi),
    all: bool(v.all),
    remember: bool(v.remember),
    huntingTimespan: bool(v.huntingTimespan),
  };
}

/** Reads a workbook file. A string is what is wrong, worded as the user is told it. Unknown fields are kept. */
export function parseWorkbook(json: unknown): WorkbookDoc | string {
  if (!isObj(json) || json.kind !== WORKBOOK_KIND) {
    return "This isn't a Kustodian workbook.";
  }
  if (typeof json.version !== 'number' || json.version > WORKBOOK_VERSION) {
    return 'This workbook needs a newer Kustodian.';
  }
  if (typeof json.id !== 'string' || typeof json.name !== 'string') {
    return "This workbook file is damaged and can't be read.";
  }
  const list = (v: unknown) => (Array.isArray(v) ? v : []);
  return {
    ...json,
    kind: WORKBOOK_KIND,
    version: WORKBOOK_VERSION,
    id: json.id,
    name: json.name,
    folder: typeof json.folder === 'string' ? json.folder : null,
    parameters: list(json.parameters).flatMap((p) => parseParameter(p) ?? []),
    widgets: repairOverlaps(uniqueIds(list(json.widgets).flatMap((w) => parseWidget(w) ?? []))),
  };
}

const UNIT_SECONDS = { d: 86400, h: 3600, m: 60, s: 1, ms: 0.001 };
const MAX_SECONDS = 30 * 86400;

/** A KQL timespan literal (`7d`) as ISO 8601 for `options.timespan`; null when it isn't one or exceeds 30 days. */
export function isoTimespan(kql: string): string | null {
  const m = /^([0-9]+(?:\.[0-9]+)?)(d|h|m|s|ms)$/.exec(kql);
  if (!m) {
    return null;
  }
  const raw = Number(m[1]) * UNIT_SECONDS[m[2] as keyof typeof UNIT_SECONDS];
  const s = m[2] === 'ms' ? Math.ceil(raw) : Math.round(raw);
  if (s <= 0 || s > MAX_SECONDS) {
    return null;
  }
  if (s % 86400 === 0) {
    return `P${s / 86400}D`;
  }
  if (s % 3600 === 0) {
    return `PT${s / 3600}H`;
  }
  return s % 60 === 0 ? `PT${s / 60}M` : `PT${s}S`;
}
