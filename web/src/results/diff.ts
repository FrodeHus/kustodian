import { cellText, type ResultTable, type Row } from './export';

/** A row both runs have, by key, whose values differ in `columns`. `before` is the row in the first run, `after` in the second. */
export interface ChangedRow {
  key: string;
  columns: string[];
  before: Row;
  after: Row;
}

export interface RowDiff {
  /** Rows only the second run has, as it has them. */
  added: Row[];
  /** Rows only the first run has, as it has them. */
  removed: Row[];
  changed: ChangedRow[];
  /** How many rows both runs have with the same values. */
  same: number;
}

/** A value as compared: its JSON, so null, "" and "1" and 1 all differ, and dynamic values compare by content. */
const comparable = (value: unknown) => JSON.stringify(value ?? null);

/** The column names both runs have, in the first run's order. */
export function commonColumns(a: ResultTable, b: ResultTable): string[] {
  const names = new Set(b.columns.map((c) => c.name));
  return a.columns.map((c) => c.name).filter((n) => names.has(n));
}

/**
 * The rows of run `b` against run `a`, matched by their value in `keyColumn` (the first row with a key wins when a run has it
 * twice). Matched rows are compared on the columns both runs have, dynamic values by their JSON.
 */
export function diffRows(a: ResultTable, b: ResultTable, keyColumn: string): RowDiff {
  const common = commonColumns(a, b);
  const at = (t: ResultTable) => new Map(t.columns.map((c, i) => [c.name, i]));
  const aAt = at(a);
  const bAt = at(b);
  const key = (row: Row, cols: Map<string, number>) => comparable(row[cols.get(keyColumn) ?? -1]);

  const before = new Map<string, Row>();
  for (const row of a.rows) {
    const k = key(row, aAt);
    if (!before.has(k)) {
      before.set(k, row);
    }
  }

  const added: Row[] = [];
  const changed: ChangedRow[] = [];
  const matched = new Set<string>();
  let same = 0;
  for (const row of b.rows) {
    const k = key(row, bAt);
    const old = before.get(k);
    if (!old || matched.has(k)) {
      if (!old) {
        added.push(row);
      }
      continue;
    }
    matched.add(k);
    const columns = common.filter((name) => comparable(old[aAt.get(name) ?? -1]) !== comparable(row[bAt.get(name) ?? -1]));
    if (columns.length > 0) {
      changed.push({ key: cellText(row[bAt.get(keyColumn) ?? -1]), columns, before: old, after: row });
    } else {
      same++;
    }
  }
  const removed = [...before].filter(([k]) => !matched.has(k)).map(([, row]) => row);
  return { added, removed, changed, same };
}
