import { describe, expect, it } from 'vitest';
import { commonColumns, diffRows } from './diff';

const a = {
  columns: [
    { name: 'app', type: 'string' },
    { name: 'signIns', type: 'long' },
    { name: 'tags', type: 'dynamic' },
  ],
  rows: [
    ['Teams', 96, ['x']],
    ['Legacy Intranet', 3, null],
    ['Exchange', 40, ['y']],
  ],
};

// The second run has its columns in another order, one column more and one fewer.
const b = {
  columns: [
    { name: 'signIns', type: 'long' },
    { name: 'app', type: 'string' },
    { name: 'owner', type: 'string' },
  ],
  rows: [
    [118, 'Teams', 'kari'],
    [40, 'Exchange', 'ola'],
    [12, 'Azure Portal', 'kari'],
  ],
};

describe('diffRows', () => {
  it('diff_rows_added_removed_changed', () => {
    const diff = diffRows(a, b, 'app');

    expect(diff.added).toEqual([[12, 'Azure Portal', 'kari']]);
    expect(diff.removed).toEqual([['Legacy Intranet', 3, null]]);
    expect(diff.changed).toEqual([{ key: 'Teams', columns: ['signIns'], before: ['Teams', 96, ['x']], after: [118, 'Teams', 'kari'] }]);
    expect(diff.same).toBe(1);
  });

  it('diff_rows_compares_dynamic_values_by_their_json', () => {
    const cols = [
      { name: 'id', type: 'string' },
      { name: 'v', type: 'dynamic' },
    ];
    const diff = diffRows({ columns: cols, rows: [['1', { a: 1 }], ['2', [1]]] }, { columns: cols, rows: [['1', { a: 1 }], ['2', [2]]] }, 'id');

    expect(diff.changed.map((c) => c.key)).toEqual(['2']);
    expect(diff.same).toBe(1);
  });

  it('common_columns_keep_the_first_runs_order', () => {
    expect(commonColumns(a, b)).toEqual(['app', 'signIns']);
  });
});
