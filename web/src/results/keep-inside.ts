/** Positions `el` at `at` in its parent, moved left and up as needed to stay inside; `capHeight` also caps its height to the parent's. */
export function keepInside(el: HTMLElement, at: { x: number; y: number }, opts?: { capHeight?: boolean }): void {
  const parent = el.parentElement;
  if (!parent) {
    return;
  }
  if (opts?.capHeight) {
    el.style.maxHeight = `${parent.clientHeight}px`;
  }
  el.style.left = `${Math.max(0, Math.min(at.x, parent.clientWidth - el.offsetWidth))}px`;
  el.style.top = `${Math.max(0, Math.min(at.y, parent.clientHeight - el.offsetHeight))}px`;
}
