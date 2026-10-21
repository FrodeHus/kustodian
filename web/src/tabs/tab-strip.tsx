import { useEffect, useRef, useState } from 'react';
import { openRaw } from '../raw/raw-request';
import { registerCommands } from '../shell/commands';
import { MOD } from '../shell/keys';
import type { Source } from '../wire';
import { useTabs, type Tab } from './tab-store';

const SOURCES: Record<Source, { badge: string; className: string; name: string }> = {
  graph: { badge: 'GR', className: 'graph', name: 'Microsoft Graph' },
  hunting: { badge: 'AH', className: 'hunt', name: 'Defender advanced hunting' },
  arg: { badge: 'ARG', className: 'arg', name: 'Azure Resource Graph' },
  raw: { badge: 'GR', className: 'graph', name: 'Raw Graph request' },
};

function SourceBadge({ source, titled = false }: { source: Source; titled?: boolean }) {
  const s = SOURCES[source];
  return (
    <span className={`src ${s.className}`} title={titled ? s.name : undefined}>
      {s.badge}
    </span>
  );
}

/** The open queries (spec 6.1): a tab each with its source badge and a dot while it has unsaved changes, and `+` for a new one.
 * `onDialog` is told when the close confirmation opens and closes: while it is open it is a modal dialog, so the window's
 * shortcuts are off. */
export function TabStrip({ onDialog }: { onDialog?: (open: boolean) => void } = {}) {
  const tabs = useTabs((s) => s.tabs);
  const activeId = useTabs((s) => s.activeId);
  const { open, close, activate } = useTabs.getState();
  const [menu, setMenu] = useState(false);
  const [closing, setClosing] = useState<Tab | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const confirming = closing !== null;

  useEffect(() => {
    onDialog?.(confirming);
  }, [confirming, onDialog]);

  // Closing from the keyboard asks first too, so the command lives with the confirmation.
  useEffect(
    () =>
      registerCommands([
        {
          id: 'tab.close',
          title: 'Close the tab',
          group: 'Tabs',
          shortcut: 'Mod+W',
          run: () => {
            const { tabs: open, activeId: id } = useTabs.getState();
            const tab = open.find((t) => t.id === id);
            if (tab?.dirty) {
              setClosing(tab);
            } else if (tab) {
              useTabs.getState().close(tab.id);
            }
          },
          enabled: () => useTabs.getState().activeId !== null,
        },
      ]),
    [],
  );

  useEffect(() => {
    if (!menu) {
      return;
    }
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    const onDown = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) {
        setMenu(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMenu(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menu]);

  const requestClose = (tab: Tab) => {
    if (tab.dirty) {
      setClosing(tab);
    } else {
      close(tab.id);
    }
  };

  const openNew = (source: Source) => {
    setMenu(false);
    if (source === 'raw') {
      openRaw();
    } else {
      open(source);
    }
  };

  return (
    <div className="tabs">
      <div role="tablist" aria-label="Open queries" className="flex items-end gap-0.5 overflow-x-auto">
        {tabs.map((tab) => (
          <div key={tab.id} className={`tab${tab.id === activeId ? ' on' : ''}`}>
            <button type="button" role="tab" aria-selected={tab.id === activeId} onClick={() => activate(tab.id)}>
              <SourceBadge source={tab.source} titled />
              <span className="whitespace-nowrap">{tab.title}</span>
              {tab.dirty && <span className="mod" aria-label="Unsaved changes" role="img" />}
            </button>
            <button
              type="button"
              className="x"
              aria-label={`Close ${tab.title}`}
              onClick={() => requestClose(tab)}
              onMouseDown={(e) => e.preventDefault()}
            >
              ×
            </button>
          </div>
        ))}
      </div>
      <div className="relative" ref={menuRef}>
        <button type="button" className="tab-add" aria-label="New tab" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((m) => !m)}>
          +
        </button>
        {menu && (
          <div className="menu" role="menu" aria-label="New tab" style={{ left: 0, top: 34, width: 300 }}>
            <button type="button" role="menuitem" onClick={() => openNew('graph')}>
              <SourceBadge source="graph" />
              Microsoft Graph query
              <span className="grow" />
              <span className="kbd">{MOD} T</span>
            </button>
            <button type="button" role="menuitem" onClick={() => openNew('raw')}>
              <SourceBadge source="raw" />
              Raw Graph request
            </button>
          </div>
        )}
      </div>
      {closing && (
        <ConfirmClose
          tab={closing}
          onKeep={() => setClosing(null)}
          onClose={() => {
            close(closing.id);
            setClosing(null);
          }}
        />
      )}
    </div>
  );
}

/** Asks before closing a tab with unsaved changes. A modal: Tab and Shift+Tab go round its two buttons, and focus that lands
 * outside it (a click on the page behind) goes back to "Keep it open". */
function ConfirmClose({ tab, onKeep, onClose }: { tab: Tab; onKeep: () => void; onClose: () => void }) {
  const dialog = useRef<HTMLDivElement>(null);
  const keep = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    keep.current?.focus();
    const onFocusIn = (e: FocusEvent) => {
      if (!(e.target instanceof Node) || !dialog.current?.contains(e.target)) {
        keep.current?.focus();
      }
    };
    document.addEventListener('focusin', onFocusIn);
    return () => document.removeEventListener('focusin', onFocusIn);
  }, []);

  return (
    <div className="fixed inset-0 z-10">
      <div className="scrim" onClick={onKeep} />
      <div
        ref={dialog}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-close-title"
        className="card absolute top-1/3 left-1/2 flex w-[420px] -translate-x-1/2 flex-col gap-3 p-5"
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            onKeep();
          } else if (e.key === 'Tab') {
            const buttons = [...(dialog.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])];
            const at = buttons.findIndex((b) => b === document.activeElement);
            e.preventDefault();
            buttons[(at + (e.shiftKey ? -1 : 1) + buttons.length) % buttons.length]?.focus();
          }
        }}
      >
        <b id="confirm-close-title" className="text-[14px]">
          Close {tab.title}?
        </b>
        <span className="muted">It has changes that aren’t saved. Closing it loses them.</span>
        <div className="flex justify-end gap-2">
          <button ref={keep} type="button" className="btn" onClick={onKeep}>
            Keep it open
          </button>
          <button type="button" className="btn primary" onClick={onClose}>
            Close without saving
          </button>
        </div>
      </div>
    </div>
  );
}
