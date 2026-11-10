import { describe, expect, it } from 'vitest';
import type { HighlightOp, HighlightRule, ResultColumn } from '../wire';
import { compileRules, highlightOf, ruleFromCell, ruleProblem } from './highlights';

let n = 0;
function rule(column: string, op: HighlightOp, value: string, over: Partial<HighlightRule> = {}): HighlightRule {
  return { id: `r${n++}`, column, op, value, colour: 'danger', target: 'row', ...over };
}
const col = (name: string, type: string): ResultColumn => ({ name, type });
function hit(r: HighlightRule, columns: ResultColumn[], row: unknown[]): boolean {
  return highlightOf(compileRules([r], columns), row).row !== null;
}

describe('string', () => {
  const c = [col('s', 'string')];
  it('compares case-insensitively', () => {
    expect(hit(rule('s', '==', 'fail'), c, ['FAIL'])).toBe(true);
    expect(hit(rule('s', '!=', 'fail'), c, ['FAIL'])).toBe(false);
    expect(hit(rule('s', '>', 'a'), c, ['B'])).toBe(true);
    expect(hit(rule('s', '>=', 'b'), c, ['B'])).toBe(true);
    expect(hit(rule('s', '<', 'b'), c, ['A'])).toBe(true);
    expect(hit(rule('s', '<=', 'a'), c, ['B'])).toBe(false);
  });
  it('contains and !contains', () => {
    expect(hit(rule('s', 'contains', 'AIL'), c, ['fail'])).toBe(true);
    expect(hit(rule('s', '!contains', 'AIL'), c, ['fail'])).toBe(false);
    expect(hit(rule('s', '!contains', 'x'), c, ['fail'])).toBe(true);
  });
});

describe('number', () => {
  const c = [col('n', 'long')];
  it('compares numerically', () => {
    expect(hit(rule('n', '>', '90'), c, [97])).toBe(true);
    expect(hit(rule('n', '>', '100'), c, [97])).toBe(false);
    expect(hit(rule('n', '<=', '97'), c, [97])).toBe(true);
    expect(hit(rule('n', '!=', '97'), c, [97])).toBe(false);
  });
  it('an unreadable value never matches', () => {
    const r = rule('n', '>', 'abc');
    expect(ruleProblem(r, c)).toBe('unreadable');
    expect(hit(r, c, [97])).toBe(false);
  });
  it('contains reads the cell text', () => {
    expect(hit(rule('n', 'contains', '9'), c, [97])).toBe(true);
  });
});

describe('datetime', () => {
  it('compares instants', () => {
    const c = [col('t', 'datetime')];
    const r = rule('t', '>=', '2025-01-01T00:00:00Z');
    expect(hit(r, c, ['2025-01-01T00:00:00.0000000Z'])).toBe(true);
    expect(hit(r, c, ['2024-12-31T23:59:59Z'])).toBe(false);
    expect(ruleProblem(rule('t', '>=', 'nope'), c)).toBe('unreadable');
  });
});

describe('timespan', () => {
  it('compares durations', () => {
    const c = [col('d', 'timespan')];
    const r = rule('d', '>', '3600');
    expect(hit(r, c, ['01:30:00'])).toBe(true);
    expect(hit(r, c, ['00:30:00'])).toBe(false);
    expect(hit(rule('d', '==', '1.00:00:00'), c, ['24:00:00'])).toBe(true);
    expect(hit(rule('d', '<', '0'), c, ['-00:00:01'])).toBe(true);
    expect(ruleProblem(rule('d', '>', 'x'), c)).toBe('unreadable');
  });
});

describe('bool', () => {
  it('compares true/false case-insensitively', () => {
    const c = [col('b', 'bool')];
    expect(hit(rule('b', '==', 'true'), c, [true])).toBe(true);
    expect(hit(rule('b', '==', 'TRUE'), c, [true])).toBe(true);
    expect(hit(rule('b', '==', 'false'), c, [true])).toBe(false);
    expect(ruleProblem(rule('b', '==', 'yes'), c)).toBe('unreadable');
  });
});

describe('dynamic', () => {
  it('compares compact JSON', () => {
    const c = [col('j', 'dynamic')];
    expect(hit(rule('j', '==', '{"a":1}'), c, [{ a: 1 }])).toBe(true);
    expect(hit(rule('j', '==', '{ "a": 1 }'), c, [{ a: 1 }])).toBe(true);
    expect(hit(rule('j', '==', '{"a":2}'), c, [{ a: 1 }])).toBe(false);
  });
});

describe('isempty', () => {
  const c = [col('n', 'long')];
  it('null and empty are empty, zero is not', () => {
    const e = rule('n', 'isempty', '');
    const ne = rule('n', 'isnotempty', '');
    expect(hit(e, c, [null])).toBe(true);
    expect(hit(e, c, [''])).toBe(true);
    expect(hit(e, c, [0])).toBe(false);
    expect(hit(e, c, [])).toBe(true);
    expect(hit(ne, c, [0])).toBe(true);
    expect(hit(ne, c, [null])).toBe(false);
  });
});

describe('order', () => {
  const c = [col('a', 'string'), col('b', 'string')];
  it('the first row rule wins', () => {
    const rules = [rule('a', '==', 'x', { colour: 'warning' }), rule('a', '==', 'x', { colour: 'danger' })];
    expect(highlightOf(compileRules(rules, c), ['x', '']).row).toBe('warning');
  });
  it('a cell rule and a row rule both apply', () => {
    const rules = [rule('a', '==', 'x', { colour: 'info' }), rule('b', '==', 'y', { colour: 'success', target: 'cell' })];
    const h = highlightOf(compileRules(rules, c), ['x', 'y']);
    expect(h.row).toBe('info');
    expect(h.cells.get(1)).toBe('success');
    expect(h.cells.size).toBe(1);
  });
  it('the first cell rule per column wins', () => {
    const rules = [
      rule('b', '==', 'y', { colour: 'success', target: 'cell' }),
      rule('b', '==', 'y', { colour: 'info', target: 'cell' }),
    ];
    expect(highlightOf(compileRules(rules, c), ['', 'y']).cells.get(1)).toBe('success');
  });
});

describe('missing column', () => {
  it('is a problem and never matches', () => {
    const r = rule('zzz', '==', 'x');
    expect(ruleProblem(r, [col('a', 'string')])).toBe('missing');
    expect(hit(r, [col('a', 'string')], ['x'])).toBe(false);
  });
});

describe('ruleFromCell', () => {
  it('a string gives ==, danger, row', () => {
    const r = ruleFromCell(col('a', 'string'), 'hi');
    expect(r).toMatchObject({ column: 'a', op: '==', value: 'hi', colour: 'danger', target: 'row' });
    expect(r.id).toBeTruthy();
  });
  it('null gives isempty', () => {
    expect(ruleFromCell(col('a', 'string'), null)).toMatchObject({ op: 'isempty', value: '' });
  });
  it('each rule gets a fresh id', () => {
    expect(ruleFromCell(col('a', 'string'), 1).id).not.toBe(ruleFromCell(col('a', 'string'), 1).id);
  });
});
