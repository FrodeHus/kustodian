import { Component, Suspense, lazy, useEffect, useRef, useState, type ReactNode } from 'react';
import { call } from './bridge';
import { blockAt } from './editor/block-at';
import type { KqlEditorHandle } from './editor/kql-editor';
import { ExplainView, type ExplainRequest } from './explain/explain-view';
import { SaveDialog } from './library/save-dialog';
import { openDroppedFile, openKqlFile, save, saveToFile } from './library/saving';
import { findParams } from './params/find-params';
import { ParamsForm } from './params/params-form';
import { EXPORT_FORMATS, EXPORT_NAMES, exportResult } from './results/export';
import { ResultPanel } from './results/result-panel';
import { RunStatus } from './results/run-status';
import { openRaw } from './raw/raw-request';
import { RawTab } from './raw/raw-tab';
import { startSessionSync } from './session/session-sync';
import { SettingsView } from './settings/settings-view';
import { bindGlobalKeys, registerCommands, runCommand, type Command } from './shell/commands';
import { errorText } from './shell/errors';
import { MOD } from './shell/keys';
import { Palette } from './shell/palette';
import { chooseTheme, useTheme, type Theme } from './shell/theme';
import { TitleBar } from './shell/title-bar';
import { SignIn } from './signin/sign-in';
import { PANELS, type PanelName } from './side/panels';
import { Rail, SidePanel } from './side/side-panel';
import { runParameters, sentText, useTabs, type RunMode, type Tab, type TabCursor } from './tabs/tab-store';
import { TabStrip } from './tabs/tab-strip';
import type { AccountList, SchemaView, SettingsAnswer } from './wire';

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

const activeTab = (): Tab | undefined => {
  const { tabs, activeId } = useTabs.getState();
  return tabs.find((t) => t.id === activeId);
};

/** The active tab's result, when its last run ended with rows to show. */
const activeResult = () => {
  const run = activeTab()?.run;
  return run?.state === 'done' && run.result?.outcome === 'ok' ? run.result : undefined;
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

/** The text Run sends from the tab: the selection, or else the block at the cursor. */
function runText(tab: Tab, cursor: TabCursor | undefined): string {
  return cursor?.selection ? cursor.selection : blockAt(tab.text, cursor?.line ?? 1).text;
}

/** What Explain describes for the tab: what Run would send (the selection, or else the block at the cursor) with its parameters. */
function explainRequest(tab: Tab, cursor: TabCursor | undefined): ExplainRequest {
  const { kql, origin } = sentText(tab, cursor, cursor?.selection ? 'selection' : 'block');
  return { kql, origin, parameters: runParameters(tab) };
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
  const [panel, setPanel] = useState<PanelName>('schema');
  const [paramsOpen, setParamsOpen] = useState(false);
  /** The tab the save dialog is open for. */
  const [saving, setSaving] = useState<string | null>(null);
  const [settings, setSettings] = useState<SettingsAnswer | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** The tab Explain is showing for, what it explains, and the run it was opened after: a later run shows its result instead. */
  const [explain, setExplain] = useState<{ tabId: string; request: ExplainRequest; runId: string | undefined } | null>(null);
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
    // The raw tab's default version and sign-in's default client; without them the built-in defaults apply.
    call<SettingsAnswer | null>('settings.get').then(
      (answer) => answer?.settings && setSettings(answer),
      (e: unknown) => setProblem(`The settings couldn’t be read: ${errorText(e)}`),
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
    const explainable = () => activeTab()?.source === 'graph';
    const withTab = (action: (tab: Tab) => void) => () => {
      const tab = activeTab();
      if (tab) {
        action(tab);
      }
    };
    const saveFailed = fail('The query couldn’t be saved');
    const panelCommands: Command[] = PANELS.map((p) => ({
      id: `panel.${p.name}`,
      title: `Show ${p.label}`,
      group: 'View',
      run: () => setPanel(p.name),
    }));
    const themeCommand = (t: Theme): Command => ({
      id: `theme.${t}`,
      title: `Theme: ${THEME_NAMES[t].toLowerCase()}`,
      group: 'Theme',
      run: () => void chooseTheme(t).catch(fail('The theme couldn’t be kept for the next start')),
    });
    const hasResult = () => activeResult() !== undefined;
    const exportCommands: Command[] = EXPORT_FORMATS.map((format) => ({
      id: `results.export.${format}`,
      title: `Export the result as ${EXPORT_NAMES[format]}`,
      group: 'Results',
      run: withTab((tab) => {
        const result = activeResult();
        if (result) {
          void exportResult(format, tab.title, result).catch(fail('The result couldn’t be exported'));
        }
      }),
      enabled: hasResult,
    }));
    const commands: Command[] = [
      { id: 'palette', title: 'Command palette', group: 'Window', shortcut: 'Mod+K, Mod+Shift+P', run: () => setPaletteOpen(true) },
      { id: 'tab.new', title: 'New Microsoft Graph query', group: 'Tabs', shortcut: 'Mod+T', run: () => useTabs.getState().open('graph') },
      { id: 'tab.newRaw', title: 'New raw Graph request', group: 'Tabs', run: () => openRaw() },
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
      {
        id: 'explain',
        title: 'Explain the query',
        group: 'Run',
        shortcut: 'Mod+E',
        run: withTab((tab) =>
          setExplain((open) =>
            open?.tabId === tab.id && open.runId === tab.run?.runId
              ? null
              : { tabId: tab.id, request: explainRequest(tab, useTabs.getState().cursors[tab.id]), runId: tab.run?.runId },
          ),
        ),
        enabled: explainable,
      },
      { id: 'settings.open', title: 'Settings', group: 'Window', shortcut: 'Mod+Comma', run: () => setSettingsOpen(true) },
      { id: 'editor.format', title: 'Format the query', group: 'Editor', shortcut: 'Shift+Alt+F', run: () => editor.current?.format(), enabled: runnable },
      {
        id: 'file.save',
        title: 'Save',
        group: 'File',
        shortcut: 'Mod+S',
        run: withTab((tab) => void save(tab.id).then((r) => r === 'dialog' && setSaving(tab.id), saveFailed)),
        enabled: runnable,
      },
      { id: 'file.saveAs', title: 'Save as', group: 'File', shortcut: 'Mod+Shift+S', run: withTab((tab) => setSaving(tab.id)), enabled: runnable },
      { id: 'file.saveToFile', title: 'Save to file', group: 'File', run: withTab((tab) => void saveToFile(tab.id).catch(saveFailed)), enabled: runnable },
      { id: 'file.open', title: 'Open .kql', group: 'File', shortcut: 'Mod+O', run: () => void openKqlFile().catch(fail('The file couldn’t be opened')) },
      ...exportCommands,
      { id: 'results.pin', title: 'Pin the result to compare', group: 'Results', run: withTab((tab) => useTabs.getState().pin(tab.id)), enabled: hasResult },
      {
        id: 'results.unpin',
        title: 'Unpin the compared result',
        group: 'Results',
        run: withTab((tab) => useTabs.getState().unpin(tab.id)),
        enabled: () => activeTab()?.pinned !== undefined,
      },
      ...panelCommands,
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

  // The window's shortcuts act on the workspace, so none fires while sign-in covers it or the palette is open (it handles
  // its own keys, Esc included).
  const shortcutsOn = useRef(false);
  useEffect(() => {
    shortcutsOn.current = !signingIn && !settingsOpen && !paletteOpen && saving === null;
  });
  useEffect(() => bindGlobalKeys(() => shortcutsOn.current), []);

  // A .kql file dropped on the window opens in a new tab. The page never lets the webview open a dropped file itself.
  useEffect(() => {
    const hasFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
    const onDragOver = (e: DragEvent) => {
      if (hasFiles(e)) {
        e.preventDefault();
      }
    };
    const onDrop = (e: DragEvent) => {
      const files = e.dataTransfer?.files;
      if (!files || files.length === 0) {
        return;
      }
      e.preventDefault();
      if (!shortcutsOn.current) {
        return;
      }
      for (const file of files) {
        openDroppedFile(file).catch((error: unknown) => setProblem(errorText(error)));
      }
    };
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('drop', onDrop);
    };
  }, []);

  const cursor = active ? cursors[active.id] : undefined;
  const raw = active?.source === 'raw';
  const paramCount = active && !raw ? findParams(active.text).length : 0;
  const explaining = active && explain?.tabId === active.id && explain.runId === active.run?.runId ? explain.request : null;
  // Schema and snippet text goes into the editor, never into a raw tab's path.
  const insert = (text: string) => (raw ? false : (editor.current?.insert(text) ?? false));
  const savingTab = tabs.find((t) => t.id === saving);

  return (
    <div className="flex h-full flex-col">
      <TitleBar account={account} onAccount={() => setAccountsOpen(true)} onSettings={() => setSettingsOpen(true)} />
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
          defaults={settings?.settings.signIn}
        />
      )}
      {settingsOpen && !signingIn && (
        <SettingsView
          onClose={() => {
            setSettingsOpen(false);
            editor.current?.focus();
          }}
          onChange={setSettings}
        />
      )}
      {/* Hidden rather than unmounted while signing in, so the editor keeps each tab's undo history. */}
      <div className="flex min-h-0 flex-1 flex-col" hidden={signingIn || settingsOpen}>
        <TabStrip />
        <div className="panes">
          <Rail panel={panel} onChoose={setPanel} />
          <SidePanel panel={panel} schema={schema} text={active?.text ?? ''} onInsert={insert} />
          <main className="workspace">
            {active ? (
              <>
                {!raw && (
                  <Toolbar
                    tab={active}
                    onRun={(mode) => runActive(mode)}
                    onFormat={() => editor.current?.format()}
                    paramCount={paramCount}
                    paramsOpen={paramsOpen}
                    onParams={() => setParamsOpen((o) => !o)}
                    explaining={explaining !== null}
                    onExplain={() => runCommand('explain')}
                  />
                )}
                {/* A raw tab has no query: the editor stays mounted for the other tabs, hidden. */}
                <div className="relative min-h-[160px] shrink-0 basis-[38%] border-b border-line" hidden={raw}>
                  <EditorFailed>
                    <Suspense fallback={<p className="faint m-0 p-4 text-[12px]">Loading the editor…</p>}>
                      <KqlEditor ref={editor} schema={schema} onRun={(mode) => void useTabs.getState().run(active.id, mode)} />
                    </Suspense>
                  </EditorFailed>
                </div>
                {raw ? (
                  <RawTab
                    key={active.id}
                    tab={active}
                    schema={schema}
                    defaultVersion={settings?.settings.rawDefaultVersion ?? 'beta'}
                    accountKey={account?.key}
                    onSignIn={() => setAccountsOpen(true)}
                  />
                ) : (
                  <>
                    {paramsOpen && paramCount > 0 && (
                      <div className="max-h-[50%] shrink-0 overflow-y-auto border-b border-line">
                        <ParamsForm tab={active} query={runText(active, cursor)} onRun={() => runActive('block')} />
                      </div>
                    )}
                    <RunStatus run={active.run} onSignIn={() => setAccountsOpen(true)} />
                    {explaining ? (
                      <ExplainView request={explaining} onOpenRaw={(url) => openRaw({ path: url, version: 'beta' })} />
                    ) : (
                      <Results tab={active} dialogOpen={paletteOpen || saving !== null} />
                    )}
                  </>
                )}
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
          {cursor && !raw && (
            <span>
              Ln {cursor.line}, Col {cursor.column}
            </span>
          )}
          <span>{raw ? 'Raw request' : 'KQL'}</span>
          {schema && (
            <span>
              Schema: {schema.source} · {formatDate(schema.generatedAt)}
            </span>
          )}
          <div className="grow" />
          <span title="Theme">{theme.theme === 'system' ? `System (${THEME_NAMES[theme.resolved]})` : THEME_NAMES[theme.theme]}</span>
        </footer>
      </div>
      {savingTab && (
        <SaveDialog
          tab={savingTab}
          onClose={() => {
            setSaving(null);
            editor.current?.focus();
          }}
        />
      )}
      {paletteOpen && (
        <Palette
          onClose={() => {
            setPaletteOpen(false);
            editor.current?.focus();
          }}
          onInsert={insert}
        />
      )}
    </div>
  );
}

interface ToolbarProps {
  tab: Tab;
  onRun: (mode: 'block' | 'all') => void;
  onFormat: () => void;
  /** How many parameters the query has: the Parameters button shows when it has any. */
  paramCount: number;
  paramsOpen: boolean;
  onParams: () => void;
  /** Explain is showing for the tab. The button is there on Graph tabs only. */
  explaining: boolean;
  onExplain: () => void;
}

function Toolbar({ tab, onRun, onFormat, paramCount, paramsOpen, onParams, explaining, onExplain }: ToolbarProps) {
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
      {tab.source === 'graph' && (
        <button type="button" className="btn" aria-pressed={explaining} title={`Explain the query (${MOD} E)`} onClick={onExplain}>
          Explain
        </button>
      )}
      {paramCount > 0 && (
        <button type="button" className="btn" aria-pressed={paramsOpen} onClick={onParams}>
          Parameters · {paramCount}
        </button>
      )}
    </div>
  );
}

function Results({ tab, dialogOpen }: { tab: Tab; dialogOpen: boolean }) {
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
  return <ResultPanel key={tab.id} tabId={tab.id} title={tab.title} kql={tab.run?.kql ?? tab.text} result={result} pinned={tab.pinned} dialogOpen={dialogOpen} />;
}
