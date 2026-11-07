import type { ReactNode } from 'react';
import { narrowOrder } from './layout';
import type { Place, Widget } from './model';
import { placeKey, siblings } from './tabs';
import { WidgetFrame } from './widget-frame';
import { useWorkbooks } from './workbook-store';

/** Edit mode's part in a grid: the selected widget and place, and what the workbook does on a widget's actions. */
export interface GridEditing {
  selected: string | null;
  onSelect: (w: Widget) => void;
  onEditWidget: (w: Widget, opener: HTMLElement) => void;
  /** A tabs widget's `children` go to the top level ('move') or with it ('delete'); without it, the workbook asks. */
  onRemove: (w: Widget, children?: 'move' | 'delete') => void;
  announce: (text: string) => void;
  onMoveTo: (w: Widget, to: Place | null, at?: { x: number; y: number }) => void;
  /** The tab grid new widgets go into; null is the top level. */
  selectedPlace: Place | null;
  onSelectPlace: (p: Place | null) => void;
}

/** One place's 12-column grid (the top level, or a tab of a tabs widget): its widgets in (y, x) order, `.wb-grid` stacking them
 * full width when narrow. In edit mode, a click on its empty area selects the place. */
export function WidgetGrid({
  tabId,
  place,
  editing,
  body,
  onSignIn,
}: {
  tabId: string;
  place: Place | null;
  editing: GridEditing | undefined;
  body: (w: Widget) => ReactNode;
  onSignIn?: () => void;
}) {
  const widgets = useWorkbooks((s) => s.byTab[tabId]?.doc.widgets);
  const key = placeKey(place);
  return (
    <div
      data-wb-place={key}
      data-selected={(place && editing && placeKey(editing.selectedPlace) === key) || undefined}
      className={editing ? 'wb-grid wb-editing' : 'wb-grid'}
      onClick={editing && ((e) => e.target === e.currentTarget && editing.onSelectPlace(place))}
    >
      {narrowOrder(siblings(widgets ?? [], place)).map((w) => (
        <WidgetFrame
          key={w.id}
          tabId={tabId}
          widget={w}
          onSignIn={onSignIn}
          editing={
            editing && {
              selected: editing.selected === w.id,
              onSelect: () => editing.onSelect(w),
              onEditWidget: (opener) => editing.onEditWidget(w, opener),
              onRemove: () => editing.onRemove(w),
              announce: editing.announce,
              onMoveTo: (to, at) => editing.onMoveTo(w, to, at),
            }
          }
        >
          {body(w)}
        </WidgetFrame>
      ))}
    </div>
  );
}
