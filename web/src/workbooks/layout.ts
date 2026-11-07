import { MIN_SIZE } from './model';
import type { Widget, WidgetLayout } from './model';

export const COLUMNS = 12;
export const ROW_PX = 8;
export const GAP_PX = 12;
export const NARROW_PX = 900;

export function overlaps(a: WidgetLayout, b: WidgetLayout): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

const byRow = (a: Widget, b: Widget) => a.layout.y - b.layout.y || a.layout.x - b.layout.x;

/** Lowest y at which `l` clears everything in `placed`: the best spot is row 0 or just under some placed widget. */
function lowestFit(placed: Widget[], l: WidgetLayout): number {
  const candidates = [0, ...placed.map((p) => p.layout.y + p.layout.h)].sort((a, b) => a - b);
  return candidates.find((y) => !placed.some((p) => overlaps(p.layout, { ...l, y }))) ?? 0;
}

/** Packs the pinned widget (if any) where it is, then the rest in (y, x) order as high as they go. Keeps input order. */
function pack(widgets: Widget[], pinnedId?: string): Widget[] {
  const copies = widgets.map((w) => ({ ...w, layout: { ...w.layout } }));
  const pinned = copies.filter((w) => w.id === pinnedId);
  const placed = [...pinned];
  for (const w of copies.filter((c) => c.id !== pinnedId).sort(byRow)) {
    w.layout.y = lowestFit(placed, w.layout);
    placed.push(w);
  }
  return copies;
}

/** Moves every widget up as far as it goes without overlapping, in (y, x) order; overlapping input is pushed down first. */
export function compact(widgets: Widget[]): Widget[] {
  return pack(widgets);
}

function withLayout(widgets: Widget[], id: string, layout: (l: WidgetLayout) => WidgetLayout): Widget[] {
  const set = widgets.map((w) => (w.id === id ? { ...w, layout: layout(w.layout) } : w));
  // Others flow around the changed widget, then the whole grid settles.
  return pack(pack(set, id));
}

export function move(widgets: Widget[], id: string, x: number, y: number): Widget[] {
  return withLayout(widgets, id, (l) => ({
    ...l,
    x: Math.min(COLUMNS - l.w, Math.max(0, Math.round(x))),
    y: Math.max(0, Math.round(y)),
  }));
}

/** A move by `dx` columns and `dy` rows, as an arrow key makes it. Down past a widget right below jumps by that widget's height:
 * a one-row step would only be packed back above it, so the widget could never get past. */
export function nudge(widgets: Widget[], id: string, dx: number, dy: number): Widget[] {
  const l = widgets.find((w) => w.id === id)?.layout;
  if (!l) {
    return widgets;
  }
  const target = { ...l, x: l.x + dx, y: l.y + dy };
  const below = dy > 0 ? widgets.filter((w) => w.id !== id && w.layout.y > l.y && overlaps(w.layout, target)).sort(byRow)[0] : undefined;
  return move(widgets, id, target.x, below ? Math.max(target.y, l.y + below.layout.h) : target.y);
}

export function resize(widgets: Widget[], id: string, w: number, h: number): Widget[] {
  const type = widgets.find((i) => i.id === id)?.type;
  if (!type) {
    return widgets;
  }
  const min = MIN_SIZE[type];
  return withLayout(widgets, id, (l) => {
    const width = Math.min(COLUMNS, Math.max(min.w, Math.round(w)));
    return { x: Math.min(l.x, COLUMNS - width), y: l.y, w: width, h: Math.max(min.h, Math.round(h)) };
  });
}

/** Where a new w × h widget goes: the first free spot scanning rows top-down, else below everything. */
export function place(widgets: Widget[], w: number, h: number): WidgetLayout {
  const bottom = Math.max(0, ...widgets.map((i) => i.layout.y + i.layout.h));
  for (let y = 0; y < bottom; y++) {
    for (let x = 0; x <= COLUMNS - w; x++) {
      if (!widgets.some((i) => overlaps(i.layout, { x, y, w, h }))) {
        return { x, y, w, h };
      }
    }
  }
  return { x: 0, y: bottom, w, h };
}

export function narrowOrder(widgets: Widget[]): Widget[] {
  return [...widgets].sort(byRow);
}
