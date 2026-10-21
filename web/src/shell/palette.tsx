import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { call } from '../bridge';
import { useTabs } from '../tabs/tab-store';
import type { LibraryList, SavedQuery, Snippet } from '../wire';
import { allCommands, formatShortcut, matchScore } from './commands';

interface Row {
  key: string;
  title: string;
  group: string;
  shortcut?: string;
  disabled: boolean;
  /** `newTab`: Shift+Enter, which opens a snippet in a new tab rather than inserting it. */
  choose: (newTab: boolean) => void;
}

function savedRow(q: SavedQuery): Row {
  return {
    key: `saved:${q.id}`,
    title: `Saved: ${q.folder ? `${q.folder} / ` : ''}${q.name}`,
    group: 'Saved',
    disabled: false,
    choose: () => {
      useTabs.getState().openWith({ source: q.source, title: q.name, text: q.text, savedId: q.id, parameters: q.parameters });
    },
  };
}

function snippetRow(s: Snippet, onInsert: (text: string) => void): Row {
  const openIt = () => useTabs.getState().openWith({ source: s.source, title: s.name, text: s.text, parameters: s.parameters });
  return {
    key: `snippet:${s.id}`,
    title: `Snippet: ${s.name}`,
    group: 'Snippets',
    disabled: false,
    choose: (newTab) => {
      const { tabs, activeId } = useTabs.getState();
      // A snippet goes into the open query only when it is for the same source.
      if (!newTab && tabs.find((t) => t.id === activeId)?.source === s.source) {
        onInsert(s.text);
      } else {
        openIt();
      }
    },
  };
}

/**
 * The command palette (spec 6.2, mockup Palette): every command, saved query and snippet, found by typing any of their letters
 * in order. Arrow keys move, Enter chooses, Esc closes. A saved query opens in a new tab; a snippet goes in at the cursor, or
 * in a new tab with Shift+Enter.
 */
export function Palette({ onClose, onInsert }: { onClose: () => void; onInsert: (text: string) => void }) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const [saved, setSaved] = useState<SavedQuery[]>([]);
  const [snippets, setSnippets] = useState<Snippet[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Once closing, focus may go wherever the caller puts it.
  const closing = useRef(false);
  const close = () => {
    closing.current = true;
    onClose();
  };
  const id = useId();

  useEffect(() => {
    let live = true;
    const failed = () => live && setProblem('Saved queries or snippets couldn’t be loaded.');
    call<LibraryList>('library.list').then((l) => live && setSaved(l.queries), failed);
    call<{ snippets: Snippet[] }>('snippets.list').then((s) => live && setSnippets(s.snippets), failed);
    return () => {
      live = false;
    };
  }, []);

  // A modal: focus that lands outside the palette goes back to its input.
  useEffect(() => {
    const onFocusIn = (e: FocusEvent) => {
      if (!closing.current && (!(e.target instanceof Node) || !dialogRef.current?.contains(e.target))) {
        inputRef.current?.focus();
      }
    };
    document.addEventListener('focusin', onFocusIn);
    return () => document.removeEventListener('focusin', onFocusIn);
  }, []);

  const rows = useMemo(() => {
    const all: Row[] = [
      ...allCommands().map((c) => ({
        key: `command:${c.id}`,
        title: c.title,
        group: c.group,
        shortcut: c.shortcut,
        disabled: !(c.enabled?.() ?? true),
        choose: () => c.run(),
      })),
      ...saved.map(savedRow),
      ...snippets.map((s) => snippetRow(s, onInsert)),
    ];
    return all
      .map((row, order) => ({ row, order, score: matchScore(query, row.title) }))
      .filter((r): r is { row: Row; order: number; score: number } => r.score !== null)
      .sort((a, b) => a.score - b.score || a.order - b.order)
      .map((r) => r.row);
  }, [query, saved, snippets, onInsert]);

  const current = Math.min(selected, rows.length - 1);

  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' });
  }, [current]);

  const choose = (row: Row | undefined, newTab: boolean) => {
    if (!row || row.disabled) {
      return;
    }
    close();
    row.choose(newTab);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowDown':
        setSelected(Math.min(current + 1, rows.length - 1));
        break;
      case 'ArrowUp':
        setSelected(Math.max(current - 1, 0));
        break;
      case 'Enter':
        choose(rows[current], e.shiftKey);
        break;
      case 'Escape':
        close();
        break;
      case 'Tab':
        // The input is the palette's only stop.
        inputRef.current?.focus();
        break;
      default:
        return;
    }
    // Handled here: the window's shortcuts leave it alone.
    e.preventDefault();
  };

  const optionId = (index: number) => `${id}-option-${index}`;

  return (
    <div className="fixed inset-0 z-20">
      <div className="scrim" onClick={close} />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onKeyDown={onKeyDown}
        onMouseDown={(e) => {
          // Clicking a row or the hint line leaves the focus in the input.
          if (e.target !== inputRef.current) {
            e.preventDefault();
          }
        }}
        className="card absolute top-[96px] left-1/2 flex max-h-[70vh] w-[600px] max-w-[calc(100vw-32px)] -translate-x-1/2 flex-col overflow-hidden shadow-[0_24px_60px_rgba(0,0,0,0.5)]"
      >
        <input
          ref={inputRef}
          role="combobox"
          aria-label="Type a command"
          aria-expanded="true"
          aria-controls={`${id}-list`}
          aria-activedescendant={rows.length > 0 ? optionId(current) : undefined}
          aria-autocomplete="list"
          autoFocus
          spellCheck={false}
          className="h-[44px] w-full shrink-0 border-0 border-b border-solid border-line bg-panel px-3 text-[14px] text-text outline-none"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSelected(0);
          }}
        />
        <ul ref={listRef} id={`${id}-list`} role="listbox" aria-label="Commands" className="m-0 min-h-0 list-none overflow-y-auto p-1.5">
          {rows.map((row, index) => (
            <li
              key={row.key}
              id={optionId(index)}
              role="option"
              aria-selected={index === current}
              aria-disabled={row.disabled || undefined}
              className={`flex h-[34px] cursor-pointer items-center gap-2 rounded-[6px] px-2.5 ${index === current ? 'bg-accent-soft' : ''} ${row.disabled ? 'text-faint' : 'text-text'}`}
              onMouseMove={() => index !== current && setSelected(index)}
              onClick={(e) => choose(row, e.shiftKey)}
            >
              <span data-title className="truncate">
                {row.title}
              </span>
              <span className="grow" />
              {formatShortcut(row.shortcut).map((k) => (
                <span key={k} className="kbd">
                  {k}
                </span>
              ))}
              <span className="faint text-[12px]">{row.group}</span>
            </li>
          ))}
          {rows.length === 0 && <li className="faint px-2.5 py-2 text-[12px]">Nothing matches “{query}”.</li>}
        </ul>
        <div className="faint flex gap-3.5 border-t border-line px-3 py-2 text-[11.5px]">
          <span>↑↓ to move</span>
          <span>Enter to run</span>
          <span>Shift Enter opens a snippet in a new tab</span>
          <span>Esc to close</span>
          {problem && <span className="ml-auto text-warn">{problem}</span>}
        </div>
      </div>
    </div>
  );
}
