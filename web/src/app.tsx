import { Component, Suspense, lazy, useEffect, useRef, useState, type ReactNode } from 'react';
import { call } from './bridge';
import type { KqlEditorHandle } from './editor/kql-editor';
import { ResultGrid } from './results/result-grid';
import { RunStatus } from './results/run-status';
import { SchemaPanel } from './schema/schema-panel';
import { startSessionSync } from './session/session-sync';
import { bindGlobalKeys, registerCommands, type Command } from './shell/commands';
import { MOD } from './shell/keys';
import { Palette } from './shell/palette';
import { chooseTheme, useTheme, type Theme } from './shell/theme';
import { TitleBar } from './shell/title-bar';
import { SignIn } from './signin/sign-in';
import { useTabs, type RunMode, type Tab } from './tabs/tab-store';
import { TabStrip } from './tabs/tab-strip';
import type { AccountList, SchemaView } from './wire';

// Monaco and the Kusto language service are several megabytes: a chunk of their own, loaded after the window is up.
const KqlEditor = lazy(() => import('./editor/kql-editor'));

class EditorFailed extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <p className="m-0 p-4 text-[12px] text-bad" role="alert">
        The editor couldn’t be loaded. Restart Kustodian to try again.
      </p>
    ) : (
      this.props.children
    );
  }
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

const activeTab = (): Tab | undefined => {
  const { tabs, activeId } = useTabs.getState();
  return tabs.find((t) => t.id === activeId);
};

/** Runs the active tab: `block` runs the selection instead when there is one. */
function runActive(mode: 'block' | 'all', refresh = false) {
  const tab = activeTab();
  if (!tab) {
    return;
  }
  const selected = mode === 'block' && (useTabs.getState().cursors[tab.id]?.selection ?? '') !== '';
  const run: RunMode = selected ? 'selection' : mode;
  void useTabs.getState().run(tab.id, run, { refresh });
}

/** Activates the tab `step` places along, wrapping around. */
function cycleTab(step: number) {
  const { tabs, activeId, activate } = useTabs.getState();
  const index = tabs.findIndex((t) => t.id === activeId);
  const next = tabs[(index + step + tabs.length) % tabs.length];
  if (next) {
    activate(next.id);
  }
}

const THEME_NAMES: Record<Theme, string> = { dark: 'Dark', light: 'Light', system: 'System' };

/** Reads the accounts; resolves whether that worked. A failure is reported as the sign-in screen's error line. */
function readAccounts(onList: (list: AccountList) => void, onError: (text: string | null) => void): Promise<boolean> {
  return call<AccountList>('account.list').then(
    (list) => {
      onList(list);
      onError(null);
      return true;
    },
    (e: unknown) => {
      onError(`The accounts couldn’t be read: ${errorText(e)}`);
      return false;
    },
  );
}

/** The main window (spec 6.1, mockup Main), or sign-in when no account is active (mockup SignIn). */
export function App() {
  const [accounts, setAccounts] = useState<AccountList | null>(null);
  const [schema, setSchema] = useState<SchemaView | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [accountsOpen, setAccountsOpen] = useState(false);
  const [accountsError, setAccountsError] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const editor = useRef<KqlEditorHandle>(null);
  const theme = useTheme();

  const tabs = useTabs((s) => s.tabs);
  const activeId = useTabs((s) => s.activeId);
  const cursors = useTabs((s) => s.cursors);
  const active = tabs.find((t) => t.id === activeId);

  const refreshAccounts = () => readAccounts(setAccounts, setAccountsError);

  useEffect(() => {
    void readAccounts(setAccounts, setAccountsError);
    call<SchemaView>('schema.get', { source: 'graph' }).then(setSchema, (e: unknown) =>
      setProblem(`The Graph schema couldn’t be loaded: ${errorText(e)}`),
    );
  }, []);

  // The last session's tabs come back, or one empty Graph tab.
  useEffect(() => startSessionSync(setProblem), []);

  useEffect(() => {
    const fail = (what: string) => (e: unknown) => setProblem(`${what}: ${errorText(e)}`);
    const runnable = () => {
      const tab = activeTab();
      return !!tab && tab.source !== 'raw';
    };
    const themeCommand = (t: Theme): Command => ({
      id: `theme.${t}`,
      title: `Theme: ${THEME_NAMES[t].toLowerCase()}`,
      group: 'Theme',
      run: () => void chooseTheme(t).catch(fail('The theme couldn’t be kept for the next start')),
    });
    const commands: Command[] = [
      { id: 'palette', title: 'Command palette', group: 'Window', shortcut: 'Mod+K, Mod+Shift+P', run: () => setPaletteOpen(true) },
      { id: 'tab.new', title: 'New Microsoft Graph query', group: 'Tabs', shortcut: 'Mod+T', run: () => useTabs.getState().open('graph') },
      { id: 'tab.next', title: 'Next tab', group: 'Tabs', shortcut: 'Ctrl+Tab', run: () => cycleTab(1), enabled: () => useTabs.getState().tabs.length > 1 },
      { id: 'tab.previous', title: 'Previous tab', group: 'Tabs', shortcut: 'Ctrl+Shift+Tab', run: () => cycleTab(-1), enabled: () => useTabs.getState().tabs.length > 1 },
      { id: 'run.block', title: 'Run the block at the cursor', group: 'Run', shortcut: 'Mod+Enter', run: () => runActive('block'), enabled: runnable },
      { id: 'run.all', title: 'Run all', group: 'Run', shortcut: 'Shift+Enter', run: () => runActive('all'), enabled: runnable },
      { id: 'run.refresh', title: 'Run without cache', group: 'Run', shortcut: 'Mod+Shift+Enter', run: () => runActive('block', true), enabled: runnable },
      {
        id: 'run.cancel',
        title: 'Cancel the run',
        group: 'Run',
        shortcut: 'Mod+.',
        run: () => {
          const tab = activeTab();
          if (tab) {
            useTabs.getState().cancel(tab.id);
          }
        },
        enabled: () => activeTab()?.run?.state === 'running',
      },
      { id: 'editor.format', title: 'Format the query', group: 'Editor', shortcut: 'Shift+Alt+F', run: () => editor.current?.format(), enabled: runnable },
      themeCommand('dark'),
      themeCommand('light'),
      themeCommand('system'),
      {
        id: 'cache.clear',
        title: 'Clear the cache',
        group: 'Graph',
        run: () => void call('cache.clear').catch(fail('The cache couldn’t be cleared')),
      },
    ];
    return registerCommands(commands);
  }, []);

  const account = accounts?.accounts.find((a) => a.active);
  // Unreadable accounts also mean sign-in: it shows why, and signing in reads them again.
  const signingIn = accountsError !== null || (accounts !== null && (!account || accountsOpen));

  // The window's shortcuts act on the workspace, so none fires while sign-in covers it.
  const shortcutsOn = useRef(false);
  useEffect(() => {
    shortcutsOn.current = !signingIn;
  });
  useEffect(() => bindGlobalKeys(() => shortcutsOn.current), []);

  const cursor = active ? cursors[active.id] : undefined;

  return (
    <div className="flex h-full flex-col">
      <TitleBar account={account} onAccount={() => setAccountsOpen(true)} />
      {problem && (
        <div className="flex items-center gap-3 border-b border-line bg-bad-soft px-3 py-1.5 text-[12px] text-bad" role="alert">
          {problem}
          <div className="grow" />
          <button type="button" className="btn ghost" onClick={() => setProblem(null)}>
            Dismiss
          </button>
        </div>
      )}
      {signingIn && (
        <SignIn
          list={accounts}
          error={accountsError}
          onChanged={(done) => {
            // The screen closes only once the accounts were read again.
            void refreshAccounts().then((read) => {
              if (done && read) {
                setAccountsOpen(false);
              }
            });
          }}
          onBack={account && !accountsError ? () => setAccountsOpen(false) : undefined}
        />
      )}
      {/* Hidden rather than unmounted while signing in, so the editor keeps each tab's undo history. */}
      <div className="flex min-h-0 flex-1 flex-col" hidden={signingIn}>
        <TabStrip />
        <div className="panes">
          <nav className="rail" aria-label="Side panels">
            <button type="button" aria-pressed="true" aria-label="Schema" title="Schema">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                <ellipse cx="12" cy="5" rx="8" ry="3" />
                <path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5" />
                <path d="M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" />
              </svg>
            </button>
          </nav>
          <SchemaPanel schema={schema} text={active?.text ?? ''} onInsert={(name) => editor.current?.insert(name)} />
          <main className="workspace">
            {active ? (
              <>
                <Toolbar tab={active} onRun={(mode) => runActive(mode)} onFormat={() => editor.current?.format()} />
                <div className="relative min-h-[160px] shrink-0 basis-[38%] border-b border-line">
                  <EditorFailed>
                    <Suspense fallback={<p className="faint m-0 p-4 text-[12px]">Loading the editor…</p>}>
                      <KqlEditor ref={editor} schema={schema} onRun={(mode) => void useTabs.getState().run(active.id, mode)} />
                    </Suspense>
                  </EditorFailed>
                </div>
                <RunStatus run={active.run} onSignIn={() => setAccountsOpen(true)} />
                <Results tab={active} />
              </>
            ) : (
              <div className="flex flex-1 flex-col items-center justify-center gap-3">
                <span className="muted">No query open.</span>
                <button type="button" className="btn primary" onClick={() => useTabs.getState().open('graph')}>
                  New Microsoft Graph query
                </button>
              </div>
            )}
          </main>
        </div>
        <footer className="statusbar">
          {cursor && (
            <span>
              Ln {cursor.line}, Col {cursor.column}
            </span>
          )}
          <span>KQL</span>
          {schema && (
            <span>
              Schema: {schema.source} · {formatDate(schema.generatedAt)}
            </span>
          )}
          <div className="grow" />
          <span title="Theme">{theme.theme === 'system' ? `System (${THEME_NAMES[theme.resolved]})` : THEME_NAMES[theme.theme]}</span>
        </footer>
      </div>
      {paletteOpen && (
        <Palette
          onClose={() => {
            setPaletteOpen(false);
            editor.current?.focus();
          }}
          onInsert={(text) => editor.current?.insert(text)}
        />
      )}
    </div>
  );
}

function Toolbar({ tab, onRun, onFormat }: { tab: Tab; onRun: (mode: 'block' | 'all') => void; onFormat: () => void }) {
  const running = tab.run?.state === 'running';
  return (
    <div className="toolbar">
      <button type="button" className="btn primary" onClick={() => onRun('block')}>
        <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M6 4v16l14-8z" />
        </svg>
        Run
      </button>
      <span className="faint text-[12px]">the block at the cursor</span>
      <span className="kbd">{MOD} Enter</span>
      <button type="button" className="btn ghost" onClick={() => onRun('all')}>
        Run all <span className="kbd">Shift Enter</span>
      </button>
      <span className="sep" aria-hidden="true" />
      <button type="button" className="btn" disabled={!running} onClick={() => useTabs.getState().cancel(tab.id)}>
        Cancel
      </button>
      <button type="button" className="btn ghost" onClick={onFormat}>
        Format
      </button>
    </div>
  );
}

function Results({ tab }: { tab: Tab }) {
  const result = tab.run?.state === 'done' ? tab.run.result : undefined;
  if (!result || result.outcome !== 'ok') {
    return (
      <div className="flex flex-1 items-center justify-center">
        <span className="faint text-[12px]">
          {tab.run?.state === 'running' ? 'Running…' : `Run a query with ${MOD} Enter. Its rows show here.`}
        </span>
      </div>
    );
  }
  return <ResultGrid key={tab.id} columns={result.columns} rows={result.rows} />;
}
