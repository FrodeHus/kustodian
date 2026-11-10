import { useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ResultColumn } from '../wire';
import { CHUNKED_ABOVE, columnStats, columnStatsChunked, type ColumnStats } from './column-stats';
import { FilterItems, MenuButton, type OnFilter } from './result-grid';
import { shownValue } from './smart-filter';

const count = (n: number) => n.toLocaleString('en-US');
const percent = (share: number) => share.toLocaleString('en-US', { style: 'percent', maximumFractionDigits: 1 });

function Figure({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="faint">{term}</dt>
      <dd className="mono m-0 truncate">{children}</dd>
    </div>
  );
}

/**
 * A column's statistics (spec 5): counts, top values with their smart filter items, and the range, from `values` (the rows
 * the grid shows). Many values are counted in chunks, so the page stays responsive. Esc or a mousedown outside closes it.
 */
export function ColumnStatsPopover({
  column,
  values,
  at,
  onFilter,
  onClose,
  chunkedAbove = CHUNKED_ABOVE,
}: {
  column: ResultColumn;
  values: unknown[];
  /** A point in the popover's parent to open at, kept inside the parent. */
  at?: { x: number; y: number };
  onFilter?: OnFilter;
  /** Esc closes it with `true`, for focus to go back; a mousedown outside with `false`. */
  onClose: (refocus: boolean) => void;
  chunkedAbove?: number;
}) {
  const box = useRef<HTMLDivElement>(null);
  const chunked = values.length > chunkedAbove;
  const now = useMemo(() => (chunked ? null : columnStats(column, values)), [chunked, column, values]);
  const [later, setLater] = useState<ColumnStats | null>(null);
  const stats = now ?? later;

  useEffect(() => {
    if (!chunked) {
      return;
    }
    const abort = new AbortController();
    void columnStatsChunked(column, values, abort.signal).then((s) => s && setLater(s));
    return () => abort.abort();
  }, [chunked, column, values]);

  // Kept inside the grid, as `Menu` does with `at`.
  useLayoutEffect(() => {
    const el = box.current;
    const parent = el?.parentElement;
    if (!at || !el || !parent) {
      return;
    }
    el.style.maxHeight = `${parent.clientHeight}px`;
    el.style.left = `${Math.max(0, Math.min(at.x, parent.clientWidth - el.offsetWidth))}px`;
    el.style.top = `${Math.max(0, Math.min(at.y, parent.clientHeight - el.offsetHeight))}px`;
  });

  const dismiss = useEffectEvent(() => onClose(false));
  useEffect(() => {
    box.current?.focus();
    const onDown = (e: MouseEvent) => {
      if (!(e.target instanceof Node) || !box.current?.contains(e.target)) {
        dismiss();
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  return (
    <div
      ref={box}
      role="dialog"
      aria-label={`${column.name} statistics`}
      tabIndex={-1}
      className="menu w-[320px] max-w-full gap-2 p-3 text-[12px] overflow-y-auto outline-none"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onClose(true);
        }
      }}
    >
      <div>
        <b className="mono text-[12.5px]">{column.name}</b> statistics
      </div>
      {!stats ? (
        <span className="faint">Counting…</span>
      ) : (
        <>
          <span className="faint">{`Of ${count(stats.rows)} rows shown`}</span>
          <dl className="m-0 flex flex-col gap-0.5">
            <Figure term="Rows">{count(stats.rows)}</Figure>
            <Figure term="Distinct">{count(stats.distinct)}</Figure>
            <Figure term="Empty">{count(stats.empty)}</Figure>
          </dl>
          {stats.top.length > 0 && (
            <>
              <b className="faint">Top values</b>
              <ul className="m-0 flex list-none flex-col gap-1 p-0">
                {stats.top.map((t, i) => (
                  <li key={JSON.stringify(t.value)} className="flex flex-col gap-0.5">
                    <div className="flex items-center gap-2">
                      <span className="mono min-w-0 flex-1 truncate">{shownValue(t.value)}</span>
                      <span className="mono">{count(t.count)}</span>
                      <span className="faint w-11 text-right">{percent(t.share)}</span>
                      {onFilter && (
                        <MenuButton label={`Filter on ${shownValue(t.value)}`} icon="Filter…" above={i >= stats.top.length / 2}>
                          <FilterItems column={column} value={t.value} onFilter={onFilter} />
                        </MenuButton>
                      )}
                    </div>
                    <div className="h-1 rounded bg-raise" aria-hidden="true">
                      <div className="h-full rounded bg-accent" style={{ width: `${t.share * 100}%` }} />
                    </div>
                  </li>
                ))}
              </ul>
              {stats.more > 0 && <span className="faint">{`${count(stats.more)} more`}</span>}
            </>
          )}
          {(stats.min !== undefined || stats.earliest !== undefined) && (
            <dl className="m-0 flex flex-col gap-0.5">
              {stats.min !== undefined && <Figure term="Min">{count(stats.min)}</Figure>}
              {stats.max !== undefined && <Figure term="Max">{count(stats.max)}</Figure>}
              {stats.average !== undefined && <Figure term="Average">{count(stats.average)}</Figure>}
              {stats.earliest !== undefined && <Figure term="Earliest">{stats.earliest}</Figure>}
              {stats.latest !== undefined && <Figure term="Latest">{stats.latest}</Figure>}
            </dl>
          )}
        </>
      )}
    </div>
  );
}
