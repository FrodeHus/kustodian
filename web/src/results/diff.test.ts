import { describe, expect, it } from 'vitest';
import { commonColumns, defaultKey, diffRows } from './diff';

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

  it('diff_rows_matches_repeated_keys_in_order', () => {
    const cols = [
      { name: 'app', type: 'string' },
      { name: 'n', type: 'long' },
    ];
    const first = { columns: cols, rows: [['Teams', 1], ['Teams', 2], ['Teams', 3], ['Mail', 4]] };
    const second = { columns: cols, rows: [['Teams', 1], ['Teams', 9]] };

    const diff = diffRows(first, second, 'app');

    // The first Teams with the first, the second with the second; the third Teams and Mail are left over.
    expect(diff.same).toBe(1);
    expect(diff.changed).toEqual([{ key: 'Teams', columns: ['n'], before: ['Teams', 2], after: ['Teams', 9] }]);
    expect(diff.removed).toEqual([['Teams', 3], ['Mail', 4]]);
    expect(diff.added).toEqual([]);
    // The summary adds up to both runs' row counts.
    expect(diff.added.length + diff.changed.length + diff.same).toBe(second.rows.length);
    expect(diff.removed.length + diff.changed.length + diff.same).toBe(first.rows.length);
  });

  it('diff_rows_matches_null_keys_as_a_key_of_their_own', () => {
    const cols = [
      { name: 'owner', type: 'string' },
      { name: 'n', type: 'long' },
    ];
    const diff = diffRows(
      { columns: cols, rows: [[null, 1], ['', 2]] },
      { columns: cols, rows: [[null, 1], [null, 5], ['', 2]] },
      'owner',
    );

    expect(diff.same).toBe(2);
    expect(diff.added).toEqual([[null, 5]]);
    expect(diff.removed).toEqual([]);
  });

  it('default_key_is_the_first_column_unique_in_both_runs', () => {
    const cols = [
      { name: 'app', type: 'string' },
      { name: 'id', type: 'string' },
    ];
    const first = { columns: cols, rows: [['Teams', '1'], ['Teams', '2']] };
    expect(defaultKey(first, { columns: cols, rows: [['Mail', '3']] })).toEqual({ key: 'id', unique: true });
    expect(defaultKey(first, { columns: cols, rows: [['Mail', '3'], ['Chat', '3']] })).toEqual({ key: 'app', unique: false });
    expect(defaultKey(first, { columns: [{ name: 'other', type: 'string' }], rows: [] })).toBeUndefined();
  });

  it('common_columns_keep_the_first_runs_order', () => {
    expect(commonColumns(a, b)).toEqual(['app', 'signIns']);
  });
});
