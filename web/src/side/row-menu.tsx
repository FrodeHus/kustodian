import { useEffect, useRef, useState, type KeyboardEvent } from 'react';

export interface RowAction {
  label: string;
  run: () => void;
}

/**
 * A row's "⋯" button and its menu. Opening it moves focus to its first item; the arrow keys, Home and End move between items.
 * Choosing an item or pressing Esc closes it and puts focus back on "⋯". A click elsewhere, or Tab out of it, closes it and
 * leaves focus where it went. It never closes on blur: macOS WebKit doesn't focus a button that is clicked, so a click on an
 * item would blur the menu before the click landed. A mousedown on "⋯" or the menu doesn't move focus at all, as in
 * `MenuButton`.
 */
export function RowMenu({ name, actions }: { name: string; actions: RowAction[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const items = () => [...(ref.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])];

  useEffect(() => {
    if (!open) {
      return;
    }
    ref.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    const onDown = (e: MouseEvent) => {
      if (!(e.target instanceof Node) || !ref.current?.contains(e.target)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const closeToTrigger = () => {
    setOpen(false);
    trigger.current?.focus();
  };

  const onMenuKey = (e: KeyboardEvent) => {
    const list = items();
    const at = list.findIndex((b) => b === document.activeElement);
    const move = (to: number) => list[(to + list.length) % list.length]?.focus();
    switch (e.key) {
      case 'ArrowDown':
        move(at + 1);
        break;
      case 'ArrowUp':
        move(at - 1);
        break;
      case 'Home':
        move(0);
        break;
      case 'End':
        move(list.length - 1);
        break;
      case 'Escape':
        closeToTrigger();
        break;
      case 'Tab':
        // Focus moves on as Tab moves it; the menu closes behind it.
        setOpen(false);
        return;
      default:
        return;
    }
    // Handled here: the window's shortcuts leave these keys alone.
    e.preventDefault();
  };

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        ref={trigger}
        type="button"
        className="row-more"
        aria-label={`More for ${name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((o) => !o)}
      >
        ⋯
      </button>
      {open && (
        <div className="menu" role="menu" aria-label={name} style={{ right: 0, top: 26, minWidth: 170 }}
          onKeyDown={onMenuKey}
          onMouseDown={(e) => e.preventDefault()}
        >
          {actions.map((a) => (
            <button
              key={a.label}
              type="button"
              role="menuitem"
              tabIndex={-1}
              onClick={() => {
                closeToTrigger();
                a.run();
              }}
            >
              {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Asks before deleting `name`: "Delete" deletes, "Cancel" keeps it. */
export function ConfirmDelete({ name, onDelete, onCancel }: { name: string; onDelete: () => void; onCancel: () => void }) {
  const question = `Delete “${name}”?`;
  return (
    <div role="group" aria-label={question} className="mx-1.5 my-1 flex flex-col gap-2 rounded-[7px] border border-line bg-panel2 p-2.5 text-[12px]">
      <span>{question}</span>
      <div className="flex justify-end gap-1.5">
        <button type="button" className="btn ghost" autoFocus onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="btn primary" onClick={onDelete}>
          Delete
        </button>
      </div>
    </div>
  );
}
