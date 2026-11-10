import {
  columnFilteringFeature,
  columnGroupingFeature,
  columnOrderingFeature,
  columnVisibilityFeature,
  createExpandedRowModel,
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
import {
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { ErrorReportActions } from '../shell/error-report';
import type { ExternalTool, ResultColumn } from '../wire';
import { COPY_FORMATS, copyFailed, copyText, formatRows, type CopyFormat } from './copy';
import { cellText, type Row } from './export';
import type { CellMatch } from './chart-shape';
import { RunToolDialog, ToolItems } from './run-tool';
import { filterOps, shownValue, type FilterOp } from './smart-filter';

const ROW_HEIGHT = 29;
// One empty list, so a grid with no cell filters doesn't hand the table a new state each render.
const NO_FILTERS: CellMatch[] = [];
const NUMERIC = new Set(['int', 'long', 'real', 'decimal', 'double']);
// Approximate pixels per character of the cell font (12px JetBrains Mono) and of the header, plus a cell's side padding.
const CHAR_PX = 7.3;
const HEADER_CHAR_PX = 7.6;
const CELL_PAD = 24 + 16;
const MAX_COL_PX = 480;
// shortcut: widths come from the first rows only; a longer value further down is cut with an ellipsis. Scan more if that bites.
const WIDTH_SAMPLE = 2000;

/** A fixed width per column, from its header and its longest value, so scrolling never resizes columns. */
function columnWidths(columns: ResultColumn[], rows: Row[]): Map<string, number> {
  const sample = rows.slice(0, WIDTH_SAMPLE);
  return new Map(
    columns.map((c, i) => {
      const longest = sample.reduce((n, row) => Math.max(n, row[i] === null || row[i] === undefined ? 4 : cellText(row[i]).length), 0);
      return [c.name, Math.min(MAX_COL_PX, Math.ceil(Math.max(longest * CHAR_PX, c.name.length * HEADER_CHAR_PX) + CELL_PAD))];
    }),
  );
}

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
  expandedRowModel: createExpandedRowModel(),
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

/** The leaf rows under `rows` in the order shown, groups opened or not. */
function leaves(rows: TableRow<Features, Row>[]): TableRow<Features, Row>[] {
  return rows.flatMap((r) => (r.getIsGrouped() ? leaves(r.subRows) : [r]));
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

/**
 * A menu: focus starts on the first item; the arrow keys, Home and End move between items. Choosing an item (unless it has
 * `data-keep-open`) or pressing Esc calls `onClose(true)`, for focus to go back; a mousedown outside `within` (the menu itself
 * when not given), or Tab, calls `onClose(false)` and leaves focus where it went.
 *
 * It never closes on blur: macOS WKWebView doesn't focus a button on mousedown, so focus leaves the menu before the click on an
 * item lands. Items also keep focus from moving on mousedown.
 */
export function Menu({
  label,
  style,
  within,
  onClose,
  children,
}: {
  label: string;
  style: CSSProperties;
  within?: RefObject<HTMLElement | null>;
  onClose: (refocus: boolean) => void;
  /** The menu's items: buttons with a `menuitem…` role and `tabIndex={-1}`. */
  children: ReactNode;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const items = () => [...(menu.current?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)') ?? [])];
  const dismiss = useEffectEvent(() => onClose(false));
  const area = within ?? menu;

  useEffect(() => {
    items()[0]?.focus();
    const onDown = (e: globalThis.MouseEvent) => {
      if (!(e.target instanceof Node) || !area.current?.contains(e.target)) {
        dismiss();
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [area]);

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
        // The menu's, not a sheet's or dialog's around it.
        e.stopPropagation();
        onClose(true);
        break;
      case 'Tab':
        onClose(false);
        return;
      default:
        return;
    }
    e.preventDefault();
  };

  return (
    <div
      ref={menu}
      className="menu"
      role="menu"
      aria-label={label}
      style={{ minWidth: 200, maxHeight: 360, overflowY: 'auto', ...style }}
      onKeyDown={onKey}
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => {
        // After the item's own click: it has done its work.
        const item = e.target instanceof Element ? e.target.closest('[role^="menuitem"]') : null;
        if (item && !item.hasAttribute('data-keep-open')) {
          onClose(true);
        }
      }}
    >
      {children}
    </div>
  );
}

/** A button that opens a {@link Menu} under it. */
export function MenuButton({
  label,
  text,
  icon,
  primary = false,
  field = false,
  children,
}: {
  /** The menu's name, and the button's unless `text` is given. */
  label: string;
  text?: string;
  /** Shown on the button in place of `label`, which still names it. */
  icon?: ReactNode;
  primary?: boolean;
  /** Looks like a form field (a workbook parameter's picker): the menu opens under its left edge. */
  field?: boolean;
  /** The menu's items: buttons with a `menuitem…` role and `tabIndex={-1}`. */
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        ref={trigger}
        type="button"
        className={field ? 'textbox param-pick' : `whitespace-nowrap ${primary ? 'btn' : 'btn ghost'}`}
        aria-label={field || !text ? label : undefined}
        title={field ? text : undefined}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {field ? <span className="truncate">{text}</span> : (icon ?? text ?? label)}
        {(primary || field) && <span aria-hidden="true"> ▾</span>}
      </button>
      {open && (
        <Menu
          label={label}
          style={{ ...(field ? { left: 0 } : { right: 0 }), top: 32 }}
          within={ref}
          onClose={(refocus) => {
            setOpen(false);
            if (refocus) {
              trigger.current?.focus();
            }
          }}
        >
          {children}
        </Menu>
      )}
    </div>
  );
}

const FILTER_VERB: Record<FilterOp, string> = { eq: 'Filter by', ne: 'Exclude', ge: 'On or after', lt: 'Before' };

/** Called with the cell a smart filter item was chosen for. */
export type OnFilter = (column: ResultColumn, value: unknown, op: FilterOp) => void;

/** The smart filter's menu items for a cell (none when it offers nothing): a string's value in quotes. */
export function FilterItems({ column, value, onFilter }: { column: ResultColumn; value: unknown; onFilter: OnFilter }) {
  const quoted = (column.type === 'string' || column.type === 'dynamic') && value !== null && value !== undefined && value !== '';
  const shown = quoted ? `"${shownValue(value)}"` : shownValue(value);
  return filterOps(column, value).map((op) => (
    <button key={op} type="button" role="menuitem" tabIndex={-1} onClick={() => onFilter(column, value, op)}>
      {FILTER_VERB[op]} {shown}
    </button>
  ));
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
}

/** A cell's context menu: the cell, and where it opens in the grid. */
interface CellMenu {
  column: ResultColumn;
  value: unknown;
  left: number;
  top: number;
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
 * The Rows tab (spec 6.5): a virtualized grid with sort, a row filter, hidden and reordered columns, grouping by a column,
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
}: GridProps) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [filter, setFilter] = useState('');
  const [opened, setOpened] = useState<Opened | null>(null);
  const [visibility, setVisibility] = useState<ColumnVisibilityState>({});
  const [order, setOrder] = useState<string[]>([]);
  const [grouping, setGrouping] = useState<string[]>([]);
  const [expanded, setExpanded] = useState<ExpandedState>({});
  const [ownSelected, setOwnSelected] = useState<ReadonlySet<number>>(new Set());
  const [anchor, setAnchor] = useState<number | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [tool, setTool] = useState<ExternalTool | null>(null);
  const [cellMenu, setCellMenu] = useState<CellMenu | null>(null);
  const root = useRef<HTMLDivElement>(null);
  // A new result's rows start with nothing selected.
  const [rowsSeen, setRowsSeen] = useState(rows);
  if (rowsSeen !== rows) {
    setRowsSeen(rows);
    setOwnSelected(new Set());
    setAnchor(null);
  }
  const scroller = useRef<HTMLDivElement>(null);
  // By row index in `rows`, whichever side keeps it.
  const owned = typeof selection === 'object' ? selection : undefined;
  const mode = selection === 'none' ? 'none' : (owned?.mode ?? 'multi');
  const selected = owned ? owned.selected : ownSelected;
  const setSelected = owned ? owned.onChange : setOwnSelected;

  const meta = useMemo(() => new Map(columns.map((c) => [c.name, c])), [columns]);
  const widths = useMemo(() => columnWidths(columns, rows), [columns, rows]);
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
    onGroupingChange: setGrouping,
    onExpandedChange: setExpanded,
    globalFilterFn: rowContains,
    // The grouped column keeps its place rather than moving first.
    groupedColumnMode: false,
    // The first click sorts ascending for every type (TanStack would start numbers descending).
    sortDescFirst: false,
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
  const filteredLeaves = leaves(table.getSortedRowModel().rows);
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

  const groupedBy = grouping[0];

  /** Opens a cell's smart filter menu at the pointer, kept inside the grid; a cell it offers nothing for keeps the browser's. */
  const openCellMenu = (e: MouseEvent, column: ResultColumn | undefined, value: unknown) => {
    const box = root.current?.getBoundingClientRect();
    if (!onFilter || !column || !box || filterOps(column, value).length === 0) {
      return;
    }
    e.preventDefault();
    setCellMenu({
      column,
      value,
      // About a menu's size: 220 wide, at most four items high.
      left: Math.max(0, Math.min(e.clientX - box.left, box.width - 220)),
      top: Math.max(0, Math.min(e.clientY - box.top, box.height - 160)),
    });
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
                return (
                  <tr key={row.id} data-index={item.index} style={{ height: ROW_HEIGHT }}>
                    <td colSpan={span} className="bg-panel2">
                      <button type="button" aria-expanded={open} onClick={row.getToggleExpandedHandler()}>
                        {open ? '▾' : '▸'} {row.groupingColumnId}: {value === '' ? 'null' : cellText(value)} ·{' '}
                        {count(row.getLeafRows().length)}
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
          style={{ left: cellMenu.left, top: cellMenu.top }}
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
