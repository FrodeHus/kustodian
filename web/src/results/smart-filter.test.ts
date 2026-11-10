import { describe, expect, it } from 'vitest';
import { columnName, filterCondition, filterOps, shownValue } from './smart-filter';

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
    expect(filterCondition(c('t', 'datetime'), new Date('2026-11-10T08:00:00.123Z'), 'eq')).toBe('t == datetime(2026-11-10T08:00:00.1230000Z)');
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
});

describe('columnName', () => {
  it('escapes quotes and backslashes in brackets', () => {
    expect(columnName(`a'b\\c`)).toBe(`['a\\'b\\\\c']`);
  });
  it('leaves plain identifiers alone', () => {
    expect(columnName('_Name1')).toBe('_Name1');
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
});
