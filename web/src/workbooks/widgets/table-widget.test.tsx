import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { HighlightRule, RunResult } from '../../wire';
import { newWidget } from '../model';
import { TableWidget } from './table-widget';

const result: RunResult = {
  outcome: 'ok',
  message: null,
  error: null,
  columns: [{ name: 'state', type: 'string' }],
  rows: [['FAIL'], ['OK']],
  total: 2,
  tables: [],
  durationMs: 1,
  droppedValues: 0,
  runId: 'r',
  diagnostics: [],
  permissions: [],
};

describe('TableWidget', () => {
  it('marks the rows its query’s highlight rules match', () => {
    const w = newWidget('table', { x: 0, y: 0, w: 4, h: 12 });
    const rule: HighlightRule = { id: 'r', column: 'state', op: '==', value: 'FAIL', colour: 'danger', target: 'row' };
    const widget = { ...w, query: { ...w.query!, highlights: [rule] } };
    const { container } = render(<TableWidget widget={widget} run={{ state: 'done', result, finishedAt: 1 }} />);
    expect([...container.querySelectorAll('tbody tr[data-index]')].map((tr) => tr.getAttribute('data-highlight'))).toEqual([
      'danger',
      null,
    ]);
  });
});
