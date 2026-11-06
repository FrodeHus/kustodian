import type { Picked } from '../results/chart-view';
import type { ParameterDef, QueryOptions, Source } from '../wire';

export const WORKBOOK_KIND = 'kustodian.workbook';
export const WORKBOOK_VERSION = 1;

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
export interface Widget {
  id: string;
  type: WidgetType;
  title: string;
  layout: WidgetLayout;
  markdown?: string;
  query?: WidgetQuery;
  parameters: Record<string, WidgetParam>;
  chart?: Picked;
  stat?: { value: string | null; compare: string | null };
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

export function newWidget(type: WidgetType, layout: WidgetLayout): Widget {
  const id = `w${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}`;
  const widget: Widget = { id, type, title: '', layout, parameters: {} };
  if (type !== 'markdown') {
    widget.query = emptyQuery();
  }
  return widget;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, fallback: string) => (typeof v === 'string' ? v : fallback);
const bool = (v: unknown) => v === true;

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
    parameters: Array.isArray(v.parameters) ? (v.parameters as ParameterDef[]) : [],
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

function parseWidget(v: unknown): Widget | null {
  if (!isObj(v) || !WIDGET_TYPES.includes(v.type as WidgetType) || typeof v.id !== 'string') {
    return null;
  }
  const type = v.type as WidgetType;
  const query = parseQuery(v.query);
  if (query === null) {
    return null;
  }
  return {
    ...v,
    id: v.id,
    type,
    title: str(v.title, ''),
    layout: clampLayout(type, v.layout),
    parameters: isObj(v.parameters) ? (v.parameters as Record<string, WidgetParam>) : {},
    ...(query ? { query } : {}),
  };
}

const overlaps = (a: WidgetLayout, b: WidgetLayout) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

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
    label: typeof v.label === 'string' ? v.label : null,
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
    widgets: repairOverlaps(list(json.widgets).flatMap((w) => parseWidget(w) ?? [])),
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
