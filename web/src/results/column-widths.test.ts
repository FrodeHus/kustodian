import { describe, expect, it } from 'vitest';
import { columnWidths } from './column-widths';

describe('columnWidths', () => {
  it('makes_a_header_sized_column_wider_with_statistics', () => {
    const columns = [{ name: 'a_long_header_name', type: 'string' }];
    const plain = columnWidths(columns, [['x']]).get('a_long_header_name')!;
    expect(columnWidths(columns, [['x']], true).get('a_long_header_name')).toBeGreaterThan(plain);
  });
});
