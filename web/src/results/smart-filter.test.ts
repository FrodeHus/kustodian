import { describe, expect, it } from 'vitest';
import type { Tab } from '../tabs/tab-store';
import { columnName, filterable, filterCondition, filterOps, filterTarget, shownValue, targetEnd, withLine } from './smart-filter';

const c = (name: string, type: string) => ({ name, type });
const GUID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';

describe('filterCondition', () => {
  it('quotes a string with ==', () => {
    expect(filterCondition(c('state', 'string'), 'Enabled', 'eq')).toBe('state == "Enabled"');
  });
  it('escapes quotes, backslashes and newlines and uses !=', () => {
    expect(filterCondition(c('state', 'string'), 'a"b\\c\nd', 'ne')).toBe('state != "a\\"b\\\\c\\nd"');
  });
  it('writes numbers bare', () => {
    expect(filterCondition(c('n', 'long'), 42, 'eq')).toBe('n == 42');
    expect(filterCondition(c('n', 'int'), 7, 'eq')).toBe('n == 7');
    expect(filterCondition(c('r', 'real'), 1.5, 'eq')).toBe('r == 1.5');
    expect(filterCondition(c('r', 'decimal'), 1.5, 'eq')).toBe('r == 1.5');
  });
  it('writes bools bare', () => {
    expect(filterCondition(c('b', 'bool'), true, 'ne')).toBe('b != true');
  });
  it('pads a datetime to 7 fraction digits', () => {
    expect(filterCondition(c('t', 'datetime'), '2026-11-10T08:00:00Z', 'eq')).toBe('t == datetime(2026-11-10T08:00:00.0000000Z)');
    expect(filterCondition(c('t', 'datetime'), '2026-11-10T08:00:00Z', 'ge')).toBe('t >= datetime(2026-11-10T08:00:00.0000000Z)');
    expect(filterCondition(c('t', 'datetime'), '2026-11-10T08:00:00Z', 'lt')).toBe('t < datetime(2026-11-10T08:00:00.0000000Z)');
  });
  it('keeps a 7-digit fraction intact', () => {
    expect(filterCondition(c('t', 'datetime'), '2026-11-10T08:00:00.1234567Z', 'eq')).toBe('t == datetime(2026-11-10T08:00:00.1234567Z)');
  });
  it('pads a short fraction and normalises an offset to UTC', () => {
    expect(filterCondition(c('t', 'datetime'), '2026-11-10T08:00:00.5Z', 'eq')).toBe('t == datetime(2026-11-10T08:00:00.5000000Z)');
    expect(filterCondition(c('t', 'datetime'), '2026-11-10T10:00:00.25+02:00', 'eq')).toBe('t == datetime(2026-11-10T08:00:00.2500000Z)');
  });
  it('formats a Date value', () => {
    expect(filterCondition(c('t', 'datetime'), new Date('2026-11-10T08:00:00.123Z'), 'eq')).toBe(
      't == datetime(2026-11-10T08:00:00.1230000Z)',
    );
  });
  it('returns null for an invalid datetime', () => {
    expect(filterCondition(c('t', 'datetime'), 'nope', 'eq')).toBeNull();
  });
  it('wraps a timespan and a guid', () => {
    expect(filterCondition(c('d', 'timespan'), '01:30:00', 'eq')).toBe('d == timespan(01:30:00)');
    expect(filterCondition(c('g', 'guid'), GUID, 'eq')).toBe(`g == guid(${GUID})`);
  });
  it('refuses a malformed guid, timespan or number', () => {
    expect(filterCondition(c('g', 'guid'), 'x) or (1==1', 'eq')).toBeNull();
    expect(filterCondition(c('d', 'timespan'), '1) or (1==1', 'eq')).toBeNull();
    expect(filterCondition(c('n', 'long'), '1 or 1==1', 'eq')).toBeNull();
  });
  it('compares dynamic as its JSON string', () => {
    expect(filterCondition(c('x', 'dynamic'), { a: [1] }, 'eq')).toBe('tostring(x) == "{\\"a\\":[1]}"');
  });
  it('uses isempty / isnotempty for empty and null strings', () => {
    expect(filterCondition(c('s', 'string'), '', 'eq')).toBe('isempty(s)');
    expect(filterCondition(c('s', 'string'), null, 'ne')).toBe('isnotempty(s)');
  });
  it('uses isnull / isnotnull for null non-strings', () => {
    expect(filterCondition(c('n', 'long'), null, 'eq')).toBe('isnull(n)');
    expect(filterCondition(c('n', 'long'), null, 'ne')).toBe('isnotnull(n)');
  });
  it('bracket-quotes awkward and keyword column names', () => {
    expect(filterCondition(c('user name', 'string'), 'x', 'eq')).toBe(`['user name'] == "x"`);
    expect(filterCondition(c('type', 'string'), 'x', 'eq')).toBe(`['type'] == "x"`);
  });
  it('is not offered for a long string or ge/lt on a non-datetime', () => {
    expect(filterCondition(c('s', 'string'), 'x'.repeat(1001), 'eq')).toBeNull();
    expect(filterCondition(c('n', 'long'), 1, 'ge')).toBeNull();
  });
  it('has no ge/lt for an empty datetime', () => {
    expect(filterCondition(c('t', 'datetime'), null, 'ge')).toBeNull();
  });
  it('uses the name it is given, as the host wrote it', () => {
    expect(filterCondition(c('to', 'string'), 'x', 'eq', "['to']")).toBe(`['to'] == "x"`);
    expect(filterCondition(c('to', 'string'), null, 'eq', "['to']")).toBe(`isempty(['to'])`);
  });
});

describe('columnName', () => {
  it('escapes quotes and backslashes in brackets', () => {
    expect(columnName(`a'b\\c`)).toBe(`['a\\'b\\\\c']`);
  });
  it('leaves plain identifiers alone', () => {
    expect(columnName('_Name1')).toBe('_Name1');
  });
  it('escapes line breaks in brackets', () => {
    expect(columnName('a\nb\rc')).toBe(`['a\\nb\\rc']`);
  });
});

describe('filterOps', () => {
  it('offers four for a datetime, two for a null datetime, none for a long string', () => {
    expect(filterOps(c('t', 'datetime'), '2026-11-10T08:00:00Z')).toEqual(['eq', 'ne', 'ge', 'lt']);
    expect(filterOps(c('t', 'datetime'), null)).toEqual(['eq', 'ne']);
    expect(filterOps(c('s', 'string'), 'x'.repeat(1001))).toEqual([]);
    expect(filterOps(c('s', 'string'), 'x')).toEqual(['eq', 'ne']);
  });
});

describe('shownValue', () => {
  it('truncates 41 characters to 40 ending in an ellipsis', () => {
    const s = shownValue('x'.repeat(41));
    expect(s).toHaveLength(40);
    expect(s.endsWith('…')).toBe(true);
    expect(shownValue('short')).toBe('short');
  });
  it('shows an empty string as "" and a missing value as null', () => {
    expect(shownValue('')).toBe('""');
    expect(shownValue(null)).toBe('null');
  });
});

describe('filterTarget', () => {
  const at = (line: number, column = 1) => ({ line, column });
  it('uses the text that ran when it is still at its origin', () => {
    const text = 'a\n\nusers\n| take 5';
    expect(filterTarget(text, { kql: 'users\n| take 5', origin: at(3) }, 1)).toEqual({ kql: 'users\n| take 5', origin: at(3) });
  });
  it('falls back to the cursor block when the text changed', () => {
    const text = 'a\n\nposts\n| take 5';
    expect(filterTarget(text, { kql: 'users', origin: at(3) }, 4)).toEqual({ kql: 'posts\n| take 5', origin: at(3) });
  });
  it('returns null when there is nothing to use', () => {
    expect(filterTarget('', { kql: 'users', origin: at(1) }, 1)).toBeNull();
  });
  it('uses the last block of a run of several', () => {
    const text = 'a\n| take 1\n\nb\n| take 2';
    expect(filterTarget(text, { kql: text, origin: at(1) }, 1)).toEqual({ kql: 'b\n| take 2', origin: at(4) });
  });
  it('uses the block holding the end of a selection that ended mid-line', () => {
    const text = 'users\n| take 5 | count';
    expect(filterTarget(text, { kql: 'users\n| take 5', origin: at(1) }, 1)).toEqual({ kql: text, origin: at(1) });
  });
});

describe('filterTarget with CRLF text', () => {
  const at = (line: number, column = 1) => ({ line, column });
  it('finds the text that ran, which has \\n, in \\r\\n text', () => {
    const text = 'a\r\n\r\nusers\r\n| take 5';
    expect(filterTarget(text, { kql: 'users\n| take 5', origin: at(3) }, 1)).toEqual({ kql: 'users\n| take 5', origin: at(3) });
  });
  it('uses the last block of a block run, not the cursor block', () => {
    const text = 'a\r\n| take 1\r\n\r\nb\r\n| take 2';
    expect(filterTarget(text, { kql: 'a\n| take 1\n\nb\n| take 2', origin: at(1) }, 1)).toEqual({ kql: 'b\n| take 2', origin: at(4) });
  });
});

describe('targetEnd', () => {
  it('is the position just after the target, from its own lines', () => {
    expect(targetEnd({ kql: 'users\n| take 5', origin: { line: 3, column: 1 } })).toEqual({ line: 4, column: 9 });
    expect(targetEnd({ kql: 'users', origin: { line: 2, column: 4 } })).toEqual({ line: 2, column: 9 });
  });
});

describe('filterable', () => {
  const tab = (source: Tab['source'], ran: Tab['source'] | undefined, kql = 'T') =>
    ({ source, run: { state: 'done', kql, source: ran, origin: { line: 1, column: 1 } } }) as unknown as Tab;
  it('is offered for the query sources, on the source the rows came from', () => {
    expect(filterable(tab('graph', undefined))).toBe(true);
    expect(filterable(tab('hunting', 'hunting'))).toBe(true);
    expect(filterable(tab('arg', 'arg'))).toBe(true);
  });
  it('is not offered for raw or workbook tabs', () => {
    expect(filterable(tab('raw', 'raw'))).toBe(false);
    expect(filterable(tab('workbook', 'workbook'))).toBe(false);
  });
  it('is not offered when the source changed since the run, or the run kept no text', () => {
    expect(filterable(tab('hunting', 'graph'))).toBe(false);
    expect(filterable(tab('hunting', undefined))).toBe(false);
    expect(filterable(tab('graph', 'graph', ''))).toBe(false);
  });
});

describe('withLine', () => {
  const origin = { line: 3, column: 1 };
  it('copies the indent of the last pipe line', () => {
    const kql = 'users\n    | take 5';
    expect(withLine({ kql, origin }, kql.length, 'a == 1')).toEqual({
      text: 'users\n    | take 5\n    | where a == 1',
      endLine: 5,
      endColumn: 4 + '| where a == 1'.length + 1,
    });
  });
  it('uses no indent when there are no pipes', () => {
    expect(withLine({ kql: 'users', origin }, 5, 'a == 1')).toEqual({ text: 'users\n| where a == 1', endLine: 4, endColumn: 15 });
  });
  it('keeps the text after the insertion point', () => {
    expect(withLine({ kql: 'users\n| take 5', origin }, 5, 'a == 1').text).toBe('users\n| where a == 1\n| take 5');
  });
});
