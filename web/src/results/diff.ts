import { cellText, type ResultTable, type Row } from './export';

/** A row both runs have, by key, whose values differ in `columns`. `before` is the row in the first run, `after` in the second. */
export interface ChangedRow {
  key: string;
  columns: string[];
  before: Row;
  after: Row;
}

/** How run `b` differs from run `a`. `added + changed + same` is `b`'s row count; `removed + changed + same` is `a`'s. */
export interface RowDiff {
  /** Rows only the second run has, as it has them. */
  added: Row[];
  /** Rows only the first run has, as it has them. */
  removed: Row[];
  changed: ChangedRow[];
  /** How many rows both runs have with the same values. */
  same: number;
}

/** A value as compared: its JSON, so null, "" and "1" and 1 all differ, and dynamic values compare by content. A null key is
 * a key of its own like any other. */
const comparable = (value: unknown) => JSON.stringify(value ?? null);

/** The column names both runs have, in the first run's order. */
export function commonColumns(a: ResultTable, b: ResultTable): string[] {
  const names = new Set(b.columns.map((c) => c.name));
  return a.columns.map((c) => c.name).filter((n) => names.has(n));
}

/** Whether every row of the run has a different value in `column`. */
export function isUnique(t: ResultTable, column: string): boolean {
  const at = t.columns.findIndex((c) => c.name === column);
  const seen = new Set(t.rows.map((r) => comparable(r[at])));
  return seen.size === t.rows.length;
}

/** The key column to match rows on at first: the first common column whose values are unique in both runs, else the first
 * common column (`unique: false`). Undefined when the runs have no column in common. */
export function defaultKey(a: ResultTable, b: ResultTable): { key: string; unique: boolean } | undefined {
  const common = commonColumns(a, b);
  const key = common.find((c) => isUnique(a, c) && isUnique(b, c));
  if (key) {
    return { key, unique: true };
  }
  return common[0] === undefined ? undefined : { key: common[0], unique: false };
}

/**
 * The rows of run `b` against run `a`, matched by their value in `keyColumn`. A key that repeats is matched in order: its
 * n-th row in `a` with its n-th row in `b`, and the rows left over are removed or added. Matched rows are compared on the
 * columns both runs have, dynamic values by their JSON.
 */
export function diffRows(a: ResultTable, b: ResultTable, keyColumn: string): RowDiff {
  const common = commonColumns(a, b);
  const at = (t: ResultTable) => new Map(t.columns.map((c, i) => [c.name, i]));
  const aAt = at(a);
  const bAt = at(b);
  const key = (row: Row, cols: Map<string, number>) => comparable(row[cols.get(keyColumn) ?? -1]);

  // Each key's rows in `a`, in order, and how many of them `b` has matched so far.
  const before = new Map<string, Row[]>();
  for (const row of a.rows) {
    const k = key(row, aAt);
    const list = before.get(k);
    if (list) {
      list.push(row);
    } else {
      before.set(k, [row]);
    }
  }
  const used = new Map<string, number>();

  const added: Row[] = [];
  const changed: ChangedRow[] = [];
  let same = 0;
  for (const row of b.rows) {
    const k = key(row, bAt);
    const n = used.get(k) ?? 0;
    const old = before.get(k)?.[n];
    if (!old) {
      added.push(row);
      continue;
    }
    used.set(k, n + 1);
    const columns = common.filter((name) => comparable(old[aAt.get(name) ?? -1]) !== comparable(row[bAt.get(name) ?? -1]));
    if (columns.length > 0) {
      changed.push({ key: cellText(row[bAt.get(keyColumn) ?? -1]), columns, before: old, after: row });
    } else {
      same++;
    }
  }
  // The rows of `a` no row of `b` matched, in `a`'s order.
  const seen = new Map<string, number>();
  const removed = a.rows.filter((row) => {
    const k = key(row, aAt);
    const n = seen.get(k) ?? 0;
    seen.set(k, n + 1);
    return n >= (used.get(k) ?? 0);
  });
  return { added, removed, changed, same };
}
