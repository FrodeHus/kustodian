import { useEffect, useRef, useState } from 'react';
import { MOD } from '../shell/keys';

interface SaveButtonProps {
  /** The tab is saved, to the library or to a file: the button gets its menu with Save as. */
  saved: boolean;
  onSave: () => void;
  onSaveAs: () => void;
}

/**
 * The toolbar's Save: a plain button for a tab that was never saved, and a split button once it is, whose ▾ opens a menu with
 * Save as. The menu closes on a click outside it or Esc, never on blur (macOS WebKit doesn't focus a clicked button).
 */
export function SaveButton({ saved, onSave, onSaveAs }: SaveButtonProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const item = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    item.current?.focus();
    const onDown = (e: MouseEvent) => {
      if (!(e.target instanceof Node) || !ref.current?.contains(e.target)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const save = (
    <button type="button" className="btn" title={`Save (${MOD} S)`} onClick={onSave}>
      Save
    </button>
  );
  if (!saved) {
    return save;
  }
  return (
    <div ref={ref} className="split relative">
      {save}
      <button
        type="button"
        className="btn"
        aria-label="More save options"
        aria-haspopup="menu"
        aria-expanded={open}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen(!open)}
      >
        <span aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="menu" role="menu" aria-label="Save" style={{ right: 0, top: 36, width: 200 }} onMouseDown={(e) => e.preventDefault()}>
          <button
            ref={item}
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onSaveAs();
            }}
          >
            Save as…
            <span className="kbd ml-auto">{MOD} Shift S</span>
          </button>
        </div>
      )}
    </div>
  );
}
