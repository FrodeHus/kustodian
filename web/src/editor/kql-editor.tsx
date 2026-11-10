// Monaco first, with all its editor features: the Kusto contribution below must find them registered when it loads.
import 'monaco-editor/esm/vs/editor/edcore.main.js';
// The package's ESM entry by its path: it names it only as `module`, which the test runner doesn't read.
import { getKustoWorker } from '@kusto/monaco-kusto/release/esm/monaco.contribution.js';
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker.js?worker';
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import { call } from '../bridge';
import { schemaSourceOf } from '../schema/schema-store';
import { PALETTES, isPalette, type Palette } from '../shell/palettes';
import { useTheme, type Theme } from '../shell/theme';
import { useTabs, type RunMode } from '../tabs/tab-store';
import type { CompletionItem, SchemaView, Source } from '../wire';
import { createDotProvider } from './dot-completion';
import { toKustoSchema } from './kusto-schema';
import KustoWorker from './kusto.worker?worker';
import { bindCommandKeys, bindRunKeys } from './run-keys';

// Both workers are files of the build (Vite `?worker`): the editor never loads anything from the network.
globalThis.MonacoEnvironment = {
  getWorker: (_id: string, label: string) => (label === 'kusto' ? new KustoWorker() : new EditorWorker()),
};

// Monaco opens a Ctrl/Cmd+clicked link with window.open, inside the webview that has the bridge. Https links go to the user's
// browser through the host's allowlist instead, as the markdown widget's do; any other link opens nowhere. Monaco's own
// `command:` links (in hovers) are left to it.
monaco.editor.registerLinkOpener({
  open(uri) {
    if (uri.scheme === 'command') {
      return false;
    }
    if (uri.scheme === 'https') {
      call('app.openLink', { url: uri.toString() }).catch(() => undefined);
    }
    return true;
  },
});

// The studio's dark tokens (styles.css); Monaco takes colours as hex, not CSS variables.
const DARK: monaco.editor.IStandaloneThemeData = {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: '', foreground: 'E6E9EE' },
    { token: 'plainText', foreground: 'E6E9EE' },
    { token: 'comment', foreground: '7D8796', fontStyle: 'italic' },
    { token: 'punctuation', foreground: 'A3ADBB' },
    { token: 'directive', foreground: 'C9A0FF' },
    { token: 'literal', foreground: 'F7A072' },
    { token: 'stringLiteral', foreground: 'A5D6A7' },
    { token: 'type', foreground: '82AAFF' },
    { token: 'column', foreground: 'F2C779' },
    { token: 'table', foreground: '4CC2FF' },
    { token: 'database', foreground: '4CC2FF' },
    { token: 'function', foreground: '82AAFF' },
    { token: 'parameter', foreground: 'F7A072' },
    { token: 'variable', foreground: 'E6E9EE' },
    { token: 'identifier', foreground: 'E6E9EE' },
    { token: 'clientParameter', foreground: 'F7A072' },
    { token: 'queryParameter', foreground: 'F7A072' },
    { token: 'scalarParameter', foreground: 'F7A072' },
    { token: 'mathOperator', foreground: 'A3ADBB' },
    { token: 'queryOperator', foreground: 'C9A0FF' },
    { token: 'command', foreground: 'C9A0FF' },
    { token: 'keyword', foreground: 'C9A0FF' },
    { token: 'materializedView', foreground: '4CC2FF' },
    { token: 'schemaMember', foreground: 'F2C779' },
    { token: 'signatureParameter', foreground: 'E6E9EE' },
    { token: 'option', foreground: 'E6E9EE' },
  ],
  colors: {
    'editor.background': '#0F1115',
    'editor.foreground': '#E6E9EE',
    'editorLineNumber.foreground': '#7D8796',
    'editorLineNumber.activeForeground': '#A3ADBB',
    'editor.lineHighlightBackground': '#7F8CA014',
    'editor.selectionBackground': '#4CC2FF40',
    'editorCursor.foreground': '#4CC2FF',
    'editorSuggestWidget.background': '#161A20',
    'editorSuggestWidget.border': '#2A303A',
    'editorSuggestWidget.selectedBackground': '#232934',
    'editorHoverWidget.background': '#161A20',
    'editorHoverWidget.border': '#2A303A',
    'editorWidget.background': '#161A20',
    'editorWidget.border': '#2A303A',
  },
};
monaco.editor.defineTheme('kustodian-dark', DARK);

// The light tokens (`.theme-light` in styles.css, from studio.css), as hex.
monaco.editor.defineTheme('kustodian-light', {
  base: 'vs',
  inherit: true,
  rules: [
    { token: '', foreground: '14171C' },
    { token: 'plainText', foreground: '14171C' },
    { token: 'comment', foreground: '6B7584', fontStyle: 'italic' },
    { token: 'punctuation', foreground: '4E5867' },
    { token: 'directive', foreground: '7A3EC8' },
    { token: 'literal', foreground: 'B4501A' },
    { token: 'stringLiteral', foreground: '2E7D32' },
    { token: 'type', foreground: '2F57C9' },
    { token: 'column', foreground: '8A5A00' },
    { token: 'table', foreground: '0B6FAE' },
    { token: 'database', foreground: '0B6FAE' },
    { token: 'function', foreground: '2F57C9' },
    { token: 'parameter', foreground: 'B4501A' },
    { token: 'variable', foreground: '14171C' },
    { token: 'identifier', foreground: '14171C' },
    { token: 'clientParameter', foreground: 'B4501A' },
    { token: 'queryParameter', foreground: 'B4501A' },
    { token: 'scalarParameter', foreground: 'B4501A' },
    { token: 'mathOperator', foreground: '4E5867' },
    { token: 'queryOperator', foreground: '7A3EC8' },
    { token: 'command', foreground: '7A3EC8' },
    { token: 'keyword', foreground: '7A3EC8' },
    { token: 'materializedView', foreground: '0B6FAE' },
    { token: 'schemaMember', foreground: '8A5A00' },
    { token: 'signatureParameter', foreground: '14171C' },
    { token: 'option', foreground: '14171C' },
  ],
  colors: {
    'editor.background': '#F4F6F8',
    'editor.foreground': '#14171C',
    'editorLineNumber.foreground': '#6B7584',
    'editorLineNumber.activeForeground': '#4E5867',
    'editor.lineHighlightBackground': '#7F8CA014',
    'editor.selectionBackground': '#0B6FAE40',
    'editorCursor.foreground': '#0B6FAE',
    'editorSuggestWidget.background': '#FFFFFF',
    'editorSuggestWidget.border': '#DCE1E8',
    'editorSuggestWidget.selectedBackground': '#EEF2F6',
    'editorHoverWidget.background': '#FFFFFF',
    'editorHoverWidget.border': '#DCE1E8',
    'editorWidget.background': '#FFFFFF',
    'editorWidget.border': '#DCE1E8',
  },
});

// The glass themes: the dark theme with a clear background, so the frosted panel behind the editor shows through.
monaco.editor.defineTheme('kustodian-glass', {
  ...DARK,
  colors: {
    ...DARK.colors,
    'editor.background': '#00000000',
    'editorGutter.background': '#00000000',
    'editor.lineHighlightBackground': '#5CC8FF1A',
    'editorSuggestWidget.background': '#161A20E6',
    'editorHoverWidget.background': '#161A20E6',
    'editorWidget.background': '#161A20E6',
  },
});

/** A palette theme's Monaco theme: its colours in the roles the dark theme gives the studio's tokens, over Monaco's light base for a
 * light palette. */
function paletteTheme(p: Palette): monaco.editor.IStandaloneThemeData {
  const hex = (colour: string) => colour.slice(1).toUpperCase();
  const roles: [string, string][] = [
    [p.text, 'plainText variable identifier signatureParameter option'],
    [p.muted, 'punctuation mathOperator'],
    [p.kw, 'directive queryOperator command keyword'],
    [p.num, 'literal parameter clientParameter queryParameter scalarParameter'],
    [p.str, 'stringLiteral'],
    [p.fn, 'type function'],
    [p.col, 'column schemaMember'],
    [p.tbl, 'table database materializedView'],
  ];
  return {
    base: p.light ? 'vs' : 'vs-dark',
    inherit: true,
    rules: [
      { token: '', foreground: hex(p.text) },
      { token: 'comment', foreground: hex(p.cm), fontStyle: 'italic' },
      ...roles.flatMap(([colour, tokens]) => tokens.split(' ').map((token) => ({ token, foreground: hex(colour) }))),
    ],
    colors: {
      'editor.background': p.bg,
      'editor.foreground': p.text,
      'editorLineNumber.foreground': p.faint,
      'editorLineNumber.activeForeground': p.muted,
      'editor.lineHighlightBackground': `${p.raise}80`,
      'editor.selectionBackground': `${p.accent}40`,
      'editorCursor.foreground': p.accent,
      'editorSuggestWidget.background': p.panel,
      'editorSuggestWidget.border': p.line,
      'editorSuggestWidget.selectedBackground': p.raise,
      'editorHoverWidget.background': p.panel,
      'editorHoverWidget.border': p.line,
      'editorWidget.background': p.panel,
      'editorWidget.border': p.line,
    },
  };
}

for (const [id, palette] of Object.entries(PALETTES)) {
  monaco.editor.defineTheme(`kustodian-${id}`, paletteTheme(palette));
}

const monacoTheme = ({ theme, resolved, glass }: { theme: Theme; resolved: 'dark' | 'light'; glass: boolean }) =>
  isPalette(theme) ? `kustodian-${theme}` : glass ? 'kustodian-glass' : resolved === 'light' ? 'kustodian-light' : 'kustodian-dark';

/** The `majorVersion` each schema view goes to the language service with: a new view (or an empty database) always gets a higher
 * one than any before it, so monaco-kusto's cache, which keeps a database until its version grows, takes it. The same view
 * again keeps its version, and the cache's copy. */
const versions = new WeakMap<SchemaView, number>();
let lastVersion = 0;
/** Bumped by every schema an editor gives the language service, which holds one for all editors (the window's and the widget
 * editor's): an editor whose schema was replaced by another's gives its own again on its next change. */
let schemaApplies = 0;
function versionOf(view: SchemaView | undefined): number {
  if (!view) {
    return ++lastVersion;
  }
  let version = versions.get(view);
  if (version === undefined) {
    version = ++lastVersion;
    versions.set(view, version);
  }
  return version;
}

const uriOf = (tabId: string) => monaco.Uri.parse(`inmemory://kustodian/${tabId}.kql`);

// Only ever asked for Graph tabs: the other sources' completion comes from monaco-kusto and their schema alone.
const complete = (kql: string, position: number, signal: AbortSignal) =>
  call<CompletionItem[]>('query.complete', { source: 'graph', kql, position }, signal);

/** What the toolbar and the schema panel can ask of the editor. */
export interface KqlEditorHandle {
  format(): void;
  focus(): void;
  /** Puts text where the cursor is, replacing the selection; false when the editor isn't ready and nothing was inserted. */
  insert(text: string): boolean;
  /**
   * Replaces the active model's text from `start` to `end` (lines and columns from 1) with `text`, as one undo step; false
   * when the editor isn't ready and nothing changed.
   */
  replaceRange(start: { line: number; column: number }, end: { line: number; column: number }, text: string): boolean;
}

/** Text edited outside the tab store (the widget editor's query): one model, its own source, each change to `onChange`. */
export interface KqlDraft {
  id: string;
  source: Exclude<Source, 'raw'>;
  text: string;
  onChange: (text: string) => void;
}

interface KqlEditorProps {
  /** Each source's schema, as far as it is read; the active tab's source's is the one the language service uses. */
  schemas: Partial<Record<Source, SchemaView>>;
  onRun: (mode: RunMode) => void;
  ref?: Ref<KqlEditorHandle>;
  /** Edits this instead of the tab store's tabs. */
  draft?: KqlDraft;
}

/**
 * The query editor (spec 6.2): Monaco with Microsoft's Kusto language service set to the active tab's source's schema, plus,
 * on Graph tabs only, completion inside complex values from the host. One editor for the window, with a model per tab, so each tab keeps its own text, undo history
 * and scroll position. The tab store owns the text: the editor reports each change to it.
 */
export default function KqlEditor({ schemas, onRun, ref, draft }: KqlEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const models = useRef(new Map<string, monaco.editor.ITextModel>());
  const views = useRef(new Map<string, monaco.editor.ICodeEditorViewState | null>());
  const current = useRef<string | null>(null);
  /** The schema the language service has: its source and view (undefined: the source's empty database). */
  const appliedSchema = useRef<{ source: string; view: SchemaView | undefined; n: number } | null>(null);
  const [schemaFailed, setSchemaFailed] = useState(false);
  const latest = useRef({ onRun, draft });
  useEffect(() => {
    latest.current = { onRun, draft };
  });
  // Re-syncs the models whenever the store's tabs change.
  const tabsChanged = useTabs((s) => s.tabs);
  const tabActiveId = useTabs((s) => s.activeId);
  const activeId = draft ? draft.id : tabActiveId;
  const draftId = draft?.id;

  useEffect(() => {
    const editor = monaco.editor.create(host.current!, {
      model: null,
      language: 'kusto',
      theme: monacoTheme(useTheme.getState()),
      ariaLabel: 'KQL query',
      automaticLayout: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      fontFamily: "'JetBrains Mono', ui-monospace, monospace",
      fontSize: 13,
      lineHeight: 21,
      padding: { top: 10, bottom: 10 },
      lineNumbersMinChars: 4,
      overviewRulerLanes: 0,
      renderLineHighlight: 'line',
      fixedOverflowWidgets: true,
      'semanticHighlighting.enabled': true,
      // A file dropped on the window opens in a tab of its own (app.tsx); the editor must not also paste it in.
      dropIntoEditor: { enabled: false },
    });
    editorRef.current = editor;
    const allModels = models.current;
    // Monaco measures the font's glyph widths once, on create. JetBrains Mono loads lazily, so that first measure is of the
    // fallback font, and the cursor then drifts off the characters it is on; measure again once the real font is in.
    let disposed = false;
    void document.fonts.load("13px 'JetBrains Mono'").then(() => {
      if (!disposed) {
        monaco.editor.remeasureFonts();
      }
    });

    const runKeys = bindRunKeys(
      editor,
      { CtrlCmd: monaco.KeyMod.CtrlCmd, Shift: monaco.KeyMod.Shift, Enter: monaco.KeyCode.Enter },
      (mode) => latest.current.onRun(mode),
    );
    // The window's commands (palette, tabs, run without cache ...) work while typing too; not in a draft's editor, whose dialog
    // covers the tab they would act on.
    const stopBinding = latest.current.draft
      ? () => undefined
      : bindCommandKeys(editor, { KeyMod: monaco.KeyMod, KeyCode: monaco.KeyCode }, runKeys.taken);
    // Monaco's theme is global: it follows the window's.
    const stopTheme = useTheme.subscribe((t, previous) => {
      if (monacoTheme(t) !== monacoTheme(previous)) {
        monaco.editor.setTheme(monacoTheme(t));
      }
    });

    const subscriptions = [
      editor.onDidChangeModelContent(() => {
        const id = current.current;
        const model = editor.getModel();
        if (id && model) {
          const own = latest.current.draft;
          if (own) {
            own.onChange(model.getValue());
          } else {
            useTabs.getState().setText(id, model.getValue());
          }
        }
      }),
      editor.onDidChangeCursorSelection((e) => {
        const id = current.current;
        const model = editor.getModel();
        if (id && model && !latest.current.draft) {
          useTabs.getState().setCursor(id, {
            line: e.selection.positionLineNumber,
            column: e.selection.positionColumn,
            selection: model.getValueInRange(e.selection),
            selectionLine: e.selection.startLineNumber,
            selectionColumn: e.selection.startColumn,
          });
        }
      }),
      // Providers are global to the language: this one answers for Graph tabs' models only.
      monaco.languages.registerCompletionItemProvider(
        'kusto',
        createDotProvider(complete, (uri) =>
          [...allModels.entries()].some(
            ([id, m]) => m.uri.toString() === uri && (latest.current.draft ? latest.current.draft.source === 'graph' : isGraph(id)),
          ),
        ),
      ),
    ];

    return () => {
      disposed = true;
      runKeys.dispose();
      stopBinding();
      stopTheme();
      subscriptions.forEach((s) => s.dispose());
      editor.dispose();
      allModels.forEach((m) => m.dispose());
      allModels.clear();
      editorRef.current = null;
      current.current = null;
    };
  }, []);

  // A model per open tab; text the store has that the model doesn't (set from outside the editor) goes in. The tabs are read
  // from the store here, not from this render: typing may have moved on since, and older text must never replace newer.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) {
      return;
    }
    // A draft's text comes in once, with its model: after that the model is ahead of any render's copy of it.
    const tabs = draftId !== undefined ? [{ id: draftId, text: latest.current.draft?.text ?? '' }] : useTabs.getState().tabs;
    const open = new Set(tabs.map((t) => t.id));
    for (const [id, model] of models.current) {
      if (!open.has(id)) {
        model.dispose();
        models.current.delete(id);
        views.current.delete(id);
      }
    }
    for (const tab of tabs) {
      const model = models.current.get(tab.id);
      if (!model) {
        models.current.set(tab.id, monaco.editor.createModel(tab.text, 'kusto', uriOf(tab.id)));
      } else if (draftId === undefined && model.getValue() !== tab.text) {
        model.setValue(tab.text);
      }
    }

    if (current.current !== activeId) {
      if (current.current && models.current.has(current.current)) {
        views.current.set(current.current, editor.saveViewState());
      }
      current.current = activeId;
      const model = activeId ? (models.current.get(activeId) ?? null) : null;
      editor.setModel(model);
      const view = activeId ? views.current.get(activeId) : null;
      if (view) {
        editor.restoreViewState(view);
      }
      // A draft's dialog keeps focus where it put it (its Title).
      if (model && draftId === undefined) {
        editor.focus();
      }
    }
  }, [tabsChanged, activeId, draftId]);

  // The language service completes and checks against the active tab's source's schema (one at a time: it is the worker's).
  // Until that source's schema is read it has an empty database for it, so a hunting tab never completes Graph's tables.
  const activeSource = draft ? draft.source : tabsChanged.find((t) => t.id === activeId)?.source;
  const source = activeSource ? schemaSourceOf(activeSource) : undefined;
  const view = source ? schemas[source] : undefined;
  useEffect(() => {
    const model = activeId ? models.current.get(activeId) : undefined;
    const applied = appliedSchema.current;
    if (!source || !model || (applied?.source === source && applied.view === view && applied.n === schemaApplies)) {
      return;
    }
    appliedSchema.current = { source, view, n: ++schemaApplies };
    void (async () => {
      const worker = await (await getKustoWorker())(model.uri);
      await worker.setSchema(toKustoSchema(view, source, versionOf(view)));
    })().then(
      () => setSchemaFailed(false),
      () => {
        // Tried again on the next schema or tab change.
        appliedSchema.current = null;
        setSchemaFailed(true);
      },
    );
  }, [source, view, activeId]);

  useImperativeHandle(
    ref,
    () => ({
      format() {
        void editorRef.current?.getAction('editor.action.formatDocument')?.run();
      },
      focus() {
        editorRef.current?.focus();
      },
      insert(text) {
        const editor = editorRef.current;
        const selection = editor?.getSelection();
        if (!editor || !selection) {
          return false;
        }
        editor.executeEdits('schema-panel', [{ range: selection, text, forceMoveMarkers: true }]);
        editor.focus();
        return true;
      },
      replaceRange(start, end, text) {
        const editor = editorRef.current;
        if (!editor?.getModel()) {
          return false;
        }
        const range = { startLineNumber: start.line, startColumn: start.column, endLineNumber: end.line, endColumn: end.column };
        // The stops make it an undo step of its own, not merged with typing just before or after.
        editor.pushUndoStop();
        editor.executeEdits('smart-filter', [{ range, text }]);
        editor.pushUndoStop();
        return true;
      },
    }),
    [],
  );

  return (
    <div className="relative h-full w-full">
      <div ref={host} className="h-full w-full" data-testid="kql-editor" />
      {schemaFailed && (
        <span className="chip warn absolute right-3 bottom-2 z-[1]" role="status">
          Schema not loaded in the editor: no table or column completion. Switching tabs tries again.
        </span>
      )}
    </div>
  );
}

function isGraph(tabId: string): boolean {
  return useTabs.getState().tabs.some((t) => t.id === tabId && t.source === 'graph');
}
