import type { ResultColumn } from '../wire';

/** The comparisons the smart filter menu offers: equal, not equal, at or after, before. */
export type FilterOp = 'eq' | 'ne' | 'ge' | 'lt';

const KEYWORDS = new Set([
  'and', 'or', 'not', 'in', 'has', 'type', 'by', 'on', 'with', 'where', 'project', 'let', 'true', 'false', 'null',
  'datetime', 'timespan', 'dynamic',
]);

const MAX_STRING = 1000;
const SYMBOL = { eq: '==', ne: '!=', ge: '>=', lt: '<' } as const;
const ISO = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d+))?(Z|[+-]\d\d:\d\d)?$/;
const NUMBER = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/;
const GUID = /^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/;
const TIMESPAN = /^-?[\d.:]+$/;

/** A column name as written in KQL: bracket-quoted unless it is a plain identifier and not a keyword. */
export function columnName(name: string): string {
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !KEYWORDS.has(name)) return name;
  return `['${name.replace(/[\\']/g, '\\$&')}']`;
}

const isEmpty = (value: unknown) => value === null || value === undefined || value === '';

/** A double-quoted KQL string literal, or null when it is too long to offer. */
function quote(text: string): string | null {
  if (text.length > MAX_STRING) return null;
  const escaped = text
    .replace(/[\\"]/g, '\\$&')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
  return `"${escaped}"`;
}

/**
 * A datetime as UTC ISO 8601 with 7 fraction digits, or null when it is not a date. An ISO string keeps its own fraction digits
 * (padded, never cut) so an equality filter matches the clicked row exactly.
 */
function datetime(value: unknown): string | null {
  if (typeof value === 'string') {
    const m = ISO.exec(value);
    if (m) {
      const base = new Date(`${m[1]}${m[3] && m[3] !== 'Z' ? m[3] : 'Z'}`);
      if (Number.isNaN(base.getTime())) return null;
      return `${base.toISOString().slice(0, 19)}.${(m[2] ?? '').padEnd(7, '0')}Z`;
    }
  }
  if (typeof value !== 'string' && typeof value !== 'number' && !(value instanceof Date)) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().replace(/\.(\d{3})Z$/, '.$10000Z');
}

/** The condition for filtering on `value` in `column`, or null when this filter is not offered. */
export function filterCondition(column: ResultColumn, value: unknown, op: FilterOp): string | null {
  const name = columnName(column.name);
  const isDatetime = column.type === 'datetime';
  if ((op === 'ge' || op === 'lt') && (!isDatetime || isEmpty(value))) return null;
  const negate = op === 'ne';

  if (isEmpty(value)) {
    if (column.type === 'string') return `${negate ? 'isnotempty' : 'isempty'}(${name})`;
    if (value === '') return null;
    return `${negate ? 'isnotnull' : 'isnull'}(${name})`;
  }

  let lhs = name;
  let literal: string | null;
  switch (column.type) {
    case 'long':
    case 'int':
    case 'real':
    case 'decimal':
      literal = NUMBER.test(String(value)) ? String(value) : null;
      break;
    case 'bool':
      literal = /^(true|false)$/.test(String(value)) ? String(value) : null;
      break;
    case 'datetime': {
      const iso = datetime(value);
      literal = iso && `datetime(${iso})`;
      break;
    }
    case 'timespan':
      literal = TIMESPAN.test(String(value)) ? `timespan(${String(value)})` : null;
      break;
    case 'guid':
      literal = GUID.test(String(value)) ? `guid(${String(value)})` : null;
      break;
    case 'dynamic':
      lhs = `tostring(${name})`;
      literal = quote(typeof value === 'string' ? value : JSON.stringify(value));
      break;
    default:
      literal = quote(String(value));
  }
  return literal === null ? null : `${lhs} ${SYMBOL[op]} ${literal}`;
}

/** The ops the filter menu lists for this cell, in order; none when the filter is not offered. */
export function filterOps(column: ResultColumn, value: unknown): FilterOp[] {
  const ops: FilterOp[] = ['eq', 'ne'];
  if (column.type === 'datetime' && !isEmpty(value)) ops.push('ge', 'lt');
  return ops.filter((op) => filterCondition(column, value, op) !== null);
}

/** The value as shown in the filter menu, 40 characters at most. */
export function shownValue(value: unknown): string {
  const text = isEmpty(value) ? 'null' : typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > 40 ? `${text.slice(0, 39)}…` : text;
}
