import { useId, useState } from 'react';
import { commonColumns, diffRows } from './diff';
import { cellText, type ResultTable, type Row } from './export';
import { ResultGrid } from './result-grid';

/** The diff table shows at most this many rows; the summary still counts them all. */
const MAX_SHOWN = 1000;
const count = (n: number) => n.toLocaleString('en-US');

/**
 * Compare (spec 6.5, mockup Light): the pinned run against this one, as a diff of rows matched on a key column chosen from the
 * columns both have (added rows in the ok colour, removed in the bad colour, changed cells marked with old → new), or as two
 * grids side by side.
 */
export function CompareView({ pinned, current }: { pinned: ResultTable; current: ResultTable }) {
  const [mode, setMode] = useState<'diff' | 'side'>('diff');
  const common = commonColumns(pinned, current);
  const [chosenKey, setKey] = useState<string | null>(null);
  const key = chosenKey && common.includes(chosenKey) ? chosenKey : common[0];
  const id = useId();

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <button type="button" className="btn" aria-pressed={mode === 'diff'} onClick={() => setMode('diff')}>
          Diff
        </button>
        <button type="button" className="btn" aria-pressed={mode === 'side'} onClick={() => setMode('side')}>
          Side by side
        </button>
        {mode === 'diff' && key && (
          <>
            <span className="sep" aria-hidden="true" />
            <label htmlFor={`${id}-key`} className="muted text-[12px]">
              Match rows on
            </label>
            <select id={`${id}-key`} className="textbox" style={{ height: 28 }} value={key} onChange={(e) => setKey(e.target.value)}>
              {common.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </>
        )}
      </div>
      {mode === 'side' ? (
        <div className="flex min-h-0 flex-1">
          <section aria-label="Pinned run" className="flex min-w-0 flex-1 flex-col border-r border-line">
            <ResultGrid columns={pinned.columns} rows={pinned.rows} />
          </section>
          <section aria-label="This run" className="flex min-w-0 flex-1 flex-col">
            <ResultGrid columns={current.columns} rows={current.rows} />
          </section>
        </div>
      ) : key ? (
        <Diff pinned={pinned} current={current} keyColumn={key} columns={common} />
      ) : (
        <p className="faint m-0 p-4 text-[12px]">The two runs have no column in common to match rows on.</p>
      )}
    </div>
  );
}

function Diff({ pinned, current, keyColumn, columns }: { pinned: ResultTable; current: ResultTable; keyColumn: string; columns: string[] }) {
  const diff = diffRows(pinned, current, keyColumn);
  const at = (t: ResultTable) => new Map(t.columns.map((c, i) => [c.name, i]));
  const before = at(pinned);
  const after = at(current);
  const value = (row: Row, cols: Map<string, number>, name: string) => cellText(row[cols.get(name) ?? -1]);

  const lines = [
    ...diff.added.map((row, i) => (
      <tr key={`a${i}`} className="text-ok">
        {columns.map((c, j) => (
          <td key={c}>
            {j === 0 ? '+ ' : ''}
            {value(row, after, c)}
          </td>
        ))}
      </tr>
    )),
    ...diff.changed.map((change, i) => (
      <tr key={`c${i}`}>
        {columns.map((c) =>
          change.columns.includes(c) ? (
            <td key={c} data-changed="true" className="text-warn">
              {`${value(change.before, before, c)} → ${value(change.after, after, c)}`}
            </td>
          ) : (
            <td key={c}>{value(change.after, after, c)}</td>
          ),
        )}
      </tr>
    )),
    ...diff.removed.map((row, i) => (
      <tr key={`r${i}`} className="text-bad">
        {columns.map((c, j) => (
          <td key={c}>
            {j === 0 ? '− ' : ''}
            {value(row, before, c)}
          </td>
        ))}
      </tr>
    )),
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-auto" tabIndex={0} role="region" aria-label="Compared rows">
        <table className="datagrid" aria-label="Differences">
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c} scope="col" className="px-3 py-[7px]">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>{lines.slice(0, MAX_SHOWN)}</tbody>
        </table>
        {lines.length === 0 && <p className="faint m-0 p-4 text-[12px]">The two runs have the same rows.</p>}
      </div>
      <div className="muted flex gap-3 border-t border-line px-3 py-2 text-[12px]">
        <span>
          {count(diff.added.length)} added · {count(diff.removed.length)} removed · {count(diff.changed.length)} changed · {count(diff.same)} the same
        </span>
        {lines.length > MAX_SHOWN && <span>Showing the first {count(MAX_SHOWN)} differences.</span>}
      </div>
    </div>
  );
}
