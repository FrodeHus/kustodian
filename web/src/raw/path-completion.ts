import type { SchemaTable, SchemaView } from '../wire';

/** The OData query options a Graph GET takes. */
const QUERY_OPTIONS = ['$count', '$expand', '$filter', '$orderby', '$search', '$select', '$skip', '$top'];
/** Options whose value is a list of properties, or an expression that names them. */
const PROPERTY_OPTIONS = new Set(['$select', '$orderby', '$expand', '$filter']);
const MAX_ITEMS = 50;

export interface PathCompletion {
  /** Where the text the items replace begins; it ends at the caret. */
  from: number;
  items: string[];
}

const startsWith = (prefix: string) => (name: string) => name.toLowerCase().startsWith(prefix.toLowerCase()) && name !== prefix;

/** The table for a typed path: the one whose Graph path is the longest prefix of it, ending at a segment boundary. */
export function tableForPath(schema: SchemaView, path: string): SchemaTable | undefined {
  const typed = path.toLowerCase();
  let best: SchemaTable | undefined;
  for (const table of schema.tables) {
    const own = table.path.toLowerCase();
    if ((typed === own || typed.startsWith(`${own}/`)) && own.length > (best?.path.length ?? -1)) {
      best = table;
    }
  }
  return best;
}

/**
 * What the raw tab's path can be completed with at `caret` (spec 6.9), from the schema's Graph paths (`auditLogs/signIns`, not
 * the KQL name `auditLogs_signIns`): a collection while typing the path, a query option after `?` or `&`, and a property in
 * `$select`, `$orderby`, `$expand` and `$filter` of the table whose path is the longest prefix of the typed path.
 */
export function completePath(schema: SchemaView | null, path: string, caret: number): PathCompletion {
  const before = path.slice(0, caret);
  const none = { from: caret, items: [] };
  if (!schema) {
    return none;
  }
  const query = before.indexOf('?');
  if (query < 0) {
    return { from: 0, items: schema.tables.map((t) => t.path).filter(startsWith(before)).sort().slice(0, MAX_ITEMS) };
  }

  const partStart = Math.max(before.lastIndexOf('&'), query) + 1;
  const part = before.slice(partStart);
  const equals = part.indexOf('=');
  if (equals < 0) {
    return { from: partStart, items: QUERY_OPTIONS.filter(startsWith(part)) };
  }
  if (!PROPERTY_OPTIONS.has(part.slice(0, equals).toLowerCase())) {
    return none;
  }
  const table = tableForPath(schema, path.slice(0, query));
  if (!table) {
    return none;
  }
  // The word being typed: after the last comma or space (`$select=a,b`, `$orderby=a desc,b`), or after any non-name character
  // in a filter expression.
  const word = /[A-Za-z0-9_]*$/.exec(before)![0];
  return { from: caret - word.length, items: table.columns.map((c) => c.name).filter(startsWith(word)).slice(0, MAX_ITEMS) };
}
