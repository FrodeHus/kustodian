import type { KeyboardEvent, PointerEvent } from 'react';

interface SplitterProps {
  /** 'vertical' sizes the pane to its left by width; 'horizontal' the pane above it by height. */
  orientation: 'vertical' | 'horizontal';
  label: string;
  /** The pane's size in px, or null while it keeps its stylesheet size. */
  size: number | null;
  onSize: (px: number) => void;
  min: number;
  /** Space kept for the panes after it, so the parent's size less this is the most the pane grows to. */
  reserve: number;
}

const STEP = 16;

/** A drag handle (or arrow keys) between two panes, sizing the visible pane before it (ARIA window splitter). */
export function Splitter({ orientation, label, size, onSize, min, reserve }: SplitterProps) {
  const vertical = orientation === 'vertical';
  const bounds = (el: HTMLElement) => {
    let pane = el.previousElementSibling as HTMLElement | null;
    while (pane?.hidden) pane = pane.previousElementSibling as HTMLElement | null;
    const rect = pane?.getBoundingClientRect();
    const parent = el.parentElement?.getBoundingClientRect();
    const start = size ?? (vertical ? rect?.width : rect?.height) ?? min;
    const max = Math.max(min, (vertical ? parent?.width : parent?.height) ?? start) - reserve;
    return { start, clamp: (px: number) => Math.round(Math.min(Math.max(px, min), Math.max(min, max))) };
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget;
    const { start, clamp } = bounds(el);
    const origin = vertical ? e.clientX : e.clientY;
    el.setPointerCapture(e.pointerId);
    const move = (m: globalThis.PointerEvent) => onSize(clamp(start + (vertical ? m.clientX : m.clientY) - origin));
    const end = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', end);
      el.removeEventListener('pointercancel', end);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const back = vertical ? 'ArrowLeft' : 'ArrowUp';
    const forward = vertical ? 'ArrowRight' : 'ArrowDown';
    if (e.key !== back && e.key !== forward) return;
    e.preventDefault();
    const { start, clamp } = bounds(e.currentTarget);
    onSize(clamp(start + (e.key === forward ? STEP : -STEP)));
  };

  return (
    // A focusable separator is the ARIA window splitter widget, so it takes focus and arrow keys.
    <div
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-orientation={orientation}
      aria-valuenow={size ?? undefined}
      aria-valuemin={min}
      className={`splitter ${vertical ? 'splitter-v' : 'splitter-h'}`}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
    />
  );
}
