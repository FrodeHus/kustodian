import {
  columnFilteringFeature,
  columnGroupingFeature,
  columnOrderingFeature,
  columnVisibilityFeature,
  createFilteredRowModel,
  createGroupedRowModel,
  createSortedRowModel,
  flexRender,
  globalFilteringFeature,
  rowExpandingFeature,
  rowSortingFeature,
  tableFeatures,
  useTable,
  type ColumnDef,
  type ColumnVisibilityState,
  type ExpandedState,
  type FilterFn,
  type Row as TableRow,
  type SortFn,
  type SortingState,
} from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useEffectEvent, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { ErrorReportActions } from '../shell/error-report';
import type { ExternalTool, ResultColumn } from '../wire';
import { COPY_FORMATS, copyFailed, copyText, formatRows, type CopyFormat } from './copy';
import { columnWidths } from './column-widths';
import { cellText, type Row } from './export';
import type { CellMatch } from './chart-shape';
import { ColumnStatsPopover } from './column-stats-popover';
import { NUMERIC } from './column-stats';
import { RunToolDialog, ToolItems } from './run-tool';
import { FilterItems, MenuButton, Menu, type OnFilter } from './menu';
import { filterOps } from './smart-filter';

const ROW_HEIGHT = 29;
// One empty list, so a grid with no cell filters doesn't hand the table a new state each render.
const NO_FILTERS: CellMatch[] = [];
const features = tableFeatures({
  columnFilteringFeature,
  globalFilteringFeature,
  rowSortingFeature,
  columnVisibilityFeature,
  columnOrderingFeature,
  columnGroupingFeature,
  rowExpandingFeature,
  filteredRowModel: createFilteredRowModel(),
  groupedRowModel: createGroupedRowModel(),
  sortedRowModel: createSortedRowModel(),
});
type Features = typeof features;

const isComplex = (value: unknown) => typeof value === 'object' && value !== null;
const count = (n: number) => n.toLocaleString('en-US');
const rowCount = (n: number) => `${count(n)} ${n === 1 ? 'row' : 'rows'}`;

/** Nulls last; numbers by value; everything else by its text. */
const compareCells: SortFn<Features, Row> = (a, b, columnId) => {
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
const rowContains: FilterFn<Features, Row> = (row, _columnId, filter: string) => {
  const needle = filter.toLowerCase();
  return row.original.some((value) => cellText(value).toLowerCase().includes(needle));
};

/** A cell matches when its text is exactly the filter's: the rows behind a chart mark (see `markFilter`). */
const cellIs: FilterFn<Features, Row> = (row, columnId, value: string) => cellText(row.getValue(columnId)) === value;

/** At most this many grouping columns. */
const MAX_GROUPING = 3;

type GridRow = TableRow<Features, Row>;

/** The grouped rows in the order shown: every level of groups by row count, largest first (ties keep TanStack's order). */
interface GroupTree {
  /** The top level, ordered. */
  top: GridRow[];
  /** Each group row's own rows, ordered. */
  children: Map<GridRow, GridRow[]>;
  /** How many leaf rows each group row has. */
  size: Map<GridRow, number>;
  /** Every leaf row in the order shown, groups opened or not. */
  leaves: GridRow[];
}

/** Walks the row model once into a `GroupTree`; a level of rows stays as it is. */
function groupTree(rows: GridRow[]): GroupTree {
  const children = new Map<GridRow, GridRow[]>();
  const size = new Map<GridRow, number>();
  /** Orders a level, records what each group has, and returns the leaves under it. */
  const walk = (level: GridRow[]): { ordered: GridRow[]; leaves: GridRow[] } => {
    if (!level[0]?.getIsGrouped()) {
      return { ordered: level, leaves: level };
    }
    const under = new Map(level.map((r) => [r, walk(r.subRows)]));
    for (const [r, sub] of under) {
      children.set(r, sub.ordered);
      size.set(r, sub.leaves.length);
    }
    const ordered = level.toSorted((a, b) => (size.get(b) ?? 0) - (size.get(a) ?? 0));
    return { ordered, leaves: ordered.flatMap((r) => under.get(r)?.leaves ?? []) };
  };
  const { ordered, leaves } = walk(rows);
  return { top: ordered, children, size, leaves };
}

/** The rows shown: each group row, then what is under it when it is open (as `row.getIsExpanded()` reads `expanded`). */
function shownRows(tree: GroupTree, expanded: ExpandedState, rows: GridRow[] = tree.top): GridRow[] {
  return rows.flatMap((r) =>
    r.getIsGrouped() && (expanded === true || expanded[r.id]) ? [r, ...shownRows(tree, expanded, tree.children.get(r) ?? [])] : [r],
  );
}

interface Opened {
  column: string;
  value: unknown;
}

export interface Notice {
  tone: 'ok' | 'bad';
  text: string;
  /** The report ID the host gave the error, if it did. */
  reportId?: string;
  /** A button after the text, such as Edit tools…. */
  action?: { label: string; onClick: () => void };
}

/** A notice line: success as a status, failure as an alert. */
export function NoticeLine({ notice, onDismiss }: { notice: Notice; onDismiss: () => void }) {
  return (
    <div
      role={notice.tone === 'bad' ? 'alert' : 'status'}
      className={`flex items-center gap-3 border-t border-line px-3 py-1.5 text-[12px] ${notice.tone === 'bad' ? 'bg-bad-soft text-bad' : 'text-muted'}`}
    >
      <span className="min-w-0">{notice.text}</span>
      {notice.tone === 'bad' && <ErrorReportActions reportId={notice.reportId} uiSections={{ message: notice.text }} />}
      {notice.action && (
        <button type="button" className="btn ghost" onClick={notice.action.onClick}>
          {notice.action.label}
        </button>
      )}
      <div className="grow" />
      <button type="button" className="btn ghost" onClick={onDismiss}>
        Dismiss
      </button>
    </div>
  );
}

export interface GridSelection {
  mode: 'multi' | 'single';
  selected: ReadonlySet<number>;
  onChange: (selected: ReadonlySet<number>) => void;
}

interface GridProps {
  columns: ResultColumn[];
  rows: Row[];
  /**
   * A row was opened (its inspect button, a double-click, or Enter on the selected row): its index in `rows`. Null when the
   * inspect button of the row already open was pressed again, to close it.
   */
  onOpenRow?: (index: number | null) => void;
  /** The row open in the row details sheet, by its index in `rows`, and the sheet's id. */
  inspected?: number | null;
  inspectorId?: string;
  /**
   * Where the grid's tools (filter, columns, group by, copy) go: an element of the result bar to render them into, null to
   * leave them out (the Rows tab isn't showing), or undefined for a bar of their own above the grid.
   */
  toolbar?: Element | null;
  /** Only the rows whose cells have these texts, by column: the rows behind a chart mark that was clicked. */
  cellFilters?: CellMatch[];
  /**
   * A selection the caller keeps (a table widget), by row index in `rows`, with a checkbox column; 'none' turns selection
   * off. Without it the grid keeps its own selection and has no checkbox column, as the Rows tab does.
   */
  selection?: GridSelection | 'none';
  /** The indexes in `rows` of every row the filter lets through, in the order shown; called after a render that changed them. */
  onShownChange?: (shown: number[]) => void;
  /** A smart filter item was chosen in a cell's context menu. Without it, a right-click is the browser's own. */
  onFilter?: OnFilter;
  /** Each header gets a column menu with Column statistics (the query tab's Rows grid only). */
  statistics?: boolean;
  /** The columns the grid is grouped by, outermost first, when the caller keeps them (the query tab's Rows grid). Without it the
   * grid keeps its own. */
  grouping?: string[];
  onGroupingChange?: (columns: string[]) => void;
}

/** Where a header's column menu, or the statistics it opened, shows: the column, and the point in the grid under its header. */
interface ColumnAt {
  column: ResultColumn;
  at: { x: number; y: number };
}

/** A cell's context menu: the cell, and the point in the grid it opens at. */
interface CellMenu {
  column: ResultColumn;
  value: unknown;
  x: number;
  y: number;
}

/** A magnifier: the inspect button's icon. */
const inspectIcon = (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    aria-hidden="true"
  >
    <circle cx="10.5" cy="10.5" r="6.5" />
    <path d="m15.5 15.5 5 5" />
  </svg>
);

/**
 * The Rows tab (spec 6.5): a virtualized grid with sort, a row filter, hidden and reordered columns, grouping by up to three columns (groups largest first),
 * row selection (click, Shift-click a range, Ctrl/⌘-click to toggle), copy as CSV, Markdown or JSON, and dynamic cells opened
 * as formatted JSON. Each row starts with an inspect button that opens it in the row details sheet, or closes it there.
 */
export function ResultGrid({
  columns,
  rows,
  onOpenRow,
  inspected = null,
  inspectorId,
  toolbar,
  cellFilters = NO_FILTERS,
  selection,
  onShownChange,
  onFilter,
  statistics = false,
  grouping: givenGrouping,
  onGroupingChange,
}: GridProps) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [filter, setFilter] = useState('');
  const [opened, setOpened] = useState<Opened | null>(null);
  const [visibility, setVisibility] = useState<ColumnVisibilityState>({});
  const [order, setOrder] = useState<string[]>([]);
  const [ownGrouping, setOwnGrouping] = useState<string[]>([]);
  const [expanded, setExpanded] = useState<ExpandedState>({});
  const [ownSelected, setOwnSelected] = useState<ReadonlySet<number>>(new Set());
  const [anchor, setAnchor] = useState<number | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [tool, setTool] = useState<ExternalTool | null>(null);
  const [cellMenu, setCellMenu] = useState<CellMenu | null>(null);
  const [columnMenu, setColumnMenu] = useState<ColumnAt | null>(null);
  const [stats, setStats] = useState<(ColumnAt & { values: unknown[]; opened: number }) | null>(null);
  const columnMenuButton = useRef<HTMLButtonElement | null>(null);
  const root = useRef<HTMLDivElement>(null);
  // A new result's rows start with nothing selected, and with no statistics of the old ones.
  const [rowsSeen, setRowsSeen] = useState(rows);
  if (rowsSeen !== rows) {
    setRowsSeen(rows);
    setExpanded({});
    setOwnSelected(new Set());
    setAnchor(null);
    setColumnMenu(null);
    setStats(null);
  }
  const scroller = useRef<HTMLDivElement>(null);
  // Only the grouped columns this result still has.
  const wanted = givenGrouping ?? ownGrouping;
  const grouping = useMemo(() => wanted.filter((id) => columns.some((c) => c.name === id)), [wanted, columns]);
  const dropped = grouping.length !== wanted.length;
  const setGrouping = (next: string[]) => {
    setExpanded({});
    if (givenGrouping && onGroupingChange) {
      onGroupingChange(next);
    } else {
      setOwnGrouping(next);
    }
  };
  /** Adds the column at the end of the grouping, or takes it out. */
  const toggleGrouping = (id: string) => setGrouping(grouping.includes(id) ? grouping.filter((c) => c !== id) : [...grouping, id]);
  /** No more columns can be added to the grouping, and `id` isn't one of them. */
  const isFull = (id: string) => !grouping.includes(id) && grouping.length >= MAX_GROUPING;
  // The query tab's Rows grid nests up to three columns; other grids group by one.
  const nested = statistics;
  const reportDropped = useEffectEvent(() => onGroupingChange?.(grouping));
  useEffect(() => {
    if (dropped && givenGrouping) {
      reportDropped();
    }
  }, [dropped, givenGrouping]);
  // By row index in `rows`, whichever side keeps it.
  const owned = typeof selection === 'object' ? selection : undefined;
  const mode = selection === 'none' ? 'none' : (owned?.mode ?? 'multi');
  const selected = owned ? owned.selected : ownSelected;
  const setSelected = owned ? owned.onChange : setOwnSelected;

  const meta = useMemo(() => new Map(columns.map((c) => [c.name, c])), [columns]);
  const widths = useMemo(() => columnWidths(columns, rows, statistics), [columns, rows, statistics]);
  const defs = useMemo<ColumnDef<Features, Row>[]>(
    () =>
      columns.map((c, i) => ({
        id: c.name,
        header: c.name,
        accessorFn: (row) => row[i],
        sortFn: compareCells,
        sortUndefined: 'last',
        getGroupingValue: (row) => cellText(row[i]),
        filterFn: cellIs,
      })),
    [columns],
  );

  const table = useTable({
    features,
    data: rows,
    columns: defs,
    state: {
      sorting,
      globalFilter: filter,
      columnFilters: cellFilters,
      columnVisibility: visibility,
      columnOrder: order,
      grouping,
      expanded,
    },
    onSortingChange: setSorting,
    onGlobalFilterChange: setFilter,
    onColumnVisibilityChange: setVisibility,
    onColumnOrderChange: setOrder,
    onGroupingChange: (updater) => setGrouping(typeof updater === 'function' ? updater(grouping) : updater),
    onExpandedChange: setExpanded,
    globalFilterFn: rowContains,
    // The grouped column keeps its place rather than moving first.
    groupedColumnMode: false,
    // The first click sorts ascending for every type (TanStack would start numbers descending).
    sortDescFirst: false,
  });

  // TanStack memoizes the sorted row model, so this walks the rows only when the data, filter, sorting or grouping change.
  const sortedRows = table.getSortedRowModel().rows;
  const tree = useMemo(() => groupTree(sortedRows), [sortedRows]);
  // Opening a group changes only which rows are shown.
  const visible = useMemo(() => shownRows(tree, expanded), [tree, expanded]);
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

  const select = (row: TableRow<Features, Row>, e: MouseEvent) => {
    if (mode === 'none') {
      return;
    }
    if (mode === 'multi' && e.shiftKey && anchor !== null) {
      const from = shownLeaves.findIndex((r) => r.index === anchor);
      const to = shownLeaves.indexOf(row);
      if (from >= 0) {
        const [lo, hi] = from < to ? [from, to] : [to, from];
        setSelected(new Set(shownLeaves.slice(lo, hi + 1).map((r) => r.index)));
        return;
      }
    }
    if (mode === 'multi' && (e.ctrlKey || e.metaKey)) {
      toggle(row.index);
    } else {
      setSelected(new Set([row.index]));
    }
    setAnchor(row.index);
  };

  /** A row's checkbox, or Ctrl/⌘-click: in `multi` adds or removes the row, in `single` makes it the only one or clears it. */
  const toggle = (index: number) => {
    const next = new Set(mode === 'multi' ? selected : selected.has(index) ? [index] : []);
    if (!next.delete(index)) {
      next.add(index);
    }
    setSelected(next);
    setAnchor(index);
  };

  const onGridKey = (e: KeyboardEvent<HTMLDivElement>) => {
    // Keys on a cell's button are the button's.
    if (e.target !== e.currentTarget) {
      return;
    }
    const at = shownLeaves.findIndex((r) => r.index === anchor);
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && mode !== 'none') {
      const next = shownLeaves[at < 0 ? 0 : Math.min(Math.max(at + (e.key === 'ArrowDown' ? 1 : -1), 0), shownLeaves.length - 1)];
      if (next) {
        setSelected(new Set([next.index]));
        setAnchor(next.index);
        virtualizer.scrollToIndex(visible.indexOf(next));
      }
      e.preventDefault();
    } else if (e.key === 'Enter' && at >= 0) {
      onOpenRow?.(shownLeaves[at]?.index ?? 0);
      e.preventDefault();
    }
  };

  // Every row the filter lets through, in the order shown, and those of them that are selected. Selected rows the filter now
  // hides are neither counted nor copied; with none selected, every row shown is.
  const filteredLeaves = tree.leaves;
  const selectedShown = filteredLeaves.filter((r) => selected.has(r.index));
  const chosen = selectedShown.length > 0 ? selectedShown : filteredLeaves;
  const chosenLabel = selectedShown.length > 0 ? `${rowCount(selectedShown.length)} selected` : `All ${rowCount(filteredLeaves.length)}`;

  const copy = (format: CopyFormat, header: boolean) => {
    const shownColumns = visibleColumns.map((c) => meta.get(c.id)).filter((c): c is ResultColumn => !!c);
    const at = shownColumns.map((c) => columns.indexOf(c));
    const values = chosen.map((r) => at.map((i) => r.original[i]));
    const name = COPY_FORMATS.find((f) => f.format === format)?.name ?? format;
    copyText(formatRows(format, shownColumns, values, header)).then(
      () => setNotice({ tone: 'ok', text: `Copied ${rowCount(values.length)} as ${name}.` }),
      (e: unknown) => setNotice({ tone: 'bad', text: copyFailed(e) }),
    );
  };

  /** Opens a cell's smart filter menu at the pointer, kept inside the grid; a cell it offers nothing for keeps the browser's. */
  const openCellMenu = (e: MouseEvent, column: ResultColumn | undefined, value: unknown) => {
    const box = root.current?.getBoundingClientRect();
    if (!onFilter || !column || !box || filterOps(column, value).length === 0) {
      return;
    }
    e.preventDefault();
    setCellMenu({ column, value, x: e.clientX - box.left, y: e.clientY - box.top });
  };

  /** Opens a header's column menu under the header. */
  const openColumnMenu = (e: MouseEvent<HTMLButtonElement>, column: ResultColumn) => {
    const box = root.current?.getBoundingClientRect();
    const th = e.currentTarget.closest('th')?.getBoundingClientRect();
    if (!box || !th) {
      return;
    }
    columnMenuButton.current = e.currentTarget;
    setColumnMenu({ column, at: { x: th.left - box.left, y: th.bottom - box.top } });
  };

  const reportShown = useEffectEvent(() => onShownChange?.(filteredLeaves.map((r) => r.index)));
  // Only when the shown rows can have changed, not on every render.
  useEffect(() => reportShown(), [rows, filter, cellFilters, sorting, grouping]);

  const checkboxes = owned !== undefined;
  const span = visibleColumns.length + (checkboxes ? 2 : 1);
  const allShown = filteredLeaves.length > 0 && selectedShown.length === filteredLeaves.length;

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
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                data-keep-open
                aria-label={`Move ${id} earlier`}
                disabled={!neighbour(id, -1)}
                onClick={() => move(id, -1)}
              >
                ↑
              </button>
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                data-keep-open
                aria-label={`Move ${id} later`}
                disabled={!neighbour(id, 1)}
                onClick={() => move(id, 1)}
              >
                ↓
              </button>
            </div>
          ))}
          <button type="button" role="menuitem" tabIndex={-1} data-keep-open onClick={() => setVisibility({})}>
            Show all columns
          </button>
        </>
      </MenuButton>
      <MenuButton label="Group by" text={grouping.length > 0 ? `Group by: ${grouping.join(' › ')}` : undefined}>
        <>
          <button
            type="button"
            role={nested ? 'menuitem' : 'menuitemradio'}
            aria-checked={nested ? undefined : grouping.length === 0}
            tabIndex={-1}
            onClick={() => setGrouping([])}
          >
            <span aria-hidden="true" className="w-3 text-accent">
              {!nested && grouping.length === 0 ? '●' : ''}
            </span>
            No grouping
          </button>
          {ids.map((id) => {
            const on = grouping.includes(id);
            const full = nested && isFull(id);
            return (
              <button
                key={id}
                type="button"
                role={nested ? 'menuitemcheckbox' : 'menuitemradio'}
                aria-checked={on}
                tabIndex={-1}
                data-keep-open={nested || undefined}
                disabled={full}
                title={full ? `Up to ${MAX_GROUPING} columns` : undefined}
                onClick={() => (nested ? toggleGrouping(id) : setGrouping([id]))}
              >
                <span aria-hidden="true" className="w-3 text-accent">
                  {on ? (nested ? '✓' : '●') : ''}
                </span>
                <span className="mono">{id}</span>
              </button>
            );
          })}
        </>
      </MenuButton>
      {nested && grouping.length > 0 && (
        <span className="chip min-w-0">
          <span className="truncate">Grouped by {grouping.join(' › ')}</span>
          <button type="button" className="shrink-0 cursor-pointer" aria-label="Clear grouping" onClick={() => setGrouping([])}>
            ✕
          </button>
        </span>
      )}
      <MenuButton label="Copy as" primary>
        <>
          <span className="faint px-2.5 py-1 text-[11.5px]">{chosenLabel}</span>
          {[true, false].flatMap((header) =>
            COPY_FORMATS.map(({ format, name }) => (
              <button key={`${header}-${format}`} type="button" role="menuitem" tabIndex={-1} onClick={() => copy(format, header)}>
                {header ? 'Rows' : 'Cells'} as {name}
              </button>
            )),
          )}
        </>
      </MenuButton>
      <MenuButton label="Run tool">
        <>
          <span className="faint px-2.5 py-1 text-[11.5px]">{chosenLabel}</span>
          <ToolItems columns={columns} onChoose={setTool} onError={(text, reportId) => setNotice({ tone: 'bad', text, reportId })} />
        </>
      </MenuButton>
    </>
  );

  return (
    <div ref={root} className="relative flex min-h-0 flex-1 flex-col">
      {toolbar === undefined ? <div className="rbar justify-end">{tools}</div> : toolbar && createPortal(tools, toolbar)}
      <div
        ref={scroller}
        className="min-h-0 flex-1 overflow-auto"
        tabIndex={0}
        role="region"
        aria-label="Result rows"
        onKeyDown={onGridKey}
      >
        <table className="datagrid">
          <colgroup>
            {checkboxes && <col style={{ width: 30 }} />}
            <col style={{ width: 30 }} />
            {visibleColumns.map((c) => (
              <col key={c.id} style={{ width: widths.get(c.id) }} />
            ))}
          </colgroup>
          <thead>
            {table.getHeaderGroups().map((group) => (
              <tr key={group.id}>
                {checkboxes && (
                  <th scope="col" className="select-col">
                    {mode === 'multi' ? (
                      <input
                        type="checkbox"
                        aria-label="Select all rows"
                        checked={allShown}
                        ref={(el) => {
                          if (el) {
                            el.indeterminate = selectedShown.length > 0 && !allShown;
                          }
                        }}
                        onChange={() => setSelected(new Set(allShown ? [] : filteredLeaves.map((r) => r.index)))}
                      />
                    ) : (
                      <span className="sr-only">Select</span>
                    )}
                  </th>
                )}
                <th scope="col" className="inspect-col">
                  <span className="sr-only">Inspect</span>
                </th>
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
                      <div className="flex">
                        <button type="button" className="min-w-0 flex-1" onClick={header.column.getToggleSortingHandler()}>
                          {flexRender(header.column.columnDef.header, header.getContext())}
                          {sorted === 'asc' ? ' ↑' : sorted === 'desc' ? ' ↓' : ''}
                        </button>
                        {statistics && column && (
                          <button
                            type="button"
                            className="col-menu"
                            aria-label={`${column.name} column menu`}
                            aria-haspopup="menu"
                            aria-expanded={columnMenu?.column === column}
                            onClick={(e) => openColumnMenu(e, column)}
                          >
                            ⌄
                          </button>
                        )}
                      </div>
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {padTop > 0 && (
              <tr aria-hidden="true">
                <td style={{ height: padTop, padding: 0, border: 0 }} colSpan={span} />
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
                const column = meta.get(row.groupingColumnId ?? '');
                return (
                  <tr key={row.id} data-index={item.index} style={{ height: ROW_HEIGHT }}>
                    <td
                      colSpan={span}
                      className="bg-panel2"
                      style={{ paddingLeft: 12 + row.depth * 18 }}
                      // A group's own row is its first row: its value is the one the grouping value was made from.
                      onContextMenu={(e) => column && openCellMenu(e, column, row.original[columns.indexOf(column)])}
                    >
                      <button
                        type="button"
                        aria-expanded={open}
                        onClick={row.getToggleExpandedHandler()}
                        onKeyDown={(e) => {
                          if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
                            row.toggleExpanded(e.key === 'ArrowRight');
                            e.preventDefault();
                          }
                        }}
                      >
                        <span aria-hidden="true">{open ? '▾' : '▸'}</span> {row.groupingColumnId}: {value === '' ? 'null' : cellText(value)}{' '}
                        · {count(tree.size.get(row) ?? 0)}
                      </button>
                    </td>
                  </tr>
                );
              }
              const isSelected = selected.has(row.index);
              const isInspected = inspected === row.index;
              return (
                <tr
                  key={row.id}
                  data-index={item.index}
                  style={{ height: ROW_HEIGHT }}
                  className={[isSelected && 'sel', isInspected && 'inspected'].filter(Boolean).join(' ') || undefined}
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
                  {checkboxes && (
                    <td className="select-col">
                      <input
                        type="checkbox"
                        aria-label={`Select row ${count(row.index + 1)}`}
                        checked={isSelected}
                        onClick={(e) => e.stopPropagation()}
                        onChange={() => toggle(row.index)}
                      />
                    </td>
                  )}
                  <td className="inspect-col">
                    <button
                      type="button"
                      aria-label={`Inspect row ${count(row.index + 1)}`}
                      title="Inspect row"
                      aria-expanded={isInspected}
                      aria-controls={isInspected ? inspectorId : undefined}
                      onClick={(e) => {
                        // Not the row's click too: that would select (or, with checkboxes, toggle) the row.
                        e.stopPropagation();
                        onOpenRow?.(isInspected ? null : row.index);
                      }}
                    >
                      {inspectIcon}
                    </button>
                  </td>
                  {row.getVisibleCells().map((cell) => {
                    const column = meta.get(cell.column.id);
                    const value = cell.getValue();
                    const onContextMenu = (e: MouseEvent) => openCellMenu(e, column, value);
                    if (value === null || value === undefined) {
                      return (
                        <td key={cell.id} className="faint" onContextMenu={onContextMenu}>
                          null
                        </td>
                      );
                    }
                    if (isComplex(value)) {
                      const text = cellText(value);
                      return (
                        <td key={cell.id} onContextMenu={onContextMenu}>
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
                      <td key={cell.id} className={column && NUMERIC.has(column.type) ? 'num' : undefined} onContextMenu={onContextMenu}>
                        {cellText(value)}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
            {padBottom > 0 && (
              <tr aria-hidden="true">
                <td style={{ height: padBottom, padding: 0, border: 0 }} colSpan={span} />
              </tr>
            )}
          </tbody>
        </table>
        {rows.length === 0 && <p className="faint m-0 p-4 text-[12px]">The query returned no rows.</p>}
      </div>
      {notice && <NoticeLine notice={notice} onDismiss={() => setNotice(null)} />}
      {tool && <RunToolDialog tool={tool} columns={columns} rows={chosen.map((r) => r.original)} onClose={() => setTool(null)} />}
      {opened && <JsonPanel opened={opened} onClose={() => setOpened(null)} />}
      {cellMenu && onFilter && (
        <Menu
          label={`Filter on ${cellMenu.column.name}`}
          at={{ x: cellMenu.x, y: cellMenu.y }}
          onClose={(refocus) => {
            setCellMenu(null);
            if (refocus) {
              scroller.current?.focus();
            }
          }}
        >
          <FilterItems column={cellMenu.column} value={cellMenu.value} onFilter={onFilter} />
        </Menu>
      )}
      {columnMenu && (
        <Menu
          label={`${columnMenu.column.name} column`}
          at={columnMenu.at}
          onClose={(refocus) => {
            setColumnMenu(null);
            if (refocus) {
              columnMenuButton.current?.focus();
            }
          }}
        >
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            onClick={() => {
              const i = columns.indexOf(columnMenu.column);
              setStats({ ...columnMenu, opened: performance.now(), values: filteredLeaves.map((r) => r.original[i]) });
            }}
          >
            Column statistics
          </button>
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            disabled={isFull(columnMenu.column.name)}
            title={isFull(columnMenu.column.name) ? `Up to ${MAX_GROUPING} columns` : undefined}
            onClick={() => toggleGrouping(columnMenu.column.name)}
          >
            {grouping.includes(columnMenu.column.name) ? 'Stop grouping by this column' : 'Group by this column'}
          </button>
        </Menu>
      )}
      {stats && (
        <ColumnStatsPopover
          key={stats.opened}
          column={stats.column}
          values={stats.values}
          at={stats.at}
          onFilter={onFilter}
          onClose={(refocus) => {
            setStats(null);
            if (refocus) {
              columnMenuButton.current?.focus();
            }
          }}
        />
      )}
    </div>
  );
}

function JsonPanel({ opened, onClose }: { opened: Opened; onClose: () => void }) {
  return (
    <div
      role="dialog"
      aria-label={opened.column}
      className="sheet absolute top-0 right-0 bottom-0 z-[2] flex w-[420px] max-w-full flex-col border-l border-line shadow-[0_18px_40px_rgba(0,0,0,0.45)]"
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
