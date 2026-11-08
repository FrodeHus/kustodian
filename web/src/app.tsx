import { Component, Suspense, lazy, useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { call } from './bridge';
import { blockAt } from './editor/block-at';
import type { KqlEditorHandle } from './editor/kql-editor';
import { ExplainView, type ExplainRequest } from './explain/explain-view';
import { SaveDialog } from './library/save-dialog';
import { SaveWorkbookDialog } from './workbooks/save-workbook-dialog';
import { ImportReview } from './workbooks/import-review';
import { SolutionDialog } from './solutions/solution-dialog';
import { useSolutionDialog } from './solutions/solution-store';
import { importWorkbook, useImportReview } from './workbooks/sharing';
import { saveWorkbook, startWorkbookTabs } from './workbooks/workbook-store';
import { newerRelease } from './settings/update-check';
import { UpdateDialog } from './settings/update-dialog';
import { openDroppedFile, openKqlFile, save, saveToFile } from './library/saving';
import { findParams } from './params/find-params';
import { ParamsForm } from './params/params-form';
import { DiagnosticsView } from './results/diagnostics-view';
import { EXPORT_FORMATS, EXPORT_NAMES, exportResult } from './results/export';
import { ResultPanel } from './results/result-panel';
import { RunStatus } from './results/run-status';
import { openRaw } from './raw/raw-request';
import { RawTab } from './raw/raw-tab';
import { schemaSourceOf, startSchemaLoading, useSchemas } from './schema/schema-store';
import { startSessionSync } from './session/session-sync';
import { SettingsView } from './settings/settings-view';
import { ErrorReportsDialog } from './settings/error-reports';
import { TelemetryDialog } from './settings/telemetry';
import { bindGlobalKeys, registerCommands, runCommand, type Command } from './shell/commands';
import { errorText } from './shell/errors';
import { ErrorBoundary, ErrorReportActions, type Shown } from './shell/error-report';
import { reportIdOf } from './shell/report-id';
import { MOD, SHIFT } from './shell/keys';
import { Palette } from './shell/palette';
import { canCreateApp } from './signin/permission-plan';
import { THEMES, chooseTheme, themeName, useTheme, type Theme } from './shell/theme';
import { TitleBar } from './shell/title-bar';
import { SignIn } from './signin/sign-in';
import { PANELS, type PanelName } from './side/panels';
import { Rail, SidePanel } from './side/side-panel';
import { Splitter } from './shell/splitter';
import { runParameters, sentText, useTabs, type RunMode, type Tab, type TabCursor } from './tabs/tab-store';
import { TabStrip } from './tabs/tab-strip';
import { SaveButton } from './toolbar/save-button';
import { ScopePicker } from './toolbar/scope-picker';
import { TimespanPicker } from './toolbar/timespan-picker';
import type { AccountList, QueryOptions, SchemaView, SettingsAnswer, Source, TabSource, UpdateInfo } from './wire';

// Monaco and the Kusto language service are several megabytes: a chunk of their own, loaded after the window is up.
const KqlEditor = lazy(() => import('./editor/kql-editor'));
const WorkbookView = lazy(() => import('./workbooks/workbook-view').then((m) => ({ default: m.WorkbookView })));

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

/** Advanced hunting's footer text says where its schema came from, without the fallback reason's closing "The built-in schema
 * is shown." (the footer says so). */
function builtInReason(reason: string | null): string {
  return (reason ?? 'not read').replace(/\s*The built-in schema is shown\.?$/, '').replace(/\.$/, '');
}

/** The status bar's schema text for the source (spec 8: the hunting footer says where the schema came from). */
function schemaFooter(source: Source, view: SchemaView | undefined, resourceTypes: string[] | undefined): string | null {
  if (source === 'arg') {
    return resourceTypes ? `Resource Graph tables · ${resourceTypes.length.toLocaleString('en-US')} resource types` : 'Resource Graph tables';
  }
  if (!view) {
    return null;
  }
  if (source === 'hunting') {
    if (view.origin !== 'tenant') {
      return `Built-in schema (${builtInReason(view.fallbackReason)})`;
    }
    const tenant = `Schema from your tenant (getHuntingSchema) · ${formatDate(view.generatedAt)}`;
    // A refresh that failed keeps the tenant's schema read before, and says why it wasn't renewed.
    const refresh = view.fallbackReason?.replace(/\s*The schema read earlier is shown\.?$/, '').replace(/\.$/, '');
    return refresh ? `${tenant} · ${refresh}` : tenant;
  }
  // The full source (metadata commit, permissions URL) is the span's tooltip; it's too long for the status bar.
  return `Built-in Graph schema · ${formatDate(view.generatedAt)}`;
}

/** What the status bar calls the active tab's language. */
const LANGUAGE: Record<TabSource, string> = { graph: 'KQL', hunting: 'KQL · advanced hunting', arg: 'KQL · Resource Graph', raw: 'Raw request', workbook: 'Workbook' };

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

/** The status bar's line and column; its own subscriber, so a cursor move re-renders only this. */
function CursorPosition({ tabId }: { tabId: string }) {
  const cursor = useTabs((s) => s.cursors[tabId]);
  return cursor ? (
    <span>
      Ln {cursor.line}, Col {cursor.column}
    </span>
  ) : null;
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


/** What the window says at startup when the settings file couldn't be used, or null when it could. */
function settingsNotice(answer: SettingsAnswer): string | null {
  if (answer.corrupt) {
    return 'The settings file couldn’t be read, so it was set aside and the defaults are in use.';
  }
  return answer.unreadable ? 'The settings file couldn’t be read, so the defaults are in use.' : null;
}

/** Reads the accounts; resolves whether that worked. A failure is reported as the sign-in screen's error line. */
function readAccounts(onList: (list: AccountList) => void, onError: (error: Shown | null) => void): Promise<boolean> {
  return call<AccountList>('account.list').then(
    (list) => {
      onList(list);
      onError(null);
      return true;
    },
    (e: unknown) => {
      onError({ text: `The accounts couldn’t be read: ${errorText(e)}`, reportId: reportIdOf(e) });
      return false;
    },
  );
}

/** The main window (spec 6.1, mockup Main), or sign-in when no account is active (mockup SignIn). */
export function App() {
  const [accounts, setAccounts] = useState<AccountList | null>(null);
  const [problem, setProblemState] = useState<{ text: string; reportId?: string } | null>(null);
  const setProblem = useCallback((text: string | null, reportId?: string) => setProblemState(text ? { text, reportId } : null), []);
  /** A notice that stays for the rest of the window's life: it has no Dismiss. */
  const [lasting, setLasting] = useState<string | null>(null);
  const [accountsOpen, setAccountsOpen] = useState(false);
  /** "Create Entra ID application" is open over the sign-in screen. */
  const [createAppOpen, setCreateAppOpen] = useState(false);
  const createAppAllowed = useRef(false);
  const [accountsError, setAccountsError] = useState<Shown | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [panel, setPanel] = useState<PanelName>('schema');
  // Dragged sizes in px; null keeps the stylesheet's.
  const [sideWidth, setSideWidth] = useState<number | null>(null);
  const [editorHeight, setEditorHeight] = useState<number | null>(null);
  /** A workbook tab's side panel: none until one is chosen on the rail, so the workbook gets the width. */
  const [workbookPanel, setWorkbookPanel] = useState<PanelName | null>(null);
  const [paramsOpen, setParamsOpen] = useState(false);
  /** The tab the save dialog is open for. */
  const [saving, setSaving] = useState<string | null>(null);
  const [settings, setSettings] = useState<SettingsAnswer | null>(null);
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [telemetryClosed, setTelemetryClosed] = useState(false);
  const [errorReportsClosed, setErrorReportsClosed] = useState(false);
  /** The tab strip's close confirmation is open: a modal dialog. */
  const [confirming, setConfirming] = useState(false);
  const paletteShown = useRef(false);
  const settingsShown = useRef(false);
  /** The tab Explain is showing for, what it explains, and the run it was opened after: a later run shows its result instead. */
  const [explain, setExplain] = useState<{ tabId: string; request: ExplainRequest; runId: string | undefined } | null>(null);
  /** The toolbar picker that is open: the hunting tab's timespan or the Resource Graph tab's scope. */
  const [picker, setPicker] = useState<'timespan' | 'scope' | null>(null);
  const editor = useRef<KqlEditorHandle>(null);
  const theme = useTheme();

  const tabs = useTabs((s) => s.tabs);
  const activeId = useTabs((s) => s.activeId);
  const active = tabs.find((t) => t.id === activeId);
  // Selects the text Run would send, not the cursor: moving within a block doesn't re-render the app.
  const runnableText = useTabs((s) => (active ? runText(active, s.cursors[active.id]) : ''));

  useEffect(() => {
    void readAccounts(setAccounts, setAccountsError);
    // The raw tab's default version and sign-in's default client; without them the built-in defaults apply.
    call<SettingsAnswer | null>('settings.get').then(
      (answer) => {
        if (answer?.settings) {
          setSettings(answer);
          const notice = settingsNotice(answer);
          if (notice) {
            setProblem(notice);
          }
        }
      },
      (e: unknown) => setProblem(`The settings couldn’t be read: ${errorText(e)}`, reportIdOf(e)),
    );
  }, [setProblem]);
  // Offline or GitHub down: no dialog, and nothing to say about it.
  useEffect(() => void newerRelease().then(setUpdate, () => undefined), []);

  // The last session's tabs come back, or one empty Graph tab.
  useEffect(() => startSessionSync(setProblem, setLasting), [setProblem]);
  // Workbook tabs load their workbook when they open and keep its unsaved changes in the tab.
  useEffect(() => startWorkbookTabs(setProblem), [setProblem]);
  // Explain closes when its tab's source changes from Graph, so coming back to Graph doesn't explain the query again unasked.
  useEffect(
    () =>
      useTabs.subscribe((state, previous) => {
        if (state.tabs !== previous.tabs) {
          setExplain((open) => (open && state.tabs.find((t) => t.id === open.tabId)?.source !== 'graph' ? null : open));
        }
        // A picker closes when another tab comes forward, or its tab's source changes.
        if (state.activeId !== previous.activeId) {
          setPicker(null);
          // The parameters view belongs to the tab it was opened on: another tab comes forward with its editor.
          setParamsOpen(false);
        } else if (state.tabs !== previous.tabs) {
          const source = state.tabs.find((t) => t.id === state.activeId)?.source;
          setPicker((open) => (open === (source === 'hunting' ? 'timespan' : source === 'arg' ? 'scope' : null) ? open : null));
        }
      }),
    [],
  );
  // Each source's schema is read when its first tab opens. Graph's failing is said in the window, as it always was.
  useEffect(() => {
    const stopLoading = startSchemaLoading();
    const stopWatching = useSchemas.subscribe((s, previous) => {
      if (s.errors.graph && s.errors.graph !== previous.errors.graph) {
        setProblem(`The Graph schema couldn’t be loaded: ${s.errors.graph}`, s.errorReportIds.graph);
      }
    });
    return () => {
      stopLoading();
      stopWatching();
    };
  }, [setProblem]);

  useEffect(() => {
    const fail = (what: string) => (e: unknown) => setProblem(`${what}: ${errorText(e)}`, reportIdOf(e));
    const runnable = () => {
      const tab = activeTab();
      return !!tab && tab.source !== 'raw' && tab.source !== 'workbook';
    };
    const explainable = () => activeTab()?.source === 'graph';
    const withTab = (action: (tab: Tab) => void) => () => {
      const tab = activeTab();
      if (tab) {
        action(tab);
      }
    };
    const saveFailed = fail('The query couldn’t be saved');
    // A workbook's first save asks its name and folder; later ones write it.
    const saveTab = (tab: Tab) => {
      if (tab.source !== 'workbook') {
        void save(tab.id).then((r) => r === 'dialog' && setSaving(tab.id), saveFailed);
      } else if (tab.savedId) {
        void saveWorkbook(tab.id).catch(fail('The workbook couldn’t be saved'));
      } else {
        setSaving(tab.id);
      }
    };
    const panelCommands: Command[] = PANELS.map((p) => ({
      id: `panel.${p.name}`,
      title: `Show ${p.label}`,
      group: 'View',
      run: () => {
        const { tabs, activeId } = useTabs.getState();
        if (tabs.find((t) => t.id === activeId)?.source === 'workbook') {
          setWorkbookPanel(p.name);
        } else {
          setPanel(p.name);
        }
      },
    }));
    const themeCommand = (t: Theme): Command => ({
      id: `theme.${t}`,
      title: `Theme: ${themeName(t)}`,
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
      {
        id: 'palette',
        title: 'Command palette',
        group: 'Window',
        shortcut: 'Mod+K, Mod+Shift+P',
        run: () => setPaletteOpen(true),
        // It lists itself: chosen from the open palette it would only open it again.
        enabled: () => !paletteShown.current,
      },
      {
        id: 'account.createEntraApp',
        title: 'Create Entra ID application',
        group: 'Account',
        run: () => {
          // From Settings the dialog opens there; from anywhere else it opens over the sign-in screen.
          if (!settingsShown.current) {
            setAccountsOpen(true);
          }
          setCreateAppOpen(true);
        },
        enabled: () => createAppAllowed.current,
      },
      { id: 'tab.new', title: 'New Microsoft Graph query', group: 'Tabs', shortcut: 'Mod+T', run: () => useTabs.getState().open('graph') },
      { id: 'tab.newRaw', title: 'New raw Graph request', group: 'Tabs', run: () => openRaw() },
      { id: 'tab.newWorkbook', title: 'New workbook', group: 'Tabs', run: () => void useTabs.getState().openWorkbook() },
      { id: 'workbook.import', title: 'Import workbook…', group: 'Tabs', run: () => void importWorkbook().catch(fail('The workbook couldn’t be imported')) },
      {
        id: 'schema.refresh',
        title: 'Refresh schema',
        group: 'View',
        run: withTab((tab) => void useSchemas.getState().load(schemaSourceOf(tab.source), { refresh: true })),
        enabled: () => activeTab() !== undefined,
      },
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
      {
        id: 'params.toggle',
        title: 'Show or hide the parameters',
        group: 'Editor',
        run: () => setParamsOpen((open) => !open),
        enabled: () => {
          const tab = activeTab();
          return !!tab && tab.source !== 'raw' && findParams(tab.text).length > 0;
        },
      },
      { id: 'toolbar.timespan', title: 'Pick timespan', group: 'Run', run: () => setPicker('timespan'), enabled: () => activeTab()?.source === 'hunting' },
      { id: 'toolbar.scope', title: 'Pick scope', group: 'Run', run: () => setPicker('scope'), enabled: () => activeTab()?.source === 'arg' },
      { id: 'settings.open', title: 'Settings', group: 'Window', shortcut: 'Mod+Comma', run: () => setSettingsOpen(true) },
      { id: 'editor.format', title: 'Format the query', group: 'Editor', shortcut: 'Shift+Alt+F', run: () => editor.current?.format(), enabled: runnable },
      {
        id: 'file.save',
        title: 'Save',
        group: 'File',
        shortcut: 'Mod+S',
        run: withTab(saveTab),
        enabled: () => runnable() || activeTab()?.source === 'workbook',
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
      ...THEMES.map(themeCommand),
      {
        id: 'cache.clear',
        title: 'Clear the cache',
        group: 'Graph',
        run: () => void call('cache.clear').catch(fail('The cache couldn’t be cleared')),
      },
    ];
    return registerCommands(commands);
  }, [setProblem]);

  const account = accounts?.accounts.find((a) => a.active);
  const accountKey = account?.key;
  useEffect(() => {
    createAppAllowed.current = canCreateApp(account);
  }, [account]);
  const graphSchema = useSchemas((s) => s.byKey.graph);
  const schemas = useSchemas((s) => s.byKey);
  const resourceTypes = useSchemas((s) => s.resourceTypes);

  // Another account sees another hunting schema and other resource types: every schema is read again.
  const shownAccount = useRef<string | undefined | null>(null);
  useEffect(() => {
    if (accounts === null) {
      return;
    }
    if (shownAccount.current !== null && shownAccount.current !== accountKey) {
      useSchemas.getState().reset();
    }
    shownAccount.current = accountKey;
  }, [accounts, accountKey]);

  // Unreadable accounts also mean sign-in: it shows why, and signing in reads them again.
  const signingIn = accountsError !== null || (accounts !== null && (!account || accountsOpen));
  // Asked once: until the user answers, the host keeps null. Closed unanswered, it asks again at the next start.
  const askTelemetry = settings?.settings.telemetry === null && !telemetryClosed;
  // Only once the findings question is answered or closed.
  const askErrorReports = settings?.settings.errorReports === null && !errorReportsClosed && !askTelemetry;

  // The window's shortcuts act on the workspace, so none fires while sign-in or settings covers it, or a dialog is open (the
  // palette, the save dialog, the close confirmation, a shared workbook's review or a solution's dialog, which handle their own keys, Esc included).
  const shortcutsOn = useRef(false);
  const importOpen = useImportReview((s) => s.pending !== null);
  const solutionOpen = useSolutionDialog((s) => s.id !== null);
  useEffect(() => {
    shortcutsOn.current =
      !signingIn && !settingsOpen && !paletteOpen && saving === null && !confirming && !askTelemetry && !askErrorReports && !update && !importOpen && !solutionOpen;
    paletteShown.current = paletteOpen;
    settingsShown.current = settingsOpen;
  });
  useEffect(() => bindGlobalKeys(() => shortcutsOn.current), []);

  // A .kql file dropped on the window opens in a new tab. The page never lets the webview open a dropped file itself, nor
  // navigate to a dropped link or URL text (the page has the bridge); text dropped into a text box still goes in.
  useEffect(() => {
    const hasFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
    const inTextBox = (e: DragEvent) =>
      e.target instanceof Element && !!e.target.closest('input, textarea, [contenteditable]:not([contenteditable="false"]), .monaco-editor');
    // A drag the page handles itself (the Parameters list) already called preventDefault.
    const refuse = (e: DragEvent) => {
      if (!e.defaultPrevented && !hasFiles(e) && !inTextBox(e)) {
        e.preventDefault();
        if (e.dataTransfer) {
          e.dataTransfer.dropEffect = 'none';
        }
      }
    };
    const onDragOver = (e: DragEvent) => {
      if (hasFiles(e)) {
        e.preventDefault();
      }
      refuse(e);
    };
    const onDrop = (e: DragEvent) => {
      refuse(e);
      const files = e.dataTransfer?.files;
      if (!files || files.length === 0) {
        return;
      }
      e.preventDefault();
      if (!shortcutsOn.current) {
        return;
      }
      for (const file of files) {
        openDroppedFile(file).catch((error: unknown) => setProblem(errorText(error), reportIdOf(error)));
      }
    };
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('drop', onDrop);
    };
  }, [setProblem]);

  const raw = active?.source === 'raw';
  const workbook = active?.source === 'workbook';
  const paramCount = active && !raw ? findParams(active.text).length : 0;
  // "Parameters" swaps the editor for the parameters view; the editor stays mounted (hidden), so its state and undo survive.
  const showingParams = paramsOpen && paramCount > 0;
  // Esc gives the editor back, unless a dialog, a picker or a menu has it first.
  useEffect(() => {
    if (!showingParams || picker !== null) {
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented && shortcutsOn.current) {
        e.preventDefault();
        setParamsOpen(false);
        editor.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showingParams, picker]);
  // Explain is Graph's: a tab whose source changed never shows it (and the change closed it, below).
  const explaining =
    active && active.source === 'graph' && explain?.tabId === active.id && explain.runId === active.run?.runId ? explain.request : null;
  // Schema and snippet text goes into the editor, never into a raw tab's path.
  const insert = (text: string) => (raw || workbook ? false : (editor.current?.insert(text) ?? false));
  const savingTab = tabs.find((t) => t.id === saving);
  const closeSettings = () => {
    setCreateAppOpen(false);
    setSettingsOpen(false);
    if (!signingIn) {
      editor.current?.focus();
    }
  };
  const footerSource = schemaSourceOf(active?.source ?? 'graph');
  const footer = schemaFooter(footerSource, schemas[footerSource], resourceTypes);

  return (
    <div className="flex h-full flex-col">
      <TitleBar
        account={account}
        onAccount={() => {
          // The accounts are shown over everything else: settings close.
          setSettingsOpen(false);
          setAccountsOpen(true);
        }}
        onSettings={() => setSettingsOpen(true)}
      >
        {/* Hidden rather than unmounted, like the workspace below, so a close confirmation keeps its state. */}
        <div className="flex min-w-0 grow" hidden={signingIn} inert={settingsOpen}>
          <TabStrip onDialog={setConfirming} />
        </div>
      </TitleBar>
      {lasting && (
        <div className="border-b border-line bg-bad-soft px-3 py-1.5 text-[12px] text-bad" role="alert">
          {lasting}
        </div>
      )}
      {problem && (
        <div className="flex items-center gap-3 border-b border-line bg-bad-soft px-3 py-1.5 text-[12px] text-bad" role="alert">
          {problem.text}
          <ErrorReportActions reportId={problem.reportId} uiSections={{ message: problem.text }} />
          <div className="grow" />
          <button type="button" className="btn ghost" onClick={() => setProblem(null)}>
            Dismiss
          </button>
        </div>
      )}
      {/* Sign-in, settings and the workspace share this area: settings are a sheet over it, as wide as the window when it's narrow. */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        {/* Settings can be opened from sign-in too (the title bar's account menu): they cover it until they close. */}
        {signingIn && !settingsOpen && (
          <SignIn
            list={accounts}
            error={accountsError}
            onChanged={(done) => {
              let activeKey: string | undefined;
              // The screen closes only once the accounts were read again.
              void readAccounts((list) => {
                activeKey = list.accounts.find((a) => a.active)?.key;
                setAccounts(list);
              }, setAccountsError).then((read) => {
                if (done && read) {
                  setAccountsOpen(false);
                }
                // A built-in hunting schema, or a tenant's one that couldn't be refreshed, may have been shown for want of a
                // sign-in: signed in again as the same account, the tenant's is read (past the host's cache of the fallback), and so
                // are the Resource Graph resource types. Another account resets every schema anyway.
                const sameAccount = activeKey !== undefined && activeKey === shownAccount.current;
                const hunting = useSchemas.getState().byKey.hunting;
                if (read && sameAccount && (hunting?.origin === 'builtIn' || hunting?.fallbackReason)) {
                  void useSchemas.getState().load('hunting', { refresh: true });
                }
                if (read && sameAccount) {
                  void useSchemas.getState().reloadResourceTypes();
                }
              });
            }}
            onBack={account && !accountsError ? () => setAccountsOpen(false) : undefined}
            defaults={settings?.settings.signIn}
            createAppOpen={createAppOpen}
            onCreateAppOpen={setCreateAppOpen}
          />
        )}
        {settingsOpen && (
          <div className="absolute inset-0 z-10 flex justify-end">
            {!signingIn && <button type="button" aria-label="Close settings" tabIndex={-1} className="absolute inset-0 cursor-default bg-black/40" onClick={closeSettings} />}
            <div
              role="dialog"
              aria-label="Settings"
              className={`sheet relative flex w-full flex-col shadow-[0_18px_40px_rgba(0,0,0,0.45)] ${signingIn ? '' : 'lg:w-[760px] lg:border-l lg:border-line'}`}
            >
              <SettingsView
                account={account}
                createAppOpen={createAppOpen}
                onCreateAppOpen={setCreateAppOpen}
                onAccountSwitched={() => void readAccounts(setAccounts, setAccountsError)}
                onClose={closeSettings}
                onChange={setSettings}
              />
            </div>
          </div>
        )}
        {/* Hidden rather than unmounted while signing in, so the editor keeps each tab's undo history. */}
        <div className="flex min-h-0 flex-1 flex-col" hidden={signingIn} inert={settingsOpen}>
          <div className="panes" style={sideWidth === null ? undefined : ({ '--side-w': `${sideWidth}px` } as CSSProperties)}>
            <Rail
              panel={workbook ? workbookPanel : panel}
              onChoose={workbook ? (p) => setWorkbookPanel((shown) => (shown === p ? null : p)) : setPanel}
            />
            {(workbook ? workbookPanel : panel) && (
              <>
                <SidePanel
                  panel={(workbook ? workbookPanel : panel) ?? panel}
                  source={active?.source ?? 'graph'}
                  text={active?.text ?? ''}
                  onInsert={insert}
                  accountKey={accountKey}
                  onSignIn={() => setAccountsOpen(true)}
                />
                <Splitter orientation="vertical" label="Resize the side panel" size={sideWidth} onSize={setSideWidth} min={180} reserve={360} />
              </>
            )}
            <main className="workspace" style={editorHeight === null ? undefined : ({ '--editor-h': `${editorHeight}px` } as CSSProperties)}>
              {active ? (
                <>
                  {!raw && !workbook && (
                    <Toolbar
                      tab={active}
                      onRun={(mode) => runActive(mode)}
                      onFormat={() => editor.current?.format()}
                      paramCount={paramCount}
                      paramsOpen={showingParams}
                      onParams={() => runCommand('params.toggle')}
                      explaining={explaining !== null}
                      onExplain={() => runCommand('explain')}
                      onSave={() => runCommand('file.save')}
                      onSaveAs={() => runCommand('file.saveAs')}
                      picker={picker}
                      onPicker={setPicker}
                      accountKey={accountKey}
                      onSignIn={() => setAccountsOpen(true)}
                    />
                  )}
                  {/* A raw tab has no query: the editor stays mounted for the other tabs, hidden. The parameters view takes its
                      place, at its size, so the results below keep theirs. */}
                  {showingParams && (
                    <div className="min-h-[160px] shrink-0 basis-(--editor-h,38%) overflow-y-auto border-b border-line">
                      <ParamsForm tab={active} query={runnableText} onRun={() => runActive('block')} />
                    </div>
                  )}
                  <div className="relative min-h-[160px] shrink-0 basis-(--editor-h,38%) border-b border-line" hidden={raw || workbook || showingParams}>
                    <EditorFailed>
                      <Suspense fallback={<p className="faint m-0 p-4 text-[12px]">Loading the editor…</p>}>
                        <KqlEditor ref={editor} schemas={schemas} onRun={(mode) => void useTabs.getState().run(active.id, mode)} />
                      </Suspense>
                    </EditorFailed>
                  </div>
                  {!raw && !workbook && (
                    <Splitter orientation="horizontal" label="Resize the query editor" size={editorHeight} onSize={setEditorHeight} min={160} reserve={200} />
                  )}
                  {workbook ? (
                    // A workbook that breaks its view shows the error in its tab; the app and the other tabs stay.
                    <ErrorBoundary key={active.id}>
                      <Suspense fallback={<p className="faint m-0 p-4 text-[12px]">Loading the workbook…</p>}>
                        <WorkbookView tabId={active.id} onSignIn={() => setAccountsOpen(true)} />
                      </Suspense>
                    </ErrorBoundary>
                  ) : raw ? (
                    <RawTab
                      key={active.id}
                      tab={active}
                      schema={graphSchema ?? null}
                      defaultVersion={settings?.settings.rawDefaultVersion ?? 'beta'}
                      accountKey={account?.key}
                      onSignIn={() => setAccountsOpen(true)}
                    />
                  ) : (
                    <>
                      <RunStatus
                        run={active.run}
                        scope={active.run?.options?.scope}
                        onSignIn={() => setAccountsOpen(true)}
                        accountKey={accountKey}
                        account={account}
                        createApp={canCreateApp(account)}
                        onConsented={() => void useTabs.getState().rerun(active.id)}
                        onGranted={() => {
                          const id = active.id;
                          // The account's permissions are read again first, so a run still refused says what it lacks. A
                          // built-in hunting schema, or one that couldn't be refreshed, may have been for want of the permission.
                          void readAccounts(setAccounts, setAccountsError).then(() => {
                            const hunting = useSchemas.getState().byKey.hunting;
                            if (hunting?.origin === 'builtIn' || hunting?.fallbackReason) {
                              void useSchemas.getState().load('hunting', { refresh: true });
                            }
                            void useTabs.getState().rerun(id);
                          });
                        }}
                      />
                      {explaining ? (
                        <ExplainView request={explaining} onOpenRaw={(url) => openRaw({ path: url, version: 'beta' })} />
                      ) : (
                        <Results tab={active} dialogOpen={paletteOpen || saving !== null || confirming} />
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
            {active && !raw && <CursorPosition tabId={active.id} />}
            <span>{LANGUAGE[active?.source ?? 'graph']}</span>
            {footer && <span title={footerSource === 'graph' ? schemas.graph?.source : undefined}>{footer}</span>}
            <div className="grow" />
            <span title="Theme">{theme.theme === 'system' ? `System (${themeName(theme.resolved)})` : themeName(theme.theme)}</span>
          </footer>
        </div>
      </div>
      {savingTab?.source === 'workbook' && (
        <SaveWorkbookDialog tab={savingTab} onClose={() => setSaving(null)} />
      )}
      {savingTab && savingTab.source !== 'workbook' && (
        <SaveDialog
          tab={savingTab}
          onClose={() => {
            setSaving(null);
            editor.current?.focus();
          }}
        />
      )}
      {askTelemetry && (
        <TelemetryDialog
          onClose={(answer) => {
            setTelemetryClosed(true);
            if (answer) {
              setSettings(answer);
            }
          }}
        />
      )}
      {askErrorReports && (
        <ErrorReportsDialog
          onClose={(answer) => {
            setErrorReportsClosed(true);
            if (answer) {
              setSettings(answer);
            }
          }}
        />
      )}
      {update && !askTelemetry && !askErrorReports && <UpdateDialog info={update} onClose={() => setUpdate(null)} />}
      <ImportReview />
      <SolutionDialog />
      {paletteOpen && (
        <Palette
          onClose={() => {
            setPaletteOpen(false);
            editor.current?.focus();
          }}
          onInsert={insert}
          onProblem={setProblem}
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
  onSave: () => void;
  /** Save as: in Save's menu, once the tab is saved to the library or to a file. */
  onSaveAs: () => void;
  /** The picker that is open ("Pick timespan" and "Pick scope" open them too). */
  picker: 'timespan' | 'scope' | null;
  onPicker: (picker: 'timespan' | 'scope' | null) => void;
  /** The active account, which the scope picker's "Grant Azure access" asks consent for. */
  accountKey: string | undefined;
  /** Opens sign-in, when the scope picker's lists need the account to sign in again. */
  onSignIn: () => void;
}

function Toolbar(props: ToolbarProps) {
  const { tab, onRun, onFormat, paramCount, paramsOpen, onParams, explaining, onExplain, onSave, onSaveAs, picker, onPicker, accountKey, onSignIn } = props;
  const running = tab.run?.state === 'running';
  const setOptions = (change: Partial<QueryOptions>) =>
    useTabs.getState().setOptions(tab.id, { timespan: tab.options?.timespan ?? null, scope: tab.options?.scope ?? null, ...change });
  return (
    <div className="toolbar">
      <button type="button" className="btn primary" onClick={() => onRun('block')}>
        <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M6 4v16l14-8z" />
        </svg>
        Run
      </button>
      <span className="faint whitespace-nowrap text-[12px]">the block at the cursor</span>
      <span className="kbd">{MOD} Enter</span>
      <button type="button" className="btn ghost" onClick={() => onRun('all')}>
        Run all <span className="kbd">{SHIFT} Enter</span>
      </button>
      <span className="sep" aria-hidden="true" />
      {tab.source === 'hunting' && (
        <TimespanPicker
          timespan={tab.options?.timespan}
          onChange={(timespan) => setOptions({ timespan })}
          open={picker === 'timespan'}
          onOpenChange={(open) => onPicker(open ? 'timespan' : null)}
        />
      )}
      {tab.source === 'arg' && (
        <ScopePicker
          scope={tab.options?.scope}
          onChange={(scope) => setOptions({ scope })}
          accountKey={accountKey}
          onSignIn={onSignIn}
          open={picker === 'scope'}
          onOpenChange={(open) => onPicker(open ? 'scope' : null)}
        />
      )}
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
      {/* Right-aligned also when the toolbar wraps, so Save's menu, which opens leftward, stays over the workspace. */}
      <div className="ml-auto">
        <SaveButton saved={tab.savedId !== undefined || tab.filePath !== undefined} onSave={onSave} onSaveAs={onSaveAs} />
      </div>
    </div>
  );
}

function Results({ tab, dialogOpen }: { tab: Tab; dialogOpen: boolean }) {
  const result = tab.run?.state === 'done' ? tab.run.result : undefined;
  // A run that failed after reaching Graph or the engine: its log says what happened (the status line above says why it failed).
  if (result && result.outcome !== 'ok' && result.diagnostics.length > 0) {
    return (
      <section aria-label="Diagnostics" className="flex min-h-0 flex-1 flex-col">
        <DiagnosticsView result={result} source={tab.run?.source} />
      </section>
    );
  }
  if (!result || result.outcome !== 'ok') {
    return (
      <div className="flex flex-1 items-center justify-center">
        <span className="faint text-[12px]">
          {tab.run?.state === 'running' ? 'Running…' : `Run a query with ${MOD} Enter. Its rows show here.`}
        </span>
      </div>
    );
  }
  return (
    <ResultPanel
      key={tab.id}
      tabId={tab.id}
      title={tab.title}
      kql={tab.run?.kql ?? tab.text}
      result={result}
      pinned={tab.pinned}
      dialogOpen={dialogOpen}
      source={tab.run?.source}
    />
  );
}
