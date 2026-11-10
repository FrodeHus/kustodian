import { describe, expect, it } from 'vitest';
import { columnStats, columnStatsChunked } from './column-stats';

const str = { name: 'c', type: 'string' };
const long = { name: 'c', type: 'long' };

describe('columnStats', () => {
  it('counts strings, empties and top values', () => {
    const s = columnStats(str, ['a', 'b', 'a', null, '', 'a']);
    expect(s).toMatchObject({ rows: 6, distinct: 2, empty: 2, more: 0 });
    expect(s.top).toEqual([
      { value: 'a', count: 3, share: 0.5 },
      { value: 'b', count: 1, share: 1 / 6 },
    ]);
  });

  it('sorts ties by key', () => {
    expect(columnStats(str, ['b', 'a']).top.map((t) => t.value)).toEqual(['a', 'b']);
  });

  it('caps top at 10 and reports the rest', () => {
    const s = columnStats(
      str,
      Array.from({ length: 12 }, (_, i) => `v${String(i).padStart(2, '0')}`),
    );
    expect(s.top).toHaveLength(10);
    expect(s.more).toBe(2);
  });

  it('computes min, max and average for numbers', () => {
    expect(columnStats(long, [3, 1, null, 2])).toMatchObject({ min: 1, max: 3, average: 2 });
  });

  it('counts a string-encoded long but leaves it out of min/max/average', () => {
    const s = columnStats(long, ['9007199254740993']);
    expect(s.distinct).toBe(1);
    expect([s.min, s.max, s.average]).toEqual([undefined, undefined, undefined]);
  });

  it('handles all null', () => {
    const s = columnStats(long, [null, null]);
    expect(s).toMatchObject({ rows: 2, distinct: 0, empty: 2, top: [], more: 0 });
    expect([s.min, s.max, s.average]).toEqual([undefined, undefined, undefined]);
  });

  it('handles no rows', () => {
    expect(columnStats(long, [])).toEqual({ rows: 0, distinct: 0, empty: 0, top: [], more: 0 });
  });

  it('finds earliest and latest datetimes as the cell text', () => {
    const s = columnStats({ name: 'c', type: 'datetime' }, ['2025-03-04T10:15:00Z', '2024-11-27T14:30:12Z']);
    expect(s.earliest).toBe('2024-11-27T14:30:12Z');
    expect(s.latest).toBe('2025-03-04T10:15:00Z');
  });

  it('treats dynamic values by content, with [] as a value', () => {
    const s = columnStats({ name: 'c', type: 'dynamic' }, [{ a: 1 }, { a: 1 }, []]);
    expect(s).toMatchObject({ distinct: 2, empty: 0 });
    expect(s.top[0]).toEqual({ value: { a: 1 }, count: 2, share: 2 / 3 });
  });
});

describe('columnStatsChunked', () => {
  const values = Array.from({ length: 120_000 }, (_, i) => (i % 7 === 0 ? null : i % 1000));

  it('matches columnStats', async () => {
    expect(await columnStatsChunked(long, values, new AbortController().signal)).toEqual(columnStats(long, values));
  });

  it('resolves null when aborted', async () => {
    const ctl = new AbortController();
    const p = columnStatsChunked(long, values, ctl.signal);
    ctl.abort();
    expect(await p).toBeNull();
  });
});
