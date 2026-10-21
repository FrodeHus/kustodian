import { useEffect, useRef, useState } from 'react';
import { openRaw } from '../raw/raw-request';
import { registerCommands, type Command } from '../shell/commands';
import { MOD } from '../shell/keys';
import type { Source } from '../wire';
import { SourceBadge } from './source-badge';
import { SOURCES } from './sources';
import { useTabs, type Tab } from './tab-store';

/** The sources a query tab can have, in the order the menus list them. */
const QUERY_SOURCES = ['graph', 'hunting', 'arg'] as const;

const activeTab = (): Tab | undefined => {
  const { tabs, activeId } = useTabs.getState();
  return tabs.find((t) => t.id === activeId);
};

/** "New Defender hunting query" and "New Resource Graph query", and "Change the source to …" for the active query tab. */
const sourceCommands = (): Command[] => [
  { id: 'tab.newHunting', title: 'New Defender hunting query', group: 'Tabs', shortcut: 'Mod+Shift+H', run: () => useTabs.getState().open('hunting') },
  { id: 'tab.newArg', title: 'New Resource Graph query', group: 'Tabs', shortcut: 'Mod+Shift+A', run: () => useTabs.getState().open('arg') },
  ...QUERY_SOURCES.map(
    (source): Command => ({
      id: `tab.source.${source}`,
      title: `Change the source to ${SOURCES[source].name}`,
      group: 'Tabs',
      run: () => {
        const tab = activeTab();
        if (tab) {
          useTabs.getState().setSource(tab.id, source);
        }
      },
      enabled: () => {
        const tab = activeTab();
        return !!tab && tab.source !== 'raw' && tab.source !== source;
      },
    }),
  ),
];

/** The open queries (spec 6.1): a tab each with its source badge and a dot while it has unsaved changes, and `+` for a new one.
 * `onDialog` is told when the close confirmation opens and closes: while it is open it is a modal dialog, so the window's
 * shortcuts are off. */
export function TabStrip({ onDialog }: { onDialog?: (open: boolean) => void } = {}) {
  const tabs = useTabs((s) => s.tabs);
  const activeId = useTabs((s) => s.activeId);
  const { open, close, activate } = useTabs.getState();
  const [menu, setMenu] = useState(false);
  const [closing, setClosing] = useState<Tab | null>(null);
  /** The tab whose badge menu ("Change source") is open, and where it opens. */
  const [picking, setPicking] = useState<{ id: string; left: number; top: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const pickRef = useRef<HTMLDivElement>(null);
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
        ...sourceCommands(),
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

  // The badge menu closes on a click outside it or Esc, never on blur (macOS WebKit doesn't focus a clicked button).
  useEffect(() => {
    if (!picking) {
      return;
    }
    pickRef.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
    const onDown = (e: MouseEvent) => {
      // A badge's own click opens or closes its menu.
      const onBadge = e.target instanceof Element && e.target.closest('.src-pick') !== null;
      if (!onBadge && (!(e.target instanceof Node) || !pickRef.current?.contains(e.target))) {
        setPicking(null);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setPicking(null);
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [picking]);

  const pickingTab = tabs.find((t) => t.id === picking?.id);

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
            {tab.source !== 'raw' && (
              <button
                type="button"
                className="src-pick"
                aria-label={`Source: ${SOURCES[tab.source].name}. Change source`}
                aria-haspopup="menu"
                aria-expanded={picking?.id === tab.id}
                onMouseDown={(e) => e.preventDefault()}
                onClick={(e) => {
                  const at = e.currentTarget.getBoundingClientRect();
                  setPicking((p) => (p?.id === tab.id ? null : { id: tab.id, left: at.left, top: at.bottom + 4 }));
                }}
              >
                <SourceBadge source={tab.source} titled />
              </button>
            )}
            <button type="button" role="tab" aria-selected={tab.id === activeId} onClick={() => activate(tab.id)}>
              {tab.source === 'raw' && <SourceBadge source={tab.source} titled />}
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
          <div className="menu" role="menu" aria-label="New tab" style={{ left: 0, top: 34, width: 340 }} onMouseDown={(e) => e.preventDefault()}>
            <button type="button" role="menuitem" onClick={() => openNew('graph')}>
              <SourceBadge source="graph" />
              Microsoft Graph query
              <span className="grow" />
              <span className="kbd">{MOD} T</span>
            </button>
            <button type="button" role="menuitem" onClick={() => openNew('hunting')}>
              <SourceBadge source="hunting" />
              Defender hunting query
              <span className="grow" />
              <span className="kbd">{MOD} Shift H</span>
            </button>
            <button type="button" role="menuitem" onClick={() => openNew('arg')}>
              <SourceBadge source="arg" />
              Resource Graph query
              <span className="grow" />
              <span className="kbd">{MOD} Shift A</span>
            </button>
            <button type="button" role="menuitem" onClick={() => openNew('raw')}>
              <SourceBadge source="raw" />
              Raw Graph request
            </button>
          </div>
        )}
      </div>
      {pickingTab && pickingTab.source !== 'raw' && (
        <div
          ref={pickRef}
          className="menu"
          role="menu"
          aria-label="Change source"
          style={{ position: 'fixed', left: picking?.left, top: picking?.top, width: 290 }}
          onMouseDown={(e) => e.preventDefault()}
          onKeyDown={(e) => {
            if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') {
              return;
            }
            e.preventDefault();
            const items = [...(pickRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? [])];
            const at = items.findIndex((b) => b === document.activeElement);
            items[(at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
          }}
        >
          <span className="faint px-2.5 pt-1 pb-0.5 text-[11px] font-semibold uppercase">Change source</span>
          {QUERY_SOURCES.map((source) => (
            <button
              key={source}
              type="button"
              role="menuitemradio"
              aria-checked={pickingTab.source === source}
              className={pickingTab.source === source ? 'on' : undefined}
              onClick={() => {
                useTabs.getState().setSource(pickingTab.id, source);
                setPicking(null);
              }}
            >
              <SourceBadge source={source} />
              {SOURCES[source].name}
              <span className="grow" />
              {pickingTab.source === source && <span aria-hidden="true">✓</span>}
            </button>
          ))}
        </div>
      )}
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
