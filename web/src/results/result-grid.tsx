import {
  flexRender,
  getCoreRowModel,
  getExpandedRowModel,
  getFilteredRowModel,
  getGroupedRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type ExpandedState,
  type FilterFn,
  type Row as TableRow,
  type SortingFn,
  type SortingState,
  type VisibilityState,
} from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { ResultColumn } from '../wire';
import { COPY_FORMATS, copyFailed, copyText, formatRows, type CopyFormat } from './copy';
import { cellText, type Row } from './export';

const ROW_HEIGHT = 29;
const NUMERIC = new Set(['int', 'long', 'real', 'decimal', 'double']);

const isComplex = (value: unknown) => typeof value === 'object' && value !== null;
const count = (n: number) => n.toLocaleString('en-US');
const rowCount = (n: number) => `${count(n)} ${n === 1 ? 'row' : 'rows'}`;

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

/** The leaf rows under `rows` in the order shown, groups opened or not. */
function leaves(rows: TableRow<Row>[]): TableRow<Row>[] {
  return rows.flatMap((r) => (r.getIsGrouped() ? leaves(r.subRows) : [r]));
}

interface Opened {
  column: string;
  value: unknown;
}

export interface Notice {
  tone: 'ok' | 'bad';
  text: string;
}

/** A notice line: success as a status, failure as an alert. */
export function NoticeLine({ notice, onDismiss }: { notice: Notice; onDismiss: () => void }) {
  return (
    <div
      role={notice.tone === 'bad' ? 'alert' : 'status'}
      className={`flex items-center gap-3 border-t border-line px-3 py-1.5 text-[12px] ${notice.tone === 'bad' ? 'bg-bad-soft text-bad' : 'text-muted'}`}
    >
      <span className="min-w-0">{notice.text}</span>
      <div className="grow" />
      <button type="button" className="btn ghost" onClick={onDismiss}>
        Dismiss
      </button>
    </div>
  );
}

/**
 * A button that opens a menu. Opening it moves focus to the first item; the arrow keys, Home and End move between items.
 * Choosing an item (unless it has `data-keep-open`) or pressing Esc closes it and puts focus back on the button; a mousedown
 * outside it, or Tab, closes it and leaves focus where it went.
 *
 * It never closes on blur: macOS WKWebView doesn't focus a button on mousedown, so focus leaves the menu before the click on an
 * item lands. Items also keep focus from moving on mousedown.
 */
export function MenuButton({
  label,
  text,
  primary = false,
  children,
}: {
  /** The menu's name, and the button's unless `text` is given. */
  label: string;
  text?: string;
  primary?: boolean;
  /** The menu's items: buttons with a `menuitem…` role and `tabIndex={-1}`. */
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const items = () => [...(menu.current?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)') ?? [])];

  useEffect(() => {
    if (!open) {
      return;
    }
    items()[0]?.focus();
    const onDown = (e: globalThis.MouseEvent) => {
      if (!(e.target instanceof Node) || !ref.current?.contains(e.target)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };

  const onKey = (e: KeyboardEvent) => {
    const list = items();
    const at = list.findIndex((b) => b === document.activeElement);
    const move = (to: number) => list[(to + list.length) % list.length]?.focus();
    switch (e.key) {
      case 'ArrowDown':
        move(at + 1);
        break;
      case 'ArrowUp':
        move(at - 1);
        break;
      case 'Home':
        move(0);
        break;
      case 'End':
        move(list.length - 1);
        break;
      case 'Escape':
        close();
        break;
      case 'Tab':
        setOpen(false);
        return;
      default:
        return;
    }
    e.preventDefault();
  };

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        ref={trigger}
        type="button"
        className={`whitespace-nowrap ${primary ? 'btn' : 'btn ghost'}`}
        aria-label={text ? undefined : label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {text ?? label}
        {primary && <span aria-hidden="true"> ▾</span>}
      </button>
      {open && (
        <div
          ref={menu}
          className="menu"
          role="menu"
          aria-label={label}
          style={{ right: 0, top: 32, minWidth: 200, maxHeight: 360, overflowY: 'auto' }}
          onKeyDown={onKey}
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => {
            // After the item's own click: it has done its work.
            const item = e.target instanceof Element ? e.target.closest('[role^="menuitem"]') : null;
            if (item && !item.hasAttribute('data-keep-open')) {
              close();
            }
          }}
        >
          {children}
        </div>
      )}
    </div>
  );
}

interface GridProps {
  columns: ResultColumn[];
  rows: Row[];
  /** A row was opened (double-click, or Enter on the selected row): its index in `rows`. */
  onOpenRow?: (index: number) => void;
  /**
   * Where the grid's tools (filter, columns, group by, copy) go: an element of the result bar to render them into, null to
   * leave them out (the Rows tab isn't showing), or undefined for a bar of their own above the grid.
   */
  toolbar?: Element | null;
}

/**
 * The Rows tab (spec 6.5): a virtualized grid with sort, a row filter, hidden and reordered columns, grouping by a column,
 * row selection (click, Shift-click a range, Ctrl/⌘-click to toggle), copy as CSV, Markdown or JSON, and dynamic cells opened
 * as formatted JSON.
 */
export function ResultGrid({ columns, rows, onOpenRow, toolbar }: GridProps) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [filter, setFilter] = useState('');
  const [opened, setOpened] = useState<Opened | null>(null);
  const [visibility, setVisibility] = useState<VisibilityState>({});
  const [order, setOrder] = useState<string[]>([]);
  const [grouping, setGrouping] = useState<string[]>([]);
  const [expanded, setExpanded] = useState<ExpandedState>({});
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  // A new result's rows start with nothing selected.
  const [rowsSeen, setRowsSeen] = useState(rows);
  if (rowsSeen !== rows) {
    setRowsSeen(rows);
    setSelected(new Set());
    setAnchor(null);
  }
  const scroller = useRef<HTMLDivElement>(null);

  const meta = useMemo(() => new Map(columns.map((c) => [c.name, c])), [columns]);
  const defs = useMemo<ColumnDef<Row>[]>(
    () =>
      columns.map((c, i) => ({
        id: c.name,
        header: c.name,
        accessorFn: (row) => row[i],
        sortingFn: compareCells,
        sortUndefined: 'last',
        getGroupingValue: (row) => cellText(row[i]),
      })),
    [columns],
  );

  const table = useReactTable<Row>({
    data: rows,
    columns: defs,
    state: { sorting, globalFilter: filter, columnVisibility: visibility, columnOrder: order, grouping, expanded },
    onSortingChange: setSorting,
    onGlobalFilterChange: setFilter,
    onColumnVisibilityChange: setVisibility,
    onColumnOrderChange: setOrder,
    onGroupingChange: setGrouping,
    onExpandedChange: setExpanded,
    globalFilterFn: rowContains,
    // The grouped column keeps its place rather than moving first.
    groupedColumnMode: false,
    // The first click sorts ascending for every type (TanStack would start numbers descending).
    sortDescFirst: false,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getGroupedRowModel: getGroupedRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getExpandedRowModel: getExpandedRowModel(),
  });

  const visible = table.getRowModel().rows;
  const shownLeaves = visible.filter((r) => !r.getIsGrouped());
  const visibleColumns = table.getVisibleLeafColumns();
  const virtualizer = useVirtualizer({
    count: visible.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });
  const items = virtualizer.getVirtualItems();
  const padTop = items[0]?.start ?? 0;
  const padBottom = virtualizer.getTotalSize() - (items.at(-1)?.end ?? 0);

  // Every column in the order shown, hidden ones included.
  const ids = columns.map((c) => c.name);
  const ordered = [...order.filter((id) => meta.has(id)), ...ids.filter((id) => !order.includes(id))];
  const isShown = (id: string) => visibility[id] !== false;

  /** Moves a column before the shown column before it (`-1`), or after the shown column after it (`1`). */
  const neighbour = (id: string, step: -1 | 1): string | undefined => {
    const at = ordered.indexOf(id);
    const others = step < 0 ? ordered.slice(0, at).reverse() : ordered.slice(at + 1);
    return others.find(isShown);
  };
  const move = (id: string, step: -1 | 1) => {
    const other = neighbour(id, step);
    if (!other) {
      return;
    }
    const rest = ordered.filter((c) => c !== id);
    const at = rest.indexOf(other) + (step > 0 ? 1 : 0);
    setOrder([...rest.slice(0, at), id, ...rest.slice(at)]);
  };

  const select = (row: TableRow<Row>, e: MouseEvent) => {
    if (e.shiftKey && anchor !== null) {
      const from = shownLeaves.findIndex((r) => r.id === anchor);
      const to = shownLeaves.indexOf(row);
      if (from >= 0) {
        const [lo, hi] = from < to ? [from, to] : [to, from];
        setSelected(new Set(shownLeaves.slice(lo, hi + 1).map((r) => r.id)));
        return;
      }
    }
    if (e.ctrlKey || e.metaKey) {
      const next = new Set(selected);
      if (!next.delete(row.id)) {
        next.add(row.id);
      }
      setSelected(next);
    } else {
      setSelected(new Set([row.id]));
    }
    setAnchor(row.id);
  };

  const onGridKey = (e: KeyboardEvent<HTMLDivElement>) => {
    // Keys on a cell's button are the button's.
    if (e.target !== e.currentTarget) {
      return;
    }
    const at = shownLeaves.findIndex((r) => r.id === anchor);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const next = shownLeaves[at < 0 ? 0 : Math.min(Math.max(at + (e.key === 'ArrowDown' ? 1 : -1), 0), shownLeaves.length - 1)];
      if (next) {
        setSelected(new Set([next.id]));
        setAnchor(next.id);
        virtualizer.scrollToIndex(visible.indexOf(next));
      }
      e.preventDefault();
    } else if (e.key === 'Enter' && at >= 0) {
      onOpenRow?.(shownLeaves[at]?.index ?? 0);
      e.preventDefault();
    }
  };

  const copy = (format: CopyFormat, header: boolean) => {
    const all = leaves(table.getSortedRowModel().rows);
    const chosen = selected.size > 0 ? all.filter((r) => selected.has(r.id)) : all;
    const shownColumns = visibleColumns.map((c) => meta.get(c.id)).filter((c): c is ResultColumn => !!c);
    const at = shownColumns.map((c) => columns.indexOf(c));
    const values = chosen.map((r) => at.map((i) => r.original[i]));
    const name = COPY_FORMATS.find((f) => f.format === format)?.name ?? format;
    copyText(formatRows(format, shownColumns, values, header)).then(
      () => setNotice({ tone: 'ok', text: `Copied ${rowCount(values.length)} as ${name}.` }),
      (e: unknown) => setNotice({ tone: 'bad', text: copyFailed(e) }),
    );
  };

  const groupedBy = grouping[0];
  const filtered = leaves(table.getSortedRowModel().rows).length;

  const tools = (
    <>
      <input
        className="search"
        type="search"
        aria-label="Filter rows"
        placeholder="Filter rows"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        style={{ flex: '0 1 200px', minWidth: 80, margin: 0 }}
      />
      <MenuButton label="Columns">
        <>
          {ordered.map((id) => (
            <div key={id} className="flex items-center gap-0.5">
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={isShown(id)}
                tabIndex={-1}
                data-keep-open
                className="min-w-0 flex-1"
                onClick={() => setVisibility((v) => ({ ...v, [id]: !isShown(id) }))}
              >
                <span aria-hidden="true" className="w-3 text-accent">
                  {isShown(id) ? '✓' : ''}
                </span>
                <span className="mono truncate">{id}</span>
              </button>
              <button type="button" role="menuitem" tabIndex={-1} data-keep-open aria-label={`Move ${id} earlier`} disabled={!neighbour(id, -1)} onClick={() => move(id, -1)}>
                ↑
              </button>
              <button type="button" role="menuitem" tabIndex={-1} data-keep-open aria-label={`Move ${id} later`} disabled={!neighbour(id, 1)} onClick={() => move(id, 1)}>
                ↓
              </button>
            </div>
          ))}
          <button type="button" role="menuitem" tabIndex={-1} data-keep-open onClick={() => setVisibility({})}>
            Show all columns
          </button>
        </>
      </MenuButton>
      <MenuButton label="Group by" text={groupedBy ? `Group by: ${groupedBy}` : undefined}>
        <>
          {[undefined, ...ids].map((id) => (
            <button
              key={id ?? ''}
              type="button"
              role="menuitemradio"
              aria-checked={groupedBy === id}
              tabIndex={-1}
              onClick={() => {
                setGrouping(id ? [id] : []);
                setExpanded({});
              }}
            >
              <span aria-hidden="true" className="w-3 text-accent">
                {groupedBy === id ? '●' : ''}
              </span>
              <span className={id ? 'mono' : undefined}>{id ?? 'No grouping'}</span>
            </button>
          ))}
        </>
      </MenuButton>
      <MenuButton label="Copy as" primary>
        <>
          <span className="faint px-2.5 py-1 text-[11.5px]">{selected.size > 0 ? `${rowCount(selected.size)} selected` : `All ${rowCount(filtered)}`}</span>
          {[true, false].flatMap((header) =>
            COPY_FORMATS.map(({ format, name }) => (
              <button
                key={`${header}-${format}`}
                type="button"
                role="menuitem"
                tabIndex={-1}
                onClick={() => copy(format, header)}
              >
                {header ? 'Rows' : 'Cells'} as {name}
              </button>
            )),
          )}
        </>
      </MenuButton>
    </>
  );

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {toolbar === undefined ? <div className="rbar justify-end">{tools}</div> : toolbar && createPortal(tools, toolbar)}
      <div ref={scroller} className="min-h-0 flex-1 overflow-auto" tabIndex={0} role="region" aria-label="Result rows" onKeyDown={onGridKey}>
        <table className="datagrid">
          <thead>
            {table.getHeaderGroups().map((group) => (
              <tr key={group.id}>
                {group.headers.map((header) => {
                  const column = meta.get(header.column.id);
                  const sorted = header.column.getIsSorted();
                  return (
                    <th
                      key={header.id}
                      scope="col"
                      className={column && NUMERIC.has(column.type) ? 'num' : undefined}
                      aria-sort={sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : 'none'}
                      title={column?.type}
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
                <td style={{ height: padTop, padding: 0, border: 0 }} colSpan={visibleColumns.length} />
              </tr>
            )}
            {items.map((item) => {
              const row = visible[item.index];
              if (!row) {
                return null;
              }
              if (row.getIsGrouped()) {
                const value = row.groupingValue;
                const open = row.getIsExpanded();
                return (
                  <tr key={row.id} data-index={item.index} style={{ height: ROW_HEIGHT }}>
                    <td colSpan={visibleColumns.length} className="bg-panel2">
                      <button type="button" aria-expanded={open} onClick={row.getToggleExpandedHandler()}>
                        {open ? '▾' : '▸'} {row.groupingColumnId}: {value === '' ? 'null' : cellText(value)} · {count(row.getLeafRows().length)}
                      </button>
                    </td>
                  </tr>
                );
              }
              const isSelected = selected.has(row.id);
              return (
                <tr
                  key={row.id}
                  data-index={item.index}
                  style={{ height: ROW_HEIGHT }}
                  className={isSelected ? 'sel' : undefined}
                  aria-selected={isSelected}
                  onMouseDown={(e) => {
                    // Shift-click selects rows, and a double-click opens one, rather than selecting text.
                    if (e.shiftKey || e.detail > 1) {
                      e.preventDefault();
                    }
                  }}
                  onClick={(e) => select(row, e)}
                  onDoubleClick={() => onOpenRow?.(row.index)}
                >
                  {row.getVisibleCells().map((cell) => {
                    const column = meta.get(cell.column.id);
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
                            aria-label={`Show ${column?.name ?? ''} as JSON`}
                            title={text}
                            onClick={() => setOpened({ column: column?.name ?? '', value })}
                          >
                            {text}
                          </button>
                        </td>
                      );
                    }
                    return (
                      <td key={cell.id} className={column && NUMERIC.has(column.type) ? 'num' : undefined}>
                        {cellText(value)}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
            {padBottom > 0 && (
              <tr aria-hidden="true">
                <td style={{ height: padBottom, padding: 0, border: 0 }} colSpan={visibleColumns.length} />
              </tr>
            )}
          </tbody>
        </table>
        {rows.length === 0 && <p className="faint m-0 p-4 text-[12px]">The query returned no rows.</p>}
      </div>
      {notice && <NoticeLine notice={notice} onDismiss={() => setNotice(null)} />}
      {opened && <JsonPanel opened={opened} onClose={() => setOpened(null)} />}
    </div>
  );
}

function JsonPanel({ opened, onClose }: { opened: Opened; onClose: () => void }) {
  return (
    <div
      role="dialog"
      aria-label={opened.column}
      className="absolute top-0 right-0 bottom-0 z-[2] flex w-[420px] max-w-full flex-col border-l border-line bg-panel shadow-[0_18px_40px_rgba(0,0,0,0.45)]"
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
