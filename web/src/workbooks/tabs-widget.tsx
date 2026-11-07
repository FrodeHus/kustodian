import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import type { Widget } from './model';
import { childrenOf } from './tabs';
import { WidgetGrid, type GridEditing } from './widget-grid';
import { useWorkbooks, visibleTab } from './workbook-store';

/**
 * A tabs widget's body (spec 15.1–15.2): a tab bar (arrow keys, Home and End move between tabs) and the visible tab's grid,
 * which scrolls inside the widget's height. A tab whose data widgets haven't run says "not run"; one with a widget whose result
 * is out of date says so.
 */
export function TabsWidget({
  tabId,
  widget,
  editing,
  body,
  onSignIn,
}: {
  tabId: string;
  widget: Widget;
  editing: GridEditing | undefined;
  body: (w: Widget) => ReactNode;
  onSignIn?: () => void;
}) {
  const state = useWorkbooks((s) => s.byTab[tabId]);
  const id = useId();
  const refs = useRef(new Map<string, HTMLButtonElement>());
  if (!state) {
    return null;
  }
  const tabs = widget.tabs ?? [];
  const shown = visibleTab(state, widget.id);
  const choose = (tab: string) => {
    useWorkbooks.getState().showTab(tabId, widget.id, tab);
    editing?.onSelectPlace({ tabs: widget.id, tab });
  };
  const onKey = (e: KeyboardEvent) => {
    const at = tabs.findIndex((t) => t.id === shown);
    const to = e.key === 'ArrowRight' ? at + 1 : e.key === 'ArrowLeft' ? at - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : null;
    const next = to === null ? undefined : tabs[(to + tabs.length) % tabs.length];
    if (next) {
      e.preventDefault();
      choose(next.id);
      refs.current.get(next.id)?.focus();
    }
  };
  const marks = (tab: string) => {
    const data = childrenOf(state.doc.widgets, widget.id, tab).filter((w) => w.query);
    return [
      data.some((w) => (state.runs[w.id]?.state ?? 'idle') === 'idle') && 'not run',
      data.some((w) => state.stale[w.id]) && 'out of date',
    ].filter((m) => m !== false);
  };
  const empty = shown !== undefined && childrenOf(state.doc.widgets, widget.id, shown).length === 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div role="tablist" aria-label={widget.title || 'Tabs'} className="rbar shrink-0 overflow-x-auto pr-10" onKeyDown={onKey}>
        {tabs.map((t) => (
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
            tabIndex={t.id === shown ? 0 : -1}
            data-wb-tab={t.id}
            data-wb-tabs={widget.id}
            onClick={() => choose(t.id)}
          >
            {t.name}
            {marks(t.id).map((m) => (
              <span key={m} className="faint text-[11px]">
                {' · '}
                {m}
              </span>
            ))}
          </button>
        ))}
      </div>
      <div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-${shown}`} className="min-h-0 flex-1 overflow-auto p-3">
        {empty && <p className="faint m-0 pb-2 text-[12px]">{editing ? 'Drag a widget here or use Move to…' : 'No widgets on this tab'}</p>}
        {shown !== undefined && (!empty || editing) && <WidgetGrid tabId={tabId} place={{ tabs: widget.id, tab: shown }} editing={editing} body={body} onSignIn={onSignIn} />}
      </div>
    </div>
  );
}
