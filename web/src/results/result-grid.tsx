import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type FilterFn,
  type SortingFn,
  type SortingState,
} from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useMemo, useRef, useState } from 'react';
import type { ResultColumn } from '../wire';

type Row = unknown[];

const ROW_HEIGHT = 29;
const NUMERIC = new Set(['int', 'long', 'real', 'decimal', 'double']);

const isComplex = (value: unknown) => typeof value === 'object' && value !== null;

/** A cell as text: dynamic values as compact JSON. */
function cellText(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  return isComplex(value) ? JSON.stringify(value) : String(value);
}

/** Nulls last; numbers by value; everything else by its text. */
const compareCells: SortingFn<Row> = (a, b, columnId) => {
  const x = a.getValue(columnId);
  const y = b.getValue(columnId);
  if (x === null || x === undefined) {
    return y === null || y === undefined ? 0 : 1;
  }
  if (y === null || y === undefined) {
    return -1;
  }
  if (typeof x === 'number' && typeof y === 'number') {
    return x - y;
  }
  return cellText(x).localeCompare(cellText(y), undefined, { numeric: true });
};

/** A row matches when any of its cells' text contains the filter, ignoring case. */
const rowContains: FilterFn<Row> = (row, _columnId, filter: string) => {
  const needle = filter.toLowerCase();
  return row.original.some((value) => cellText(value).toLowerCase().includes(needle));
};

interface Opened {
  column: string;
  value: unknown;
}

/** The Rows tab (spec 6.5 core): a virtualized grid with sort, a row filter, and dynamic cells opened as formatted JSON. */
export function ResultGrid({ columns, rows }: { columns: ResultColumn[]; rows: Row[] }) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [filter, setFilter] = useState('');
  const [opened, setOpened] = useState<Opened | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  const defs = useMemo<ColumnDef<Row>[]>(
    () =>
      columns.map((c, i) => ({
        id: String(i),
        header: c.name,
        accessorFn: (row) => row[i],
        sortingFn: compareCells,
        sortUndefined: 'last',
      })),
    [columns],
  );

  const table = useReactTable<Row>({
    data: rows,
    columns: defs,
    state: { sorting, globalFilter: filter },
    onSortingChange: setSorting,
    onGlobalFilterChange: setFilter,
    globalFilterFn: rowContains,
    // The first click sorts ascending for every type (TanStack would start numbers descending).
    sortDescFirst: false,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
  });

  const visible = table.getRowModel().rows;
  const virtualizer = useVirtualizer({
    count: visible.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });
  const items = virtualizer.getVirtualItems();
  const padTop = items[0]?.start ?? 0;
  const padBottom = virtualizer.getTotalSize() - (items.at(-1)?.end ?? 0);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div className="rbar">
        <div role="tablist" aria-label="Result" className="flex">
          <button type="button" role="tab" className="rtab" aria-selected="true">
            Rows · {visible.length.toLocaleString('en-US')}
          </button>
        </div>
        <div className="grow" />
        <input
          className="search"
          type="search"
          aria-label="Filter rows"
          placeholder="Filter rows"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          style={{ width: 200, margin: 0 }}
        />
      </div>
      <div ref={scroller} className="min-h-0 flex-1 overflow-auto" tabIndex={0} role="region" aria-label="Result rows">
        <table className="datagrid">
          <thead>
            {table.getHeaderGroups().map((group) => (
              <tr key={group.id}>
                {group.headers.map((header) => {
                  const meta = columns[Number(header.column.id)];
                  const sorted = header.column.getIsSorted();
                  return (
                    <th
                      key={header.id}
                      scope="col"
                      className={meta && NUMERIC.has(meta.type) ? 'num' : undefined}
                      aria-sort={sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : 'none'}
                      title={meta?.type}
                    >
                      <button type="button" onClick={header.column.getToggleSortingHandler()}>
                        {flexRender(header.column.columnDef.header, header.getContext())}
                        {sorted === 'asc' ? ' ↑' : sorted === 'desc' ? ' ↓' : ''}
                      </button>
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {padTop > 0 && (
              <tr aria-hidden="true">
                <td style={{ height: padTop, padding: 0, border: 0 }} colSpan={columns.length} />
              </tr>
            )}
            {items.map((item) => {
              const row = visible[item.index];
              if (!row) {
                return null;
              }
              return (
                <tr key={row.id} data-index={item.index} style={{ height: ROW_HEIGHT }}>
                  {row.getVisibleCells().map((cell) => {
                    const meta = columns[Number(cell.column.id)];
                    const value = cell.getValue();
                    if (value === null || value === undefined) {
                      return (
                        <td key={cell.id} className="faint">
                          null
                        </td>
                      );
                    }
                    if (isComplex(value)) {
                      const text = cellText(value);
                      return (
                        <td key={cell.id}>
                          <button
                            type="button"
                            aria-label={`Show ${meta?.name ?? ''} as JSON`}
                            title={text}
                            onClick={() => setOpened({ column: meta?.name ?? '', value })}
                          >
                            {text}
                          </button>
                        </td>
                      );
                    }
                    return (
                      <td key={cell.id} className={meta && NUMERIC.has(meta.type) ? 'num' : undefined}>
                        {cellText(value)}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
            {padBottom > 0 && (
              <tr aria-hidden="true">
                <td style={{ height: padBottom, padding: 0, border: 0 }} colSpan={columns.length} />
              </tr>
            )}
          </tbody>
        </table>
        {rows.length === 0 && <p className="faint m-0 p-4 text-[12px]">The query returned no rows.</p>}
      </div>
      {opened && <JsonPanel opened={opened} onClose={() => setOpened(null)} />}
    </div>
  );
}

function JsonPanel({ opened, onClose }: { opened: Opened; onClose: () => void }) {
  return (
    <div
      role="dialog"
      aria-label={opened.column}
      className="absolute top-[38px] right-0 bottom-0 z-[2] flex w-[420px] max-w-full flex-col border-l border-line bg-panel shadow-[0_18px_40px_rgba(0,0,0,0.45)]"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          onClose();
        }
      }}
    >
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <b className="mono text-[12.5px]">{opened.column}</b>
        <span className="faint text-[12px]">as JSON</span>
        <div className="grow" />
        <button type="button" className="btn ghost" onClick={onClose} autoFocus>
          Close
        </button>
      </div>
      <pre className="codeblock m-3 min-h-0 flex-1 overflow-auto">{JSON.stringify(opened.value, null, 2)}</pre>
    </div>
  );
}
