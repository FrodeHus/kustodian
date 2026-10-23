import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { ResultColumn } from '../wire';
import { copyFailed, copyText } from './copy';
import { cellText, type Row } from './export';
import { JsonTree } from './json-tree';
import type { Notice } from './result-grid';

const isComplex = (value: unknown): value is Record<string, unknown> | unknown[] => typeof value === 'object' && value !== null;

/** A dynamic value too long for the engine to send whole: it comes as its JSON text, cut, and ends in "…". */
const isCutJson = (value: unknown) => typeof value === 'string' && value.endsWith('…') && /^\s*[[{]/.test(value);

/** A value as it is shown and copied: dynamic values as formatted JSON. */
const valueText = (value: unknown) => (isComplex(value) ? JSON.stringify(value, null, 2) : cellText(value));

/** The row as one JSON object keyed by column name. */
const rowJson = (columns: ResultColumn[], row: Row) => JSON.stringify(Object.fromEntries(columns.map((c, i) => [c.name, row[i] ?? null])), null, 2);

/**
 * Row details (spec 6.5, mockup Palette): a side sheet with every column of one row, dynamic values as a tree to open and close,
 * a copy button for each value and one for the whole row. Esc or × closes it, and focus goes back where it was. Another row
 * opened while it shows takes its place without moving focus, and is announced.
 *
 * It isn't modal (ruling 26): focus may go elsewhere, such as into the editor. While focus is in the sheet, Tab and Shift+Tab
 * cycle through its buttons.
 */
export function RowDetails({ columns, row, onClose, id }: { columns: ResultColumn[]; row: Row; onClose: () => void; id?: string }) {
  const [notice, setNotice] = useState<Notice | null>(null);
  // Fully opened dynamic values, by column; another row starts closed again, with no notice.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [rowSeen, setRowSeen] = useState(row);
  // How many times another row took this one's place: the trees start again with each.
  const [switches, setSwitches] = useState(0);
  if (rowSeen !== row) {
    setRowSeen(row);
    setNotice(null);
    setExpanded(new Set());
    setSwitches(switches + 1);
  }
  const sheet = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const title = cellText(row[0]) || 'Row details';

  // Where focus was when the sheet opened: Esc and × put it back there. (Closing because a dialog opened leaves focus to it.)
  const before = useRef<Element | null>(null);
  useEffect(() => {
    before.current = document.activeElement;
    closeButton.current?.focus();
  }, []);
  // Another row opened from outside the sheet: focus stays there, and goes back there on close.
  useEffect(() => {
    const at = document.activeElement;
    if (at && !sheet.current?.contains(at)) {
      before.current = at;
    }
  }, [row]);

  const toggleAll = (name: string) =>
    setExpanded((all) => {
      const next = new Set(all);
      if (!next.delete(name)) {
        next.add(name);
      }
      return next;
    });

  const close = () => {
    const back = before.current;
    onClose();
    if (back instanceof HTMLElement && back.isConnected) {
      back.focus();
    }
  };

  /** Tab from the last button goes to the first, Shift+Tab from the first to the last. */
  const cycle = (e: KeyboardEvent<HTMLDivElement>) => {
    const focusable = [...(sheet.current?.querySelectorAll<HTMLElement>('button:not(:disabled), [tabindex="0"]') ?? [])];
    const first = focusable[0];
    const last = focusable.at(-1);
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last?.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first?.focus();
    }
  };

  const copy = (text: string, done: string) =>
    copyText(text).then(
      () => setNotice({ tone: 'ok', text: done }),
      (e: unknown) => setNotice({ tone: 'bad', text: copyFailed(e) }),
    );

  return (
    <div
      ref={sheet}
      id={id}
      role="dialog"
      aria-label={`Row details: ${title}`}
      className="absolute top-0 right-0 bottom-0 z-[4] flex w-[420px] max-w-full flex-col border-l border-line bg-panel shadow-[0_18px_40px_rgba(0,0,0,0.45)]"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          close();
        } else if (e.key === 'Tab') {
          cycle(e);
        }
      }}
    >
      <div className="flex items-center gap-2 border-b border-line px-3.5 py-3">
        <b className="min-w-0 truncate">{title}</b>
        <div className="grow" />
        <button type="button" className="btn ghost shrink-0" onClick={() => void copy(rowJson(columns, row), 'Copied the row as JSON.')}>
          Copy row as JSON
        </button>
        <button ref={closeButton} type="button" className="tab-add shrink-0" aria-label="Close row details" onClick={close}>
          ×
        </button>
      </div>
      <p className="sr-only" aria-live="polite">
        {switches > 0 ? `Showing ${title}` : ''}
      </p>
      {notice && (
        <p role={notice.tone === 'bad' ? 'alert' : 'status'} className={`m-0 border-b border-line px-3.5 py-1.5 text-[12px] ${notice.tone === 'bad' ? 'bg-bad-soft text-bad' : 'text-muted'}`}>
          {notice.text}
        </p>
      )}
      <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-auto px-3.5 py-3">
        {columns.map((column, i) => {
          const value = row[i];
          const tree = isComplex(value) && (Array.isArray(value) ? value.length > 0 : Object.keys(value).length > 0);
          const all = expanded.has(column.name);
          return (
            <div key={column.name} className="field">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-muted">
                  {column.name} · {column.type}
                </span>
                {tree && (
                  <button
                    type="button"
                    className="btn ghost shrink-0"
                    style={{ height: 22, padding: '0 8px' }}
                    aria-label={`${all ? 'Collapse' : 'Expand'} ${column.name}`}
                    onClick={() => toggleAll(column.name)}
                  >
                    {all ? 'Collapse' : 'Expand all'}
                  </button>
                )}
                <button
                  type="button"
                  className="btn ghost shrink-0"
                  style={{ height: 22, padding: '0 8px' }}
                  aria-label={`Copy ${column.name}`}
                  onClick={() => void copy(valueText(value), `Copied ${column.name}.`)}
                >
                  Copy
                </button>
              </div>
              {value === null || value === undefined ? (
                <span className="mono faint">null</span>
              ) : isComplex(value) ? (
                <JsonTree key={`${switches}-${all}`} value={value} label={column.name} openDepth={all ? Infinity : 1} />
              ) : isCutJson(value) ? (
                <>
                  <pre className="codeblock m-0 overflow-auto whitespace-pre-wrap break-all">{cellText(value)}</pre>
                  <span className="faint text-[11.5px]">Cut to 1,000 characters, so it shows as text.</span>
                </>
              ) : (
                <span className="mono break-all">{valueText(value)}</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
