import { COLUMNS, compact, move, place } from './layout';
import { MAX_TAB_NAME, MAX_WIDGETS, newTabId, newWidget, placeKey, placeOf } from './model';
import type { Place, Tab, Widget } from './model';

export { placeKey, placeOf };

export const siblings = (widgets: Widget[], p: Place | null): Widget[] => widgets.filter((w) => placeKey(placeOf(w)) === placeKey(p));

/** Applies a layout change to one place; the other widgets keep their spot in the list. */
export function withinPlace(widgets: Widget[], p: Place | null, change: (sibs: Widget[]) => Widget[]): Widget[] {
  const changed = change(siblings(widgets, p));
  const byId = new Map(changed.map((w) => [w.id, w]));
  const old = new Set(siblings(widgets, p).map((w) => w.id));
  const kept = widgets.flatMap((w) => (!old.has(w.id) ? [w] : byId.has(w.id) ? [byId.get(w.id)!] : []));
  return [...kept, ...changed.filter((w) => !old.has(w.id))];
}

export const childrenOf = (widgets: Widget[], tabsId: string, tab?: string): Widget[] =>
  widgets.filter((w) => w.in?.tabs === tabsId && (tab === undefined || w.in.tab === tab));

export function moveTo(widgets: Widget[], id: string, to: Place | null, at?: { x: number; y: number }): Widget[] {
  const w = widgets.find((i) => i.id === id);
  if (!w || w.type === 'tabs' || (to && !widgets.find((i) => i.id === to.tabs)?.tabs?.some((t) => t.id === to.tab))) {
    return widgets;
  }
  const rest = withinPlace(
    widgets.filter((i) => i.id !== id),
    placeOf(w),
    compact,
  );
  const width = Math.min(COLUMNS, w.layout.w);
  const { in: _in, ...bare } = w;
  const bottom = Math.max(0, ...siblings(rest, to).map((i) => i.layout.y + i.layout.h));
  const moved: Widget = {
    ...bare,
    ...(to ? { in: to } : {}),
    layout: { ...w.layout, w: width, x: Math.min(w.layout.x, COLUMNS - width), y: bottom },
  };
  const out = [...rest, moved];
  return at ? withinPlace(out, to, (s) => move(s, id, at.x, at.y)) : out;
}

const editTabs = (widgets: Widget[], tabsId: string, f: (tabs: Tab[]) => Tab[]): Widget[] =>
  widgets.map((w) => (w.id === tabsId && w.tabs ? { ...w, tabs: f(w.tabs) } : w));

export function addTab(widgets: Widget[], tabsId: string, name?: string): { widgets: Widget[]; tab: Tab } {
  const n = widgets.find((w) => w.id === tabsId)?.tabs?.length ?? 0;
  const tab = { id: newTabId(), name: name ?? `Tab ${n + 1}` };
  return { widgets: editTabs(widgets, tabsId, (t) => [...t, tab]), tab };
}

export function renameTab(widgets: Widget[], tabsId: string, tabId: string, name: string): Widget[] {
  const clean = name.trim().slice(0, MAX_TAB_NAME);
  return clean ? editTabs(widgets, tabsId, (t) => t.map((i) => (i.id === tabId ? { ...i, name: clean } : i))) : widgets;
}

export function reorderTab(widgets: Widget[], tabsId: string, tabId: string, toIndex: number): Widget[] {
  return editTabs(widgets, tabsId, (tabs) => {
    const tab = tabs.find((t) => t.id === tabId);
    if (!tab) {
      return tabs;
    }
    const rest = tabs.filter((t) => t !== tab);
    rest.splice(Math.min(rest.length, Math.max(0, toIndex)), 0, tab);
    return rest;
  });
}

export function moveTab(widgets: Widget[], tabsId: string, tabId: string, by: -1 | 1): Widget[] {
  const i = widgets.find((w) => w.id === tabsId)?.tabs?.findIndex((t) => t.id === tabId) ?? -1;
  return i < 0 ? widgets : reorderTab(widgets, tabsId, tabId, i + by);
}

export function removeTabs(widgets: Widget[], tabsId: string, children: 'move' | 'delete'): Widget[] {
  const tabs = widgets.find((w) => w.id === tabsId)?.tabs ?? [];
  const kids = children === 'move' ? tabs.flatMap((t) => childrenOf(widgets, tabsId, t.id)) : [];
  return kids.reduce((acc, k) => moveTo(acc, k.id, null), widgets).filter((w) => w.id !== tabsId && (children === 'move' || w.in?.tabs !== tabsId));
}

export function deleteTab(widgets: Widget[], tabsId: string, tabId: string, children: 'move' | 'delete'): Widget[] {
  const tabs = widgets.find((w) => w.id === tabsId)?.tabs ?? [];
  const i = tabs.findIndex((t) => t.id === tabId);
  if (i < 0) {
    return widgets;
  }
  if (tabs.length === 1) {
    return removeTabs(widgets, tabsId, children);
  }
  const target = (tabs[i + 1] ?? tabs[i - 1])!;
  const kept =
    children === 'move'
      ? childrenOf(widgets, tabsId, tabId).reduce((acc, k) => moveTo(acc, k.id, { tabs: tabsId, tab: target.id }), widgets)
      : widgets.filter((w) => !(w.in?.tabs === tabsId && w.in.tab === tabId));
  return editTabs(kept, tabsId, (t) => t.filter((x) => x.id !== tabId));
}

const fresh = (w: Widget): Widget => ({ ...w, id: newWidget(w.type, w.layout).id });

export function duplicateWidget(widgets: Widget[], id: string): Widget[] | null {
  const w = widgets.find((i) => i.id === id);
  if (!w) {
    return null;
  }
  const kids = w.type === 'tabs' ? childrenOf(widgets, id) : [];
  if (widgets.length + 1 + kids.length > MAX_WIDGETS) {
    return null;
  }
  const copy = { ...fresh(w), layout: place(siblings(widgets, placeOf(w)), w.layout.w, w.layout.h) };
  if (!w.tabs) {
    return [...widgets, copy];
  }
  const tabIds = new Map(w.tabs.map((t) => [t.id, newTabId()]));
  copy.tabs = w.tabs.map((t) => ({ ...t, id: tabIds.get(t.id)! }));
  const copies = kids.map((k) => ({ ...fresh(k), in: { tabs: copy.id, tab: tabIds.get(k.in!.tab) ?? k.in!.tab } }));
  return [...widgets, copy, ...copies];
}

export function destinations(widgets: Widget[]): { label: string; to: Place | null; group?: string }[] {
  const tabs = widgets.flatMap((w) => (w.type === 'tabs' ? [w] : []));
  return [
    { label: 'Top level', to: null },
    ...tabs.flatMap((w) => (w.tabs ?? []).map((t) => ({ label: t.name, to: { tabs: w.id, tab: t.id }, group: w.title.trim() || 'Tabs' }))),
  ];
}
