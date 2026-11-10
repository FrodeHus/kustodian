import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import type { ResultColumn } from '../wire';
import { keepInside } from './keep-inside';
import { filterOps, shownValue, type FilterOp } from './smart-filter';

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
  at,
  within,
  onClose,
  children,
}: {
  label: string;
  style?: CSSProperties;
  /** A point in the menu's parent to open at, moved left and up by the menu's measured size to stay inside the parent. */
  at?: { x: number; y: number };
  within?: RefObject<HTMLElement | null>;
  onClose: (refocus: boolean) => void;
  /** The menu's items: buttons with a `menuitem…` role and `tabIndex={-1}`. */
  children: ReactNode;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const items = () => [...(menu.current?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)') ?? [])];
  const dismiss = useEffectEvent(() => onClose(false));
  const area = within ?? menu;

  // Before paint, on every render: the items (and so the size) can change while it is open.
  useLayoutEffect(() => {
    if (at && menu.current) {
      keepInside(menu.current, at);
    }
  });

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
  above = false,
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
  /** Opens above the button instead of under it, for a button near the bottom of a clipped area. */
  above?: boolean;
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
          style={{ ...(field ? { left: 0 } : { right: 0 }), ...(above ? { bottom: 32 } : { top: 32 }) }}
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
    <button key={op} type="button" role="menuitem" tabIndex={-1} className="whitespace-nowrap" onClick={() => onFilter(column, value, op)}>
      {FILTER_VERB[op]} {shown}
    </button>
  ));
}
