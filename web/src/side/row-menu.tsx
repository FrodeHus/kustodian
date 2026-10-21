import { useEffect, useRef, useState } from 'react';

export interface RowAction {
  label: string;
  run: () => void;
}

/** A row's "⋯" button and its menu. Choosing an item, Esc, or a click elsewhere closes it. */
export function RowMenu({ name, actions }: { name: string; actions: RowAction[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onDown = (e: MouseEvent) => {
      if (!(e.target instanceof Node) || !ref.current?.contains(e.target)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  return (
    <div
      ref={ref}
      className="relative shrink-0"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && open) {
          e.preventDefault();
          setOpen(false);
        }
      }}
    >
      <button
        type="button"
        className="row-more"
        aria-label={`More for ${name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        ⋯
      </button>
      {open && (
        <div className="menu" role="menu" aria-label={name} style={{ right: 0, top: 26, minWidth: 170 }}>
          {actions.map((a) => (
            <button
              key={a.label}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
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
