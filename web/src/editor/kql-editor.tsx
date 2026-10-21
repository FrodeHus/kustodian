// Monaco first, with all its editor features: the Kusto contribution below must find them registered when it loads.
import 'monaco-editor/esm/vs/editor/edcore.main.js';
// The package's ESM entry by its path: it names it only as `module`, which the test runner doesn't read.
import { getKustoWorker } from '@kusto/monaco-kusto/release/esm/monaco.contribution.js';
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker.js?worker';
import { useEffect, useImperativeHandle, useRef, type Ref } from 'react';
import { call } from '../bridge';
import { useTabs, type RunMode } from '../tabs/tab-store';
import type { CompletionItem, SchemaView } from '../wire';
import { createDotProvider } from './dot-completion';
import { toKustoSchema } from './kusto-schema';
import KustoWorker from './kusto.worker?worker';
import { bindRunKeys } from './run-keys';

// Both workers are files of the build (Vite `?worker`): the editor never loads anything from the network.
globalThis.MonacoEnvironment = {
  getWorker: (_id: string, label: string) => (label === 'kusto' ? new KustoWorker() : new EditorWorker()),
};

// The studio's dark tokens (styles.css); Monaco takes colours as hex, not CSS variables.
monaco.editor.defineTheme('kustodian-dark', {
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
});

const uriOf = (tabId: string) => monaco.Uri.parse(`inmemory://kustodian/${tabId}.kql`);

const complete = (kql: string, position: number, signal: AbortSignal) =>
  call<CompletionItem[]>('query.complete', { source: 'graph', kql, position }, signal);

/** What the toolbar and the schema panel can ask of the editor. */
export interface KqlEditorHandle {
  format(): void;
  focus(): void;
  /** Puts text where the cursor is, replacing the selection. */
  insert(text: string): void;
}

interface KqlEditorProps {
  schema: SchemaView | null;
  onRun: (mode: RunMode) => void;
  ref?: Ref<KqlEditorHandle>;
}

/**
 * The query editor (spec 6.2): Monaco with Microsoft's Kusto language service set to the Graph schema, plus completion inside
 * complex values from the host. One editor for the window, with a model per tab, so each tab keeps its own text, undo history
 * and scroll position. The tab store owns the text: the editor reports each change to it.
 */
export default function KqlEditor({ schema, onRun, ref }: KqlEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const models = useRef(new Map<string, monaco.editor.ITextModel>());
  const views = useRef(new Map<string, monaco.editor.ICodeEditorViewState | null>());
  const current = useRef<string | null>(null);
  const appliedSchema = useRef<SchemaView | null>(null);
  const latest = useRef({ onRun });
  useEffect(() => {
    latest.current = { onRun };
  });
  const tabs = useTabs((s) => s.tabs);
  const activeId = useTabs((s) => s.activeId);

  useEffect(() => {
    const editor = monaco.editor.create(host.current!, {
      model: null,
      language: 'kusto',
      theme: 'kustodian-dark',
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
    });
    editorRef.current = editor;
    const allModels = models.current;

    bindRunKeys(editor, { CtrlCmd: monaco.KeyMod.CtrlCmd, Shift: monaco.KeyMod.Shift, Enter: monaco.KeyCode.Enter }, (mode) =>
      latest.current.onRun(mode),
    );

    const subscriptions = [
      editor.onDidChangeModelContent(() => {
        const id = current.current;
        const model = editor.getModel();
        if (id && model) {
          useTabs.getState().setText(id, model.getValue());
        }
      }),
      editor.onDidChangeCursorSelection((e) => {
        const id = current.current;
        const model = editor.getModel();
        if (id && model) {
          useTabs.getState().setCursor(id, {
            line: e.selection.positionLineNumber,
            column: e.selection.positionColumn,
            selection: model.getValueInRange(e.selection),
          });
        }
      }),
      // Providers are global to the language: this one answers for Graph tabs' models only.
      monaco.languages.registerCompletionItemProvider(
        'kusto',
        createDotProvider(complete, (uri) => [...allModels.entries()].some(([id, m]) => m.uri.toString() === uri && isGraph(id))),
      ),
    ];

    return () => {
      subscriptions.forEach((s) => s.dispose());
      editor.dispose();
      allModels.forEach((m) => m.dispose());
      allModels.clear();
      editorRef.current = null;
      current.current = null;
    };
  }, []);

  // A model per open tab; text the store has that the model doesn't (set from outside the editor) goes in.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) {
      return;
    }
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
      } else if (model.getValue() !== tab.text) {
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
      if (model) {
        editor.focus();
      }
    }
  }, [tabs, activeId]);

  // The language service completes and checks against the schema; without it the editor still colours and checks syntax.
  useEffect(() => {
    const model = activeId ? models.current.get(activeId) : undefined;
    if (!schema || !model || appliedSchema.current === schema) {
      return;
    }
    appliedSchema.current = schema;
    void (async () => {
      const worker = await (await getKustoWorker())(model.uri);
      await worker.setSchema(toKustoSchema(schema));
    })().catch(() => {
      appliedSchema.current = null;
    });
  }, [schema, activeId]);

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
          return;
        }
        editor.executeEdits('schema-panel', [{ range: selection, text, forceMoveMarkers: true }]);
        editor.focus();
      },
    }),
    [],
  );

  return <div ref={host} className="h-full w-full" data-testid="kql-editor" />;
}

function isGraph(tabId: string): boolean {
  return useTabs.getState().tabs.some((t) => t.id === tabId && t.source === 'graph');
}
