import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { MenuButton } from '../results/menu';
import { MAX_TAB_NAME, type Tab, type Widget } from './model';
import { addTab, childrenOf, deleteTab, moveTab, renameTab, reorderTab } from './tabs';
import { WidgetGrid, type GridEditing } from './widget-grid';
import { useWorkbooks, visibleTab } from './workbook-store';

/** Asks what happens to the widgets of a tab or tabs widget being deleted: moved (the default) or deleted too. Modelled on
 * ClearConfirm: focus goes back to the opener when it closes, if that is still there. */
export function ChildrenConfirm({
  question,
  count,
  move,
  onChoose,
  onCancel,
}: {
  question: string;
  count: number;
  move: string;
  onChoose: (children: 'move' | 'delete') => void;
  onCancel: () => void;
}) {
  const id = useId();
  // Read while rendering, before autoFocus moves focus to the move button.
  const [opener] = useState(() => document.activeElement);
  useLayoutEffect(() => () => void (opener instanceof HTMLElement && opener.isConnected && opener.focus()), [opener]);
  return createPortal(
    <div
      className="fixed inset-0 z-20"
      onKeyDown={(e) => {
        // Not the workbook's Ctrl+Z (or any other key) behind the confirm.
        e.stopPropagation();
        if (e.key === 'Escape') {
          // Not full screen's Esc as well.
          e.preventDefault();
          onCancel();
        }
      }}
    >
      <div className="scrim" onClick={onCancel} />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={id}
        className="card absolute inset-x-0 top-[20vh] mx-auto flex w-[400px] max-w-[calc(100vw-32px)] flex-col gap-2 p-3 text-[12px]"
      >
        <span id={id}>
          {question} It has {count} {count === 1 ? 'widget' : 'widgets'}.
        </span>
        <div className="flex flex-wrap justify-end gap-1.5">
          <button type="button" className="btn ghost" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="btn ghost" onClick={() => onChoose('delete')}>
            Delete them too
          </button>
          <button type="button" className="btn primary" autoFocus onClick={() => onChoose('move')}>
            {move}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * A tabs widget's body (spec 15.1–15.2): a tab bar (arrow keys, Home and End move between tabs) and the visible tab's grid,
 * which scrolls inside the widget's height. A tab whose data widgets haven't run says "not run"; one with a widget whose result
 * is out of date says so. In edit mode (spec 15.3): "+" adds a tab, double-click or Enter on the shown tab renames it, the
 * shown tab's ⋯ has Rename, Move left / right and Delete, and dragging a tab in the bar reorders it.
 */
export function TabsWidget({
  tabId,
  widget,
  editing,
  body,
  onSignIn,
  accountKey,
  printing,
}: {
  tabId: string;
  widget: Widget;
  editing: GridEditing | undefined;
  body: (w: Widget) => ReactNode;
  onSignIn?: () => void;
  accountKey?: string | null;
  /** Print or save as PDF is under way: every tab is rendered for print, each under its name. */
  printing?: boolean;
}) {
  const state = useWorkbooks((s) => s.byTab[tabId]);
  const id = useId();
  const refs = useRef(new Map<string, HTMLButtonElement>());
  // The tab with keyboard focus: arrows move it without showing the tab, as showing one runs its queries.
  const [focused, setFocused] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  // The tab being renamed, cleared by the first of Enter, Esc or blur, so the input's unmount doesn't commit twice.
  const renameOpen = useRef<string | null>(null);
  const [deleting, setDeleting] = useState<Tab | null>(null);
  // The tab button to focus once the next render is in (after a rename or a delete).
  const focusTab = useRef<string | null>(null);
  // A pointer press on a tab: where it started and whether it has moved far enough to be a drag; `dragged` eats the click after one.
  // `stop` removes its Esc listener.
  const press = useRef<{ id: string; x: number; moved: boolean; stop: () => void } | null>(null);
  const dragged = useRef(false);
  useEffect(() => {
    if (focusTab.current) {
      refs.current.get(focusTab.current)?.focus();
      focusTab.current = null;
    }
  });
  if (!state) {
    return null;
  }
  const { edit } = useWorkbooks.getState();
  const tabs = widget.tabs ?? [];
  const shown = visibleTab(state, widget.id);
  const current = tabs.some((t) => t.id === focused) ? focused : shown;
  const choose = (tab: string) => {
    setFocused(tab);
    useWorkbooks.getState().showTab(tabId, widget.id, tab);
    editing?.onSelectPlace({ tabs: widget.id, tab });
  };
  const startRename = (tab: string) => {
    renameOpen.current = tab;
    setRenaming(tab);
  };
  /** Ends a rename: commits `name` (null cancels); an empty or unchanged name changes nothing. */
  const finishRename = (name: string | null, refocus: boolean) => {
    const tab = tabs.find((t) => t.id === renameOpen.current);
    renameOpen.current = null;
    setRenaming(null);
    if (!tab) {
      return;
    }
    if (name !== null && name.trim() && name.trim() !== tab.name) {
      edit(tabId, (d) => ({ ...d, widgets: renameTab(d.widgets, widget.id, tab.id, name) }));
    }
    if (refocus) {
      focusTab.current = tab.id;
    }
  };
  const add = () => {
    const { widgets, tab } = addTab(useWorkbooks.getState().byTab[tabId]!.doc.widgets, widget.id);
    edit(tabId, (d) => ({ ...d, widgets }));
    // It's empty, so showing it runs nothing.
    choose(tab.id);
    startRename(tab.id);
  };
  // Where a deleted tab's widgets go (deleteTab's choice): the next tab, else the previous one.
  const neighbour = (tab: Tab) => {
    const i = tabs.findIndex((t) => t.id === tab.id);
    return tabs[i + 1] ?? tabs[i - 1];
  };
  const removeTab = (tab: Tab, children: 'move' | 'delete') => {
    setDeleting(null);
    // The last tab goes with its tabs widget, through the workbook's Remove (focus, announcement, selection).
    if (tabs.length === 1) {
      editing?.onRemove(widget, children);
      return;
    }
    const next = neighbour(tab);
    edit(tabId, (d) => ({ ...d, widgets: deleteTab(d.widgets, widget.id, tab.id, children) }));
    if (next) {
      // The tab that received the widgets is shown, so they stay in view.
      if (children === 'move' && tab.id === shown) {
        choose(next.id);
      }
      setFocused(next.id);
      focusTab.current = next.id;
    }
  };
  /** Reorders the tabs. The shown tab is pinned first: shown by default as the first tab, it would otherwise change. */
  const reorder = (change: (widgets: Widget[]) => Widget[]) => {
    if (shown && state.activeTabs[widget.id] !== shown) {
      useWorkbooks.getState().showTab(tabId, widget.id, shown);
    }
    edit(tabId, (d) => ({ ...d, widgets: change(d.widgets) }));
  };
  const askDelete = (tab: Tab) =>
    childrenOf(state.doc.widgets, widget.id, tab.id).length > 0 ? setDeleting(tab) : removeTab(tab, 'delete');
  const endPress = () => {
    press.current?.stop();
    press.current = null;
  };
  const drag = {
    onPointerDown: (e: PointerEvent<HTMLButtonElement>, id: string) => {
      dragged.current = false;
      if (e.button === 0) {
        endPress();
        // Esc drops the drag, and the click that ends it shows nothing.
        const onEsc = (k: globalThis.KeyboardEvent) => {
          if (k.key === 'Escape') {
            k.preventDefault();
            k.stopPropagation();
            endPress();
            dragged.current = true;
          }
        };
        window.addEventListener('keydown', onEsc, true);
        press.current = { id, x: e.clientX, moved: false, stop: () => window.removeEventListener('keydown', onEsc, true) };
        // Absent in jsdom; in a browser it keeps the gesture's events on the tab when the pointer leaves it.
        e.currentTarget.setPointerCapture?.(e.pointerId);
      }
    },
    onPointerMove: (e: PointerEvent<HTMLButtonElement>) => {
      const p = press.current;
      // A few pixels' threshold, so a click that wobbles is still a click.
      if (p && Math.abs(e.clientX - p.x) > 4) {
        p.moved = true;
      }
    },
    onPointerUp: (e: PointerEvent<HTMLButtonElement>) => {
      const p = press.current;
      endPress();
      if (!p?.moved) {
        return;
      }
      dragged.current = true;
      // The new index among the other tabs: how many of them have their middle left of the pointer.
      const to = tabs.filter((t) => {
        const r = t.id !== p.id && refs.current.get(t.id)?.getBoundingClientRect();
        return r && r.left + r.width / 2 < e.clientX;
      }).length;
      if (to !== tabs.findIndex((t) => t.id === p.id)) {
        reorder((w) => reorderTab(w, widget.id, p.id, to));
      }
    },
    onPointerCancel: endPress,
    // Capture lost without a pointerup here (the window lost focus, say): drop the drag.
    onLostPointerCapture: endPress,
  };
  const onKey = (e: KeyboardEvent, tab: string) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (editing && e.key === 'Enter' && tab === shown) {
        startRename(tab);
      } else {
        choose(tab);
      }
      return;
    }
    const at = tabs.findIndex((t) => t.id === tab);
    const to =
      e.key === 'ArrowRight' ? at + 1 : e.key === 'ArrowLeft' ? at - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : null;
    const next = to === null ? undefined : tabs[(to + tabs.length) % tabs.length];
    if (next) {
      e.preventDefault();
      setFocused(next.id);
      refs.current.get(next.id)?.focus();
    }
  };
  const marks = (tab: string) => {
    // A widget without query text never runs, so it can't be "not run".
    const data = childrenOf(state.doc.widgets, widget.id, tab).filter((w) => w.query && w.query.text.trim() !== '');
    return [
      data.some((w) => (state.runs[w.id]?.state ?? 'idle') === 'idle') && 'not run',
      data.some((w) => state.stale[w.id]) && 'out of date',
    ].filter((m) => m !== false);
  };
  const empty = shown !== undefined && childrenOf(state.doc.widgets, widget.id, shown).length === 0;

  return (
    <div className="wb-tabs flex min-h-0 flex-1 flex-col">
      {printing && (
        <div className="print-only wb-print-tabs px-3 pb-3">
          {tabs.map((t) => (
            <section key={t.id}>
              <h3 className="wb-print-tab">{t.name}</h3>
              {childrenOf(state.doc.widgets, widget.id, t.id).length === 0 ? (
                <p className="faint m-0 text-[12px]">No widgets on this tab</p>
              ) : (
                <WidgetGrid
                  tabId={tabId}
                  place={{ tabs: widget.id, tab: t.id }}
                  editing={undefined}
                  body={body}
                  onSignIn={onSignIn}
                  accountKey={accountKey}
                />
              )}
            </section>
          ))}
        </div>
      )}
      <div className="rbar screen-only shrink-0 pr-10">
        <div role="tablist" aria-label={widget.title || 'Tabs'} className="flex min-w-0 items-center gap-1.5 overflow-x-auto">
          {tabs.map((t) =>
            t.id === renaming ? (
              <input
                key={t.id}
                className="textbox"
                style={{ height: 24 }}
                aria-label="Tab name"
                defaultValue={t.name}
                maxLength={MAX_TAB_NAME}
                autoFocus
                onFocus={(e) => e.currentTarget.select()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === 'Escape') {
                    // Esc here isn't full screen's.
                    e.preventDefault();
                    finishRename(e.key === 'Enter' ? e.currentTarget.value : null, true);
                  }
                }}
                onBlur={(e) => finishRename(e.currentTarget.value, false)}
              />
            ) : (
              <button
                key={t.id}
                ref={(el) => {
                  if (el) {
                    refs.current.set(t.id, el);
                  } else {
                    refs.current.delete(t.id);
                  }
                }}
                id={`${id}-${t.id}`}
                type="button"
                role="tab"
                className="rtab whitespace-nowrap"
                aria-selected={t.id === shown}
                aria-controls={`${id}-panel`}
                tabIndex={t.id === current ? 0 : -1}
                data-wb-tab={t.id}
                data-wb-tabs={widget.id}
                onKeyDown={(e) => onKey(e, t.id)}
                onClick={() => {
                  if (dragged.current) {
                    dragged.current = false;
                  } else {
                    choose(t.id);
                  }
                }}
                {...(editing && {
                  onDoubleClick: () => startRename(t.id),
                  onPointerDown: (e: PointerEvent<HTMLButtonElement>) => drag.onPointerDown(e, t.id),
                  onPointerMove: drag.onPointerMove,
                  onPointerUp: drag.onPointerUp,
                  onPointerCancel: drag.onPointerCancel,
                  onLostPointerCapture: drag.onLostPointerCapture,
                })}
              >
                {t.name}
                {marks(t.id).map((m) => (
                  <span key={m} className="faint text-[11px]">
                    {' · '}
                    {m}
                  </span>
                ))}
              </button>
            ),
          )}
        </div>
        {/* Outside the tab list's scroller, so the menu isn't clipped by it. */}
        {editing &&
          tabs.map(
            (t, i) =>
              t.id === shown &&
              t.id !== renaming && (
                <MenuButton key={t.id} label={`${t.name} tab menu`} icon="⋯">
                  <button type="button" role="menuitem" tabIndex={-1} onClick={() => startRename(t.id)}>
                    Rename
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    tabIndex={-1}
                    disabled={i === 0}
                    onClick={() => reorder((w) => moveTab(w, widget.id, t.id, -1))}
                  >
                    Move left
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    tabIndex={-1}
                    disabled={i === tabs.length - 1}
                    onClick={() => reorder((w) => moveTab(w, widget.id, t.id, 1))}
                  >
                    Move right
                  </button>
                  <button type="button" role="menuitem" tabIndex={-1} onClick={() => askDelete(t)}>
                    Delete
                  </button>
                </MenuButton>
              ),
          )}
        {editing && (
          <button type="button" className="btn ghost" aria-label="Add tab" title="Add tab" onClick={add}>
            +
          </button>
        )}
      </div>
      <div
        id={`${id}-panel`}
        role="tabpanel"
        aria-labelledby={shown && `${id}-${shown}`}
        tabIndex={0}
        className={`min-h-0 flex-1 overflow-auto p-3 ${printing ? 'screen-only' : ''}`}
      >
        {empty && <p className="faint m-0 pb-2 text-[12px]">{editing ? 'Drag a widget here or use Move to…' : 'No widgets on this tab'}</p>}
        {shown !== undefined && (!empty || editing) && (
          <WidgetGrid
            tabId={tabId}
            place={{ tabs: widget.id, tab: shown }}
            editing={editing}
            body={body}
            onSignIn={onSignIn}
            accountKey={accountKey}
          />
        )}
      </div>
      {deleting && (
        <ChildrenConfirm
          question={`Delete ${deleting.name}?`}
          count={childrenOf(state.doc.widgets, widget.id, deleting.id).length}
          move={`Move them to ${neighbour(deleting)?.name ?? 'the top level'}`}
          onChoose={(children) => removeTab(deleting, children)}
          onCancel={() => setDeleting(null)}
        />
      )}
    </div>
  );
}
