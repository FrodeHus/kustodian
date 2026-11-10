import { newId } from '../shell/ids';
import type { HighlightColour, HighlightOp, HighlightRule, ResultColumn } from '../wire';
import { NUMERIC } from './column-stats';
import { cellText } from './export';
import { shownValue } from './smart-filter';

export const MAX_HIGHLIGHTS = 20;
export const HIGHLIGHT_OPS: HighlightOp[] = ['==', '!=', '>', '>=', '<', '<=', 'contains', '!contains', 'isempty', 'isnotempty'];
export const HIGHLIGHT_COLOURS: HighlightColour[] = ['danger', 'warning', 'success', 'info'];

type Kind = 'number' | 'datetime' | 'timespan' | 'bool' | 'text';
type Scalar = number | string | boolean;

function kindOf(type: string): Kind {
  if (NUMERIC.has(type)) return 'number';
  return type === 'datetime' || type === 'timespan' || type === 'bool' ? type : 'text';
}

/** `[-][d.]hh:mm:ss[.fffffff]`, or a bare number of seconds; null when unreadable. */
function parseTimespan(text: string): number | null {
  const t = text.trim();
  if (t !== '' && Number.isFinite(Number(t))) return Number(t);
  const m = /^(-)?(?:(\d+)\.)?(\d+):(\d+):(\d+)(?:\.(\d+))?$/.exec(t);
  if (!m) return null;
  const secs = Number(m[2] ?? 0) * 86400 + Number(m[3]) * 3600 + Number(m[4]) * 60 + Number(m[5]) + Number(`0.${m[6] ?? '0'}`);
  return m[1] ? -secs : secs;
}

function compactJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text));
  } catch {
    return text;
  }
}

/** A value read as the kind's comparable scalar, or null when it can't be read. */
function parse(kind: Kind, type: string, raw: unknown): Scalar | null {
  const text = cellText(raw);
  switch (kind) {
    case 'number': {
      const n = typeof raw === 'number' ? raw : text.trim() === '' ? NaN : Number(text);
      return Number.isNaN(n) ? null : n;
    }
    case 'datetime': {
      const t = Date.parse(text);
      return Number.isNaN(t) ? null : t;
    }
    case 'timespan':
      return parseTimespan(text);
    case 'bool': {
      const b = text.trim().toLowerCase();
      return b === 'true' ? true : b === 'false' ? false : null;
    }
    default:
      return (type === 'dynamic' ? compactJson(text) : text).toLowerCase();
  }
}

function compare(op: HighlightOp, a: Scalar, b: Scalar): boolean {
  switch (op) {
    case '==':
      return a === b;
    case '!=':
      return a !== b;
    case '>':
      return a > b;
    case '>=':
      return a >= b;
    case '<':
      return a < b;
    case '<=':
      return a <= b;
    default:
      return false;
  }
}

const isEmpty = (v: unknown): boolean => v === null || v === undefined || v === '';

interface Compiled {
  rule: HighlightRule;
  index: number;
  kind: Kind;
  type: string;
  value: Scalar | null;
}

export interface CompiledRules {
  rules: Compiled[];
}

const NO_VALUE: HighlightOp[] = ['isempty', 'isnotempty', 'contains', '!contains'];

/** Parses each rule's value once against the columns; rules on missing columns or with unreadable values never match. */
export function compileRules(rules: HighlightRule[], columns: ResultColumn[]): CompiledRules {
  const out: Compiled[] = [];
  for (const rule of rules) {
    const index = columns.findIndex((c) => c.name === rule.column);
    if (index < 0) continue;
    const type = columns[index]!.type;
    const kind = kindOf(type);
    const value = NO_VALUE.includes(rule.op) ? null : parse(kind, type, rule.value);
    if (value === null && !NO_VALUE.includes(rule.op)) continue;
    out.push({ rule, index, kind, type, value });
  }
  return { rules: out };
}

function matches(c: Compiled, row: unknown[]): boolean {
  const cell = row[c.index];
  switch (c.rule.op) {
    case 'isempty':
      return isEmpty(cell);
    case 'isnotempty':
      return !isEmpty(cell);
    case 'contains':
      return cellText(cell).toLowerCase().includes(c.rule.value.toLowerCase());
    case '!contains':
      return !cellText(cell).toLowerCase().includes(c.rule.value.toLowerCase());
    default: {
      const v = isEmpty(cell) ? null : parse(c.kind, c.type, cell);
      return v !== null && compare(c.rule.op, v, c.value!);
    }
  }
}

/** The row's colour and each highlighted cell's colour (by column index), first match wins. */
export function highlightOf(compiled: CompiledRules, row: unknown[]): { row: HighlightColour | null; cells: Map<number, HighlightColour> } {
  let rowColour: HighlightColour | null = null;
  const cells = new Map<number, HighlightColour>();
  for (const c of compiled.rules) {
    if (c.rule.target === 'row' ? rowColour !== null : cells.has(c.index)) continue;
    if (!matches(c, row)) continue;
    if (c.rule.target === 'row') rowColour = c.rule.colour;
    else cells.set(c.index, c.rule.colour);
  }
  return { row: rowColour, cells };
}

/** 'missing' (column not in the result), 'unreadable' (value can't be read as the column's type), or null. */
export function ruleProblem(rule: HighlightRule, columns: ResultColumn[]): 'missing' | 'unreadable' | null {
  const column = columns.find((c) => c.name === rule.column);
  if (!column) return 'missing';
  if (NO_VALUE.includes(rule.op)) return null;
  return parse(kindOf(column.type), column.type, rule.value) === null ? 'unreadable' : null;
}

/** The rule a cell's "Highlight rows where…" prefills: == (isempty for an empty value), danger, row. */
export function ruleFromCell(column: ResultColumn, value: unknown): HighlightRule {
  const empty = isEmpty(value);
  return {
    id: newId(),
    column: column.name,
    op: empty ? 'isempty' : '==',
    value: empty ? '' : shownValue(value),
    colour: 'danger',
    target: 'row',
  };
}
