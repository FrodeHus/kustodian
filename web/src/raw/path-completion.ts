import type { SchemaView } from '../wire';

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

/**
 * What the raw tab's path can be completed with at `caret` (spec 6.9), from the schema: an entity set in the first segment, a
 * query option after `?` or `&`, and a property of the entity set in `$select`, `$orderby`, `$expand` and `$filter`. Nothing
 * deeper in the path, where the schema has no navigation.
 */
export function completePath(schema: SchemaView | null, path: string, caret: number): PathCompletion {
  const before = path.slice(0, caret);
  const none = { from: caret, items: [] };
  if (!schema) {
    return none;
  }
  const query = before.indexOf('?');
  if (query < 0) {
    if (before.includes('/')) {
      return none;
    }
    return { from: 0, items: schema.tables.map((t) => t.name).filter(startsWith(before)).sort().slice(0, MAX_ITEMS) };
  }

  const partStart = Math.max(before.lastIndexOf('&'), query) + 1;
  const part = before.slice(partStart);
  const equals = part.indexOf('=');
  if (equals < 0) {
    return { from: partStart, items: QUERY_OPTIONS.filter(startsWith(part)) };
  }
  const option = part.slice(0, equals).toLowerCase();
  if (!PROPERTY_OPTIONS.has(option)) {
    return none;
  }
  const entitySet = path.slice(0, query).split('/')[0] ?? '';
  const table = schema.tables.find((t) => t.name.toLowerCase() === entitySet.toLowerCase());
  if (!table) {
    return none;
  }
  // The word being typed: after the last comma or space (`$select=a,b`, `$orderby=a desc,b`), or after any non-name character
  // in a filter expression.
  const word = /[A-Za-z0-9_]*$/.exec(before)![0];
  return { from: caret - word.length, items: table.columns.map((c) => c.name).filter(startsWith(word)).slice(0, MAX_ITEMS) };
}
