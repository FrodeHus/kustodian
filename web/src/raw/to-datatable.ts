import { kqlString } from '../shell/kql-string';

/** How many rows a datatable takes from an array before the rest is left out. */
export const MAX_DATATABLE_ROWS = 5000;
/** How many bytes of KQL a datatable may come to, so its tab fits in the session (`SessionService.MaxTextBytes`, 1 MiB) with
 * room for a note above it. */
export const MAX_DATATABLE_BYTES = 1_000_000;

type ColumnType = 'long' | 'real' | 'bool' | 'datetime' | 'string' | 'dynamic';

/** An ISO 8601 date and time with `Z` or an offset, as Graph writes them: only digits and `-:.TZ+`, so it is safe inside
 * `datetime()`. {@link isDateTime} also checks the ranges. */
const ISO_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,7})?)?(?:Z|[+-](\d{2}):(\d{2}))$/;

/** Whether a string is a real date and time: the ISO form, a month and day that exist, and a time and offset in range. */
function isDateTime(value: string): boolean {
  const m = ISO_DATE_TIME.exec(value);
  if (!m) {
    return false;
  }
  const [year, month, day, hour, minute, second, offsetHours, offsetMinutes] = m.slice(1).map((v) => (v === undefined ? 0 : Number(v)));
  const days = new Date(Date.UTC(year!, month!, 0)).getUTCDate();
  return (
    month! >= 1 && month! <= 12 && day! >= 1 && day! <= days && hour! <= 23 && minute! <= 59 && second! <= 59 && offsetHours! <= 14 && offsetMinutes! <= 59
  );
}
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Words the KQL parser reserves, or reads as a type or literal, where a name is expected: a name that is one goes in `['…']`. */
const KEYWORDS = new Set([
  'and', 'as', 'asc', 'between', 'bool', 'boolean', 'by', 'contains', 'count', 'datatable', 'date', 'datetime', 'decimal', 'declare',
  'default', 'desc', 'double', 'dynamic', 'extend', 'false', 'float', 'from', 'guid', 'has', 'in', 'int', 'int64', 'kind', 'let',
  'like', 'long', 'not', 'null', 'of', 'on', 'or', 'order', 'print', 'project', 'range', 'real', 'set', 'sort', 'step', 'string',
  'summarize', 'take', 'time', 'timespan', 'to', 'true', 'typeof', 'union', 'where', 'with',
]);

/** A column name: as written when it is a plain identifier, else in `['…']`. */
function columnName(name: string): string {
  return IDENTIFIER.test(name) && !KEYWORDS.has(name.toLowerCase()) ? name : `[${kqlString(name, "'")}]`;
}

/** The `let` name: anything but letters, digits and `_` becomes `_`; a name that starts with a digit or is a keyword gets a prefix. */
function letName(name: string): string {
  const safe = name.replace(/[^A-Za-z0-9_]/g, '_');
  return safe === '' || /^[0-9]/.test(safe) || KEYWORDS.has(safe.toLowerCase()) ? `data_${safe}` : safe;
}

/** A JSON value as the inside of a `dynamic()` literal: its strings are KQL string literals. */
function dynamicJson(value: unknown): string {
  if (value === null || value === undefined) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(dynamicJson).join(', ')}]`;
  }
  switch (typeof value) {
    case 'object':
      return `{${Object.entries(value as Record<string, unknown>)
        .map(([k, v]) => `${kqlString(k, '"')}: ${dynamicJson(v)}`)
        .join(', ')}}`;
    case 'string':
      return kqlString(value, '"');
    case 'number':
      return Number.isFinite(value) ? String(value) : 'null';
    case 'boolean':
      return String(value);
    default:
      return 'null';
  }
}

/** The kind of one JSON value; null for a missing or null value, which fits any column. */
function kindOf(value: unknown): ColumnType | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'object') {
    return 'dynamic';
  }
  if (typeof value === 'boolean') {
    return 'bool';
  }
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) ? 'long' : 'real';
  }
  if (typeof value === 'string') {
    return isDateTime(value) ? 'datetime' : 'string';
  }
  return 'dynamic';
}

/** A column's type from its values: one kind for all (whole numbers with others are real; dates with other text are text), or dynamic. */
function columnType(values: unknown[]): ColumnType {
  const kinds = new Set(values.map(kindOf).filter((k): k is ColumnType => k !== null));
  if (kinds.size === 0) {
    return 'dynamic';
  }
  if (kinds.size === 1) {
    return [...kinds][0]!;
  }
  if (kinds.size === 2 && kinds.has('long') && kinds.has('real')) {
    return 'real';
  }
  if (kinds.size === 2 && kinds.has('string') && kinds.has('datetime')) {
    return 'string';
  }
  return 'dynamic';
}

/** One value as a literal of its column's type. */
function literal(type: ColumnType, value: unknown): string {
  const missing = value === null || value === undefined;
  switch (type) {
    case 'long':
      return missing ? 'long(null)' : `long(${String(value)})`;
    case 'real':
      return missing || !Number.isFinite(value) ? 'real(null)' : `real(${String(value)})`;
    case 'bool':
      return missing ? 'bool(null)' : String(value);
    case 'datetime':
      return missing ? 'datetime(null)' : `datetime(${String(value)})`;
    case 'string':
      // KQL strings have no null.
      return missing ? '""' : kqlString(String(value), '"');
    case 'dynamic':
      return `dynamic(${dynamicJson(value)})`;
  }
}

/**
 * A JSON array as a KQL `datatable`, with every value a literal, for a Graph tab to run on the local engine:
 * `let {name} = datatable(col:type, …) [ … ];\n{name}`.
 *
 * - The columns are the objects' keys in the order they first appear; an element that isn't an object is a row with its value
 *   in a `value` column.
 * - Each column's type comes from its values: long, real, bool, datetime (an ISO 8601 date and time with `Z` or an offset,
 *   that exists), string, or dynamic for objects, arrays and columns whose values are of different kinds.
 * - At most `maxRows` rows are taken, and no more than fit in {@link MAX_DATATABLE_BYTES} of KQL; `truncated` says rows were
 *   left out, and `rows` how many are in.
 */
export function toDatatable(name: string, array: unknown[], maxRows = MAX_DATATABLE_ROWS): { kql: string; truncated: boolean; rows: number } {
  const rows = array.slice(0, maxRows).map((item) =>
    item !== null && typeof item === 'object' && !Array.isArray(item) ? (item as Record<string, unknown>) : { value: item },
  );
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        keys.push(key);
      }
    }
  }
  if (keys.length === 0) {
    keys.push('value');
  }
  const types = keys.map((key) => columnType(rows.map((row) => row[key])));
  const schema = keys.map((key, i) => `${columnName(key)}:${types[i]!}`).join(', ');
  const table = letName(name);
  const encoder = new TextEncoder();
  // The frame, and a comma and newline per row, count toward the budget.
  let bytes = encoder.encode(`let ${table} = datatable(${schema}) [\n];\n${table}`).length;
  const lines: string[] = [];
  for (const row of rows) {
    const line = `    ${keys.map((key, i) => literal(types[i]!, row[key])).join(', ')}`;
    bytes += encoder.encode(line).length + 2;
    if (bytes > MAX_DATATABLE_BYTES) {
      break;
    }
    lines.push(line);
  }
  const body = lines.length > 0 ? `${lines.join(',\n')}\n` : '';
  return { kql: `let ${table} = datatable(${schema}) [\n${body}];\n${table}`, truncated: lines.length < array.length, rows: lines.length };
}
