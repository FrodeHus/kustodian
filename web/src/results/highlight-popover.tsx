import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { HighlightRule, ResultColumn } from '../wire';
import { ColourTarget, HighlightList } from './highlight-list';
import { ruleFromCell } from './highlights';
import { keepInside } from './keep-inside';
import { quotedValue } from './smart-filter';

/** A dialog at a point in its parent, kept inside it, as the column statistics are: Esc closes it with `true`, for focus to go
 * back; a mousedown outside with `false`. */
function Popover({
  label,
  at,
  className,
  onClose,
  children,
}: {
  label: string;
  at?: { x: number; y: number };
  className: string;
  onClose: (refocus: boolean) => void;
  children: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (at && box.current) {
      keepInside(box.current, at, { capHeight: true });
    }
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
      aria-label={label}
      tabIndex={-1}
      className={`menu max-w-full gap-2 overflow-y-auto p-3 text-[12px] outline-none ${className}`}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onClose(true);
        }
      }}
    >
      {children}
    </div>
  );
}

/** "Highlight rows where …": the rule a cell prefills, with its colour and row or cell to pick, then Add. */
export function HighlightFromCell({
  column,
  value,
  at,
  onAdd,
  onClose,
}: {
  column: ResultColumn;
  value: unknown;
  at?: { x: number; y: number };
  onAdd: (rule: HighlightRule) => void;
  onClose: (refocus: boolean) => void;
}) {
  const [rule, setRule] = useState(() => ruleFromCell(column, value));
  const text = rule.op === 'isempty' ? `${column.name} isempty` : `${column.name} == ${quotedValue(column, value)}`;
  return (
    <Popover label={`Highlight rows where ${text}`} at={at} className="w-[300px]" onClose={onClose}>
      <div>
        Highlight rows where <b className="mono">{text}</b>
      </div>
      <div className="flex items-center gap-1.5">
        <ColourTarget rule={rule} onChange={(patch) => setRule({ ...rule, ...patch })} />
        <div className="grow" />
        <button type="button" className="btn" onClick={() => onAdd(rule)}>
          Add
        </button>
      </div>
    </Popover>
  );
}

/** The rule list in a popover: `Highlight rules`. */
export function HighlightListPopover({
  at,
  onClose,
  ...list
}: {
  rules: HighlightRule[];
  columns: ResultColumn[];
  onChange: (rules: HighlightRule[]) => void;
  at?: { x: number; y: number };
  onClose: (refocus: boolean) => void;
}) {
  return (
    <Popover label="Highlight rules" at={at} className="w-[640px]" onClose={onClose}>
      <b>Highlight rules</b>
      <HighlightList {...list} />
    </Popover>
  );
}
