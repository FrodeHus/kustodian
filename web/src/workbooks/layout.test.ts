import { describe, expect, it } from 'vitest';
import { compact, move, narrowOrder, overlaps, place, resize } from './layout';
import type { Widget, WidgetType } from './model';

const w = (id: string, x: number, y: number, ww: number, h: number, type: WidgetType = 'table'): Widget => ({
  id,
  type,
  title: '',
  layout: { x, y, w: ww, h },
  parameters: {},
});
const byId = (list: Widget[], id: string) => list.find((i) => i.id === id)!.layout;
const anyOverlap = (list: Widget[]) =>
  list.some((a, i) => list.slice(i + 1).some((b) => overlaps(a.layout, b.layout)));

describe('layout', () => {
  it('overlaps is false for touching edges', () => {
    expect(overlaps({ x: 0, y: 0, w: 4, h: 4 }, { x: 4, y: 0, w: 4, h: 4 })).toBe(false);
    expect(overlaps({ x: 0, y: 0, w: 4, h: 4 }, { x: 3, y: 3, w: 4, h: 4 })).toBe(true);
  });

  it('compact separates overlapping widgets and keeps their order', () => {
    const out = compact([w('a', 0, 0, 6, 8), w('b', 2, 2, 6, 8)]);
    expect(anyOverlap(out)).toBe(false);
    expect(byId(out, 'b').y).toBeGreaterThan(byId(out, 'a').y);
  });

  it('compact closes a gap above a widget', () => {
    expect(byId(compact([w('a', 0, 5, 4, 8)]), 'a').y).toBe(0);
  });

  it('compact does not mutate its input', () => {
    const input = [w('a', 0, 5, 4, 8)];
    compact(input);
    expect(input[0]?.layout.y).toBe(5);
  });

  it('move clamps x to the grid', () => {
    expect(byId(move([w('a', 0, 0, 4, 8)], 'a', 11, 0), 'a').x).toBe(8);
  });

  it('move onto another pushes it down', () => {
    const out = move([w('a', 0, 0, 6, 8), w('b', 6, 0, 6, 8)], 'b', 0, 0);
    expect(byId(out, 'b')).toMatchObject({ x: 0, y: 0 });
    expect(byId(out, 'a').y).toBe(8);
  });

  it('resize clamps to the minimum size', () => {
    expect(byId(resize([w('a', 0, 0, 6, 20, 'chart')], 'a', 1, 1), 'a')).toMatchObject({ w: 3, h: 12 });
  });

  it('resize clamps to the grid and keeps others apart', () => {
    const out = resize([w('a', 8, 0, 4, 8), w('b', 0, 8, 4, 8)], 'a', 20, 10);
    expect(byId(out, 'a')).toMatchObject({ x: 0, w: 12, h: 10 });
    expect(anyOverlap(out)).toBe(false);
  });

  it('place finds the hole beside a wide widget', () => {
    expect(place([w('a', 0, 0, 8, 8)], 4, 8)).toEqual({ x: 8, y: 0, w: 4, h: 8 });
  });

  it('place goes below everything when nothing fits', () => {
    expect(place([w('a', 0, 0, 12, 8)], 4, 6)).toEqual({ x: 0, y: 8, w: 4, h: 6 });
    expect(place([], 4, 6)).toEqual({ x: 0, y: 0, w: 4, h: 6 });
  });

  it('narrowOrder sorts by y then x', () => {
    const out = narrowOrder([w('c', 0, 8, 4, 4), w('b', 6, 0, 4, 4), w('a', 0, 0, 4, 4)]);
    expect(out.map((i) => i.id)).toEqual(['a', 'b', 'c']);
  });
});
