import { describe, expect, it } from 'vitest';
import type { RunResult } from '../wire';
import { choicesFrom, choicesUsing, choiceWidget, MAX_CHOICES } from './choices';
import type { WorkbookParameter } from './model';
import { newWorkbook } from './model';

const result = (rows: unknown[][]): RunResult => ({
  outcome: 'ok',
  message: null,
  error: null,
  columns: [
    { name: 'v', type: 'string' },
    { name: 'l', type: 'string' },
  ],
  rows,
  total: rows.length,
  tables: [],
  durationMs: 1,
  droppedValues: 0,
  runId: 'r',
  diagnostics: [],
  permissions: [],
});

const param = (name: string, extra: Partial<WorkbookParameter> = {}): WorkbookParameter => ({
  name,
  type: 'text',
  value: '',
  required: false,
  choices: null,
  label: null,
  multi: false,
  all: false,
  remember: false,
  huntingTimespan: false,
  ...extra,
});
const query = (text: string, source: 'graph' | 'hunting' = 'graph') => ({ choicesQuery: { source, text, options: null } });

describe('choices', () => {
  it('choicesFrom: first column value, second label, nulls dropped, duplicates keep the first', () => {
    const rows = [[1, 'One'], [null, 'x'], ['', ''], [1, 'Dup'], [new Date(0).toISOString()]];
    expect(choicesFrom(result(rows))).toEqual({
      items: [
        { value: '1', label: 'One' },
        { value: '1970-01-01T00:00:00.000Z', label: '1970-01-01T00:00:00.000Z' },
      ],
      capped: false,
    });
  });

  it('choicesFrom caps at 1000', () => {
    const out = choicesFrom(result(Array.from({ length: MAX_CHOICES + 1 }, (_, i) => [i])));
    expect(out.items).toHaveLength(1000);
    expect(out.capped).toBe(true);
  });

  it('choiceWidget is null without a query, and fixes its own name as empty only when the text names it', () => {
    expect(choiceWidget(param('A'))).toBeNull();
    expect(choiceWidget(param('A', query('T {B}')))?.parameters).toEqual({});
    expect(choiceWidget(param('A', query('T {A} {B}')))).toMatchObject({
      id: 'param:A',
      type: 'table',
      query: { source: 'graph', text: 'T {A} {B}', options: null, parameters: [], saved: null },
      parameters: { A: { from: 'fixed', value: '' } },
    });
  });

  it('choicesUsing: parameters whose query takes the value, or the hunting timespan, never itself', () => {
    const doc = {
      ...newWorkbook('t'),
      parameters: [
        param('Span', { type: 'timespan', huntingTimespan: true, ...query('T {Span}', 'hunting') }),
        param('A', query('T {A} {B}')),
        param('B', query('T {A}')),
        param('H', query('T', 'hunting')),
        param('G', query('T')),
      ],
    };
    expect(choicesUsing(doc, 'A')).toEqual(['B']);
    expect(choicesUsing(doc, 'B')).toEqual(['A']);
    expect(choicesUsing(doc, 'Span')).toEqual(['H']);
  });
});
