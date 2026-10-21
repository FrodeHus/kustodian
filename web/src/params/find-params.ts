import type { ParameterDef } from '../wire';

/** The parameter types the host knows (spec 6.3). */
export const PARAMETER_TYPES = ['text', 'number', 'timespan', 'datetime', 'list'] as const;

const PLACEHOLDER = /^\{([A-Za-z_][A-Za-z0-9_]*)\}/;

const lineEnd = (c: string | undefined) => c === '\n' || c === '\r';

interface Placeholder {
  name: string;
  start: number;
  end: number;
}

/** Where a string or comment starting at `i` ends (the index after it), or null when none starts there. */
function skipLiteral(text: string, i: number): number | null {
  const c = text[i];
  if (c === '/' && text[i + 1] === '/') {
    let j = i + 2;
    while (j < text.length && !lineEnd(text[j])) {
      j++;
    }
    return j;
  }
  // Multi-line strings run to their closing fence, or to the end of the text.
  const fence = text.slice(i, i + 3);
  if (fence === '```' || fence === '~~~') {
    const close = text.indexOf(fence, i + 3);
    return close < 0 ? text.length : close + 3;
  }
  // A verbatim string: a doubled quote is a quote, a backslash is just a backslash.
  if (c === '@' && (text[i + 1] === '"' || text[i + 1] === "'")) {
    const quote = text[i + 1];
    let j = i + 2;
    while (j < text.length && !lineEnd(text[j])) {
      if (text[j] === quote) {
        if (text[j + 1] !== quote) {
          return j + 1;
        }
        j++;
      }
      j++;
    }
    return j;
  }
  // Every other string ends at its quote (a backslash escapes the next character), or at the end of the line.
  if (c === '"' || c === "'") {
    let j = i + 1;
    while (j < text.length && !lineEnd(text[j])) {
      if (text[j] === '\\' && j + 1 < text.length && !lineEnd(text[j + 1])) {
        j += 2;
        continue;
      }
      if (text[j] === c) {
        return j + 1;
      }
      j++;
    }
    return j;
  }
  return null;
}

function placeholders(text: string): Placeholder[] {
  const found: Placeholder[] = [];
  let i = 0;
  while (i < text.length) {
    const skipped = skipLiteral(text, i);
    if (skipped !== null) {
      i = skipped;
      continue;
    }
    const match = text[i] === '{' ? PLACEHOLDER.exec(text.slice(i, i + 256)) : null;
    if (match?.[1]) {
      found.push({ name: match[1], start: i, end: i + match[0].length });
      i += match[0].length;
    } else {
      i++;
    }
  }
  return found;
}

/**
 * The `{name}` placeholders of a query, in order of first use: the web's copy of the host's `ParameterSubstitution.Find`
 * (`find-params.fixture.json` holds the cases both must agree on). A placeholder is `{`, a name and `}` with nothing between
 * them; none inside a string (in every form) or a `//` comment counts.
 *
 * Unlike the host, which reads the query with Kusto's own lexer, this has no lexer: a placeholder inside a raw literal such as
 * `datetime({start})` counts here, and the host then refuses its value as not fitting where the placeholder is.
 */
export function findParams(text: string): string[] {
  return [...new Set(placeholders(text).map((p) => p.name))];
}

/** A definition for each of `names`: the one `known` has, or a new optional text parameter. */
export function mergeParameters(names: string[], known: ParameterDef[]): ParameterDef[] {
  return names.map((name) => known.find((p) => p.name === name) ?? { name, type: 'text', value: '', required: false, choices: null });
}

function quoted(value: string): string {
  let out = '"';
  for (const c of value) {
    const code = c.charCodeAt(0);
    if (c === '\\') {
      out += '\\\\';
    } else if (c === '"') {
      out += '\\"';
    } else if (c === '\n') {
      out += '\\n';
    } else if (c === '\r') {
      out += '\\r';
    } else if (c === '\t') {
      out += '\\t';
    } else if (code < 0x20 || (code >= 0x7f && code < 0xa0)) {
      out += `\\u${code.toString(16).padStart(4, '0')}`;
    } else {
      out += c;
    }
  }
  return `${out}"`;
}

const NUMBER = /^-?[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?$/;

function number(value: string): string {
  if (!value.startsWith('-')) {
    return value;
  }
  return /[.eE]/.test(value) ? `real(${value})` : `long(${value})`;
}

/** Whether an `in` operator comes before the placeholder at `start`: null when not, true when with an opening parenthesis
 * between them. */
function afterIn(text: string, start: number): boolean | null {
  const match = /(?:^|[^A-Za-z0-9_])!?in~?\s*(\()?\s*$/.exec(text.slice(Math.max(0, start - 64), start));
  return match ? match[1] !== undefined : null;
}

function literal(def: ParameterDef, text: string, start: number): string {
  const value = def.value.trim();
  switch (def.type) {
    case 'number':
      return value === '' ? 'long(null)' : number(value);
    case 'timespan':
      return value === '' ? 'timespan(null)' : value;
    case 'datetime':
      return value === '' ? 'datetime(null)' : `datetime(${value})`;
    case 'list': {
      const lines = def.value
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l !== '');
      const items = lines.length > 0 && lines.every((l) => NUMBER.test(l)) ? lines : lines.map(quoted);
      const joined = items.join(', ');
      const tuple = afterIn(text, start);
      if (tuple === true) {
        return items.length === 0 ? 'dynamic([])' : joined;
      }
      if (tuple === false) {
        return items.length === 0 ? '(dynamic([]))' : `(${joined})`;
      }
      return `dynamic([${joined}])`;
    }
    default:
      return quoted(def.value);
  }
}

/**
 * The query with each placeholder written as the literal its value becomes, for showing only: the host substitutes for real
 * (and checks each value against its type, which this doesn't). Placeholders without a definition stay as they are.
 */
export function previewText(text: string, parameters: ParameterDef[]): string {
  let out = '';
  let copied = 0;
  for (const p of placeholders(text)) {
    const def = parameters.find((d) => d.name === p.name);
    if (!def) {
      continue;
    }
    out += text.slice(copied, p.start) + literal(def, text, p.start);
    copied = p.end;
  }
  return out + text.slice(copied);
}
