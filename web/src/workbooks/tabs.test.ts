import { describe, expect, it } from 'vitest';
import { MAX_WIDGETS, newWidget } from './model';
import type { Widget } from './model';
import {
  addTab,
  childrenOf,
  deleteTab,
  destinations,
  duplicateWidget,
  moveTab,
  moveTo,
  placeKey,
  placeOf,
  removeTabs,
  renameTab,
  reorderTab,
  siblings,
  withinPlace,
} from './tabs';

const w = (id: string, y: number, over: Partial<Widget> = {}): Widget => ({
  ...newWidget('markdown', { x: 0, y, w: 6, h: 4 }),
  id,
  ...over,
});
const tabsW = (id: string, names: string[], title = ''): Widget => ({
  ...newWidget('tabs', { x: 0, y: 0, w: 12, h: 8 }),
  id,
  title,
  tabs: names.map((name, i) => ({ id: `t${i + 1}`, name })),
});
const inTab = (id: string, tab: string, y = 0, over: Partial<Widget> = {}) => w(id, y, { in: { tabs: 'T', tab }, ...over });
const ids = (l: Widget[]) => l.map((i) => i.id);

describe('places', () => {
  it('placeOf and placeKey', () => {
    expect(placeOf(w('a', 0))).toBeNull();
    expect(placeKey(null)).toBe('');
    expect(placeKey({ tabs: 'T', tab: 't1' })).toBe('T/t1');
  });
  it('siblings, childrenOf and withinPlace', () => {
    const l = [tabsW('T', ['A', 'B']), w('a', 10), inTab('x', 't1'), inTab('y', 't2')];
    expect(ids(siblings(l, null))).toEqual(['T', 'a']);
    expect(ids(siblings(l, { tabs: 'T', tab: 't1' }))).toEqual(['x']);
    expect(ids(childrenOf(l, 'T'))).toEqual(['x', 'y']);
    expect(ids(childrenOf(l, 'T', 't2'))).toEqual(['y']);
    const out = withinPlace(l, { tabs: 'T', tab: 't1' }, (s) => s.map((i) => ({ ...i, title: 'z' })));
    expect(out.map((i) => i.title)).toEqual(['', '', 'z', '']);
  });
});

describe('moveTo', () => {
  const base = () => [tabsW('T', ['A', 'B']), w('a', 10), inTab('x', 't1', 0, { history: { mode: 'values', interval: 'run', retentionDays: 30, keys: [], keep: [], since: 'previous' } }), inTab('y', 't2')];
  it('keeps the id and history, lands at the bottom, and empties the source', () => {
    const out = moveTo(base(), 'x', { tabs: 'T', tab: 't2' });
    const x = out.find((i) => i.id === 'x')!;
    expect(x.in).toEqual({ tabs: 'T', tab: 't2' });
    expect(x.layout.y).toBe(4);
    expect(x.history).toBeDefined();
    expect(childrenOf(out, 'T', 't1')).toEqual([]);
    expect(out).toHaveLength(4);
  });
  it('to the top level drops in, clamps w', () => {
    const l = base();
    l[2] = { ...l[2]!, layout: { x: 0, y: 0, w: 20, h: 4 } };
    const x = moveTo(l, 'x', null).find((i) => i.id === 'x')!;
    expect(x.in).toBeUndefined();
    expect(x.layout.w).toBe(12);
    expect(x.layout.y).toBe(14);
  });
  it('with at reflows the destination and compacts the source', () => {
    const l = [tabsW('T', ['A', 'B']), inTab('s1', 't1', 0), inTab('s2', 't1', 4), inTab('d', 't2', 0)];
    const out = moveTo(l, 's1', { tabs: 'T', tab: 't2' }, { x: 0, y: 0 });
    expect(out.find((i) => i.id === 's1')!.layout.y).toBe(0);
    expect(out.find((i) => i.id === 'd')!.layout.y).toBe(4);
    expect(out.find((i) => i.id === 's2')!.layout.y).toBe(0);
  });
  it('refuses a tabs widget and a missing tab', () => {
    const l = base();
    expect(moveTo(l, 'T', null)).toBe(l);
    expect(moveTo(l, 'a', { tabs: 'T', tab: 'nope' })).toBe(l);
  });
});

describe('tab edits', () => {
  it('addTab names and appends', () => {
    const r = addTab([tabsW('T', ['A'])], 'T');
    expect(r.tab.name).toBe('Tab 2');
    expect(r.widgets[0]!.tabs).toHaveLength(2);
    expect(addTab([tabsW('T', ['A'])], 'T', 'X').tab.name).toBe('X');
  });
  it('renameTab cuts to 40 and ignores empty', () => {
    const l = [tabsW('T', ['A'])];
    expect(renameTab(l, 'T', 't1', '  ' + 'x'.repeat(50))[0]!.tabs![0]!.name).toBe('x'.repeat(40));
    expect(renameTab(l, 'T', 't1', '   ')).toBe(l);
  });
  it('moveTab and reorderTab', () => {
    const l = [tabsW('T', ['A', 'B', 'C'])];
    expect(moveTab(l, 'T', 't1', 1)[0]!.tabs!.map((t) => t.name)).toEqual(['B', 'A', 'C']);
    expect(moveTab(l, 'T', 't1', -1)[0]!.tabs!.map((t) => t.name)).toEqual(['A', 'B', 'C']);
    expect(reorderTab(l, 'T', 't3', 0)[0]!.tabs!.map((t) => t.name)).toEqual(['C', 'A', 'B']);
  });
  it('deleteTab move sends children to the next tab, else the previous', () => {
    const l = [tabsW('T', ['A', 'B', 'C']), inTab('x', 't1'), inTab('z', 't3')];
    const a = deleteTab(l, 'T', 't1', 'move');
    expect(a.find((i) => i.id === 'x')!.in!.tab).toBe('t2');
    expect(a[0]!.tabs).toHaveLength(2);
    expect(deleteTab(l, 'T', 't3', 'move').find((i) => i.id === 'z')!.in!.tab).toBe('t2');
  });
  it('deleteTab delete removes the children', () => {
    const l = [tabsW('T', ['A', 'B']), inTab('x', 't1'), inTab('y', 't2')];
    expect(ids(deleteTab(l, 'T', 't1', 'delete'))).toEqual(['T', 'y']);
  });
  it('deleteTab of the last tab removes the tabs widget and moves children to the top level', () => {
    const l = [tabsW('T', ['A']), w('a', 10), inTab('x', 't1')];
    const out = deleteTab(l, 'T', 't1', 'move');
    expect(ids(out)).toEqual(['a', 'x']);
    expect(out[1]!.in).toBeUndefined();
    expect(ids(deleteTab(l, 'T', 't1', 'delete'))).toEqual(['a']);
  });
  it('removeTabs move keeps tab order below everything; delete removes every child', () => {
    const l = [tabsW('T', ['A', 'B']), w('a', 0), inTab('y', 't2'), inTab('x', 't1')];
    const out = removeTabs(l, 'T', 'move');
    expect(ids(out).sort()).toEqual(['a', 'x', 'y']);
    expect(out.find((i) => i.id === 'x')!.layout.y).toBeLessThan(out.find((i) => i.id === 'y')!.layout.y);
    expect(ids(removeTabs(l, 'T', 'delete'))).toEqual(['a']);
  });
});

describe('duplicateWidget', () => {
  it('copies a plain widget without history, placed among siblings', () => {
    const l = [w('a', 0, { history: { mode: 'values', interval: 'run', retentionDays: 30, keys: [], keep: [], since: 'previous' } })];
    const out = duplicateWidget(l, 'a')!;
    expect(out).toHaveLength(2);
    expect(out[1]!.id).not.toBe('a');
    expect(out[1]!.history).toBeUndefined();
    expect(out[1]!.layout.x).toBe(6);
  });
  it('copies a tabs widget with new tab and widget ids and remapped in', () => {
    const l = [tabsW('T', ['A', 'B']), inTab('x', 't1'), inTab('y', 't2')];
    const out = duplicateWidget(l, 'T')!;
    expect(out).toHaveLength(6);
    const copy = out[3]!;
    expect(copy.type).toBe('tabs');
    expect(copy.id).not.toBe('T');
    expect(copy.tabs!.map((t) => t.name)).toEqual(['A', 'B']);
    expect(copy.tabs!.every((t) => t.id !== 't1' && t.id !== 't2')).toBe(true);
    const kids = out.slice(4);
    expect(kids.every((k) => k.in!.tabs === copy.id && copy.tabs!.some((t) => t.id === k.in!.tab))).toBe(true);
    expect(kids[0]!.in!.tab).toBe(copy.tabs![0]!.id);
    expect(kids[0]!.id).not.toBe('x');
  });
  it('returns null over 100 widgets and changes nothing', () => {
    const l = [tabsW('T', ['A']), ...Array.from({ length: 45 }, (_, i) => inTab(`k${i}`, 't1', i * 4)), ...Array.from({ length: 14 }, (_, i) => w(`o${i}`, i * 4))];
    expect(l).toHaveLength(60);
    expect(duplicateWidget(l, 'T')).toBeNull();
    expect(MAX_WIDGETS).toBe(100);
    expect(l).toHaveLength(60);
  });
});

describe('destinations', () => {
  it('lists Top level then tabs grouped by title or "Tabs"', () => {
    const l = [tabsW('T', ['A', 'B'], 'Main'), { ...tabsW('U', ['C'], '  ') }];
    expect(destinations(l)).toEqual([
      { label: 'Top level', to: null },
      { label: 'A', to: { tabs: 'T', tab: 't1' }, group: 'Main' },
      { label: 'B', to: { tabs: 'T', tab: 't2' }, group: 'Main' },
      { label: 'C', to: { tabs: 'U', tab: 't1' }, group: 'Tabs' },
    ]);
  });
});
