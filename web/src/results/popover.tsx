import { useEffect, useEffectEvent, useLayoutEffect, useRef, type ReactNode } from 'react';
import { keepInside } from './keep-inside';

/**
 * A popover dialog at a point in its parent, kept inside it (as `Menu` does with `at`), focused when it opens. Esc closes it
 * with `true`, for focus to go back; a mousedown outside with `false`.
 */
export function Popover({
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
