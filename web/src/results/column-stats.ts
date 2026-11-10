import type { ResultColumn } from '../wire';

export interface TopValue {
  value: unknown;
  count: number;
  share: number;
}
export interface ColumnStats {
  rows: number;
  distinct: number;
  empty: number;
  top: TopValue[];
  more: number;
  min?: number;
  max?: number;
  average?: number;
  earliest?: string;
  latest?: string;
}

export const NUMERIC = new Set(['int', 'long', 'real', 'decimal', 'double']);
export const TOP_VALUES = 10;
export const CHUNKED_ABOVE = 200_000;
const CHUNK = 50_000;

function accumulator(column: ResultColumn) {
  const counts = new Map<string, { value: unknown; count: number }>();
  const isNumber = NUMERIC.has(column.type);
  const isTime = column.type === 'datetime';
  let rows = 0;
  let empty = 0;
  let n = 0;
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  let earliest: { t: number; text: string } | undefined;
  let latest: { t: number; text: string } | undefined;

  return {
    add(values: unknown[], from: number, to: number) {
      for (let i = from; i < to; i++) {
        const v = values[i];
        rows++;
        if (v === null || v === undefined || v === '') {
          empty++;
          continue;
        }
        // Prefix keeps the string "1" apart from the number 1.
        const key = typeof v === 'string' ? `s${v}` : `j${JSON.stringify(v)}`;
        const entry = counts.get(key);
        if (entry) entry.count++;
        else counts.set(key, { value: v, count: 1 });
        if (isNumber && typeof v === 'number' && Number.isFinite(v)) {
          n++;
          sum += v;
          if (v < min) min = v;
          if (v > max) max = v;
        } else if (isTime && typeof v === 'string') {
          const t = Date.parse(v);
          if (!Number.isNaN(t)) {
            if (!earliest || t < earliest.t) earliest = { t, text: v };
            if (!latest || t > latest.t) latest = { t, text: v };
          }
        }
      }
    },
    result(): ColumnStats {
      const sorted = [...counts.entries()].sort(([ka, a], [kb, b]) => b.count - a.count || (ka < kb ? -1 : ka > kb ? 1 : 0));
      const stats: ColumnStats = {
        rows,
        distinct: counts.size,
        empty,
        top: sorted.slice(0, TOP_VALUES).map(([, e]) => ({ value: e.value, count: e.count, share: e.count / rows })),
        more: Math.max(0, counts.size - TOP_VALUES),
      };
      if (n > 0) Object.assign(stats, { min, max, average: sum / n });
      if (earliest && latest) Object.assign(stats, { earliest: earliest.text, latest: latest.text });
      return stats;
    },
  };
}

export function columnStats(column: ResultColumn, values: unknown[]): ColumnStats {
  const acc = accumulator(column);
  acc.add(values, 0, values.length);
  return acc.result();
}

export async function columnStatsChunked(column: ResultColumn, values: unknown[], signal: AbortSignal): Promise<ColumnStats | null> {
  const acc = accumulator(column);
  for (let from = 0; from < values.length; from += CHUNK) {
    if (signal.aborted) return null;
    acc.add(values, from, Math.min(from + CHUNK, values.length));
    await new Promise((r) => setTimeout(r, 0));
  }
  return signal.aborted ? null : acc.result();
}
