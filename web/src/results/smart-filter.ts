import { blockAt } from '../editor/block-at';
import type { Tab } from '../tabs/tab-store';
import type { ResultColumn } from '../wire';

/** The comparisons the smart filter menu offers: equal, not equal, at or after, before. */
export type FilterOp = 'eq' | 'ne' | 'ge' | 'lt';

const KEYWORDS = new Set([
  'and',
  'or',
  'not',
  'in',
  'has',
  'type',
  'by',
  'on',
  'with',
  'where',
  'project',
  'let',
  'true',
  'false',
  'null',
  'datetime',
  'timespan',
  'dynamic',
]);

const MAX_STRING = 1000;
const SYMBOL = { eq: '==', ne: '!=', ge: '>=', lt: '<' } as const;
const ISO = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d+))?(Z|[+-]\d\d:\d\d)?$/;
const NUMBER = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/;
const GUID = /^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/;
const TIMESPAN = /^-?[\d.:]+$/;

/**
 * A column name as written in KQL: bracket-quoted unless it is a plain identifier and not a keyword. Only a fallback: the
 * filter itself uses the host's name (`query.filterAt`), which knows every word Kusto won't take bare.
 */
export function columnName(name: string): string {
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !KEYWORDS.has(name)) return name;
  return `['${name.replace(/[\\']/g, '\\$&').replace(/\n/g, '\\n').replace(/\r/g, '\\r')}']`;
}

/** Whether the smart filter is offered for the tab's rows: a query source's run that kept its text, on the source it went to. */
export function filterable(tab: Pick<Tab, 'source' | 'run'>): boolean {
  const { source, run } = tab;
  return (
    (source === 'graph' || source === 'hunting' || source === 'arg' || source === 'logs') &&
    !!run?.kql &&
    (run.source ?? 'graph') === source
  );
}

const isEmpty = (value: unknown) => value === null || value === undefined || value === '';

/** A double-quoted KQL string literal, or null when it is too long to offer. */
function quote(text: string): string | null {
  if (text.length > MAX_STRING) return null;
  const escaped = text.replace(/[\\"]/g, '\\$&').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
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

/** The condition for filtering on `value` in `column`, written as `name`, or null when this filter is not offered. */
export function filterCondition(column: ResultColumn, value: unknown, op: FilterOp, name = columnName(column.name)): string | null {
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
  const text = value === '' ? '""' : isEmpty(value) ? 'null' : typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > 40 ? `${text.slice(0, 39)}…` : text;
}

/** The query text a filter line goes into, and where it begins in the editor (lines and columns count from 1). */
export interface FilterTarget {
  kql: string;
  origin: { line: number; column: number };
}

const startOffset = (text: string, line: number, column: number) => {
  const lines = text.split('\n');
  let offset = 0;
  for (let i = 0; i < line - 1 && i < lines.length; i++) offset += (lines[i] ?? '').length + 1;
  return offset + column - 1;
};

/** The editor position (from 1) just after the target's text, from its own lines. */
export function targetEnd(target: FilterTarget): { line: number; column: number } {
  const lines = target.kql.split('\n');
  return {
    line: target.origin.line + lines.length - 1,
    column: (lines.length === 1 ? target.origin.column : 1) + (lines.at(-1) ?? '').length,
  };
}

/**
 * The text a smart filter's line goes into: what the run sent, when it is still in the editor at its origin, else the block
 * at the cursor. Of several blocks the last one; when a selection ended mid-line, the block holding that end. The editor's
 * `\r\n` is read as `\n`, as the run's text has it; lines and columns are the same either way.
 */
export function filterTarget(editorText: string, run: FilterTarget, cursorLine: number): FilterTarget | null {
  const text = editorText.replace(/\r\n/g, '\n');
  let target: FilterTarget;
  const found = text.startsWith(run.kql, startOffset(text, run.origin.line, run.origin.column)) && run.kql.trim() !== '';
  if (found) {
    const last = blockAt(run.kql, run.kql.split('\n').length);
    target = { kql: last.text, origin: { line: run.origin.line + last.start - 1, column: last.start === 1 ? run.origin.column : 1 } };
    const end = targetEnd(target);
    if ((text.split('\n')[end.line - 1] ?? '').slice(end.column - 1).trim() !== '') {
      const block = blockAt(text, end.line);
      target = { kql: block.text, origin: { line: block.start, column: 1 } };
    }
  } else {
    const block = blockAt(text, cursorLine);
    target = { kql: block.text, origin: { line: block.start, column: 1 } };
  }
  return target.kql.trim() === '' ? null : target;
}

/**
 * The target's text with `\n<indent>| where <condition>` inserted at `offset` (a character offset into `target.kql`), where
 * `indent` is the leading whitespace of its last pipe line. `endLine` and `endColumn` are the editor position (from 1) just
 * after the inserted text.
 */
export function withLine(target: FilterTarget, offset: number, condition: string): { text: string; endLine: number; endColumn: number } {
  const pipe = target.kql
    .split('\n')
    .filter((l) => /^\s*\|/.test(l))
    .pop();
  const indent = /^\s*/.exec(pipe ?? '')?.[0] ?? '';
  const line = `${indent}| where ${condition}`;
  const before = target.kql.slice(0, offset);
  return {
    text: `${before}\n${line}${target.kql.slice(offset)}`,
    endLine: target.origin.line + before.split('\n').length,
    endColumn: line.length + 1,
  };
}
