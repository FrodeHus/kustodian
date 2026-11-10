import { act, render, screen, waitFor } from '@testing-library/react';
import { createRef } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../fixtures/graph-schema.json';
import { registerCommands } from '../shell/commands';
import { applyTheme } from '../shell/theme';
import { useTabs } from '../tabs/tab-store';
import type { SchemaView } from '../wire';
import type { KqlEditorHandle } from './kql-editor';

// Monaco doesn't run in jsdom. A stand-in records what the editor registers, with Monaco's own KeyMod and KeyCode values.
const fake = vi.hoisted(() => {
  const KeyMod = { CtrlCmd: 2048, Shift: 1024, Alt: 512, WinCtrl: 256 };
  const KeyCode = { Enter: 3, KeyK: 41, KeyP: 46, KeyT: 50, KeyW: 53 };
  // Monaco's keybinding service is one for every editor, and the last binding of a key wins: `addCommand`'s holds for any
  // editor and is never removed; an action's holds only in its editor and goes when disposed.
  const bindings: { keybinding: number; editorId: number | null; run: () => void; gone: boolean }[] = [];
  let editors = 0;
  let focused = 0;
  const created = { options: null as unknown, editor: null as ReturnType<typeof editorOf> | null };
  const themes = { defined: [] as string[], set: [] as string[] };
  const fonts = { remeasured: 0 };
  const linkOpener = { open: null as ((uri: { scheme: string; toString: () => string }) => boolean) | null };
  const focusCalls = { n: 0 };
  let selectionEmpty = true;
  const disposable = { dispose: () => undefined };
  const live = { model: null as ReturnType<typeof model> | null, onContent: () => undefined as void };
  // Edits and undo stops, in order; undo goes back to the text before the last edit.
  const edits = { log: [] as string[], undo: [] as string[] };
  type Range = { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number };
  const offsetAt = (text: string, line: number, column: number) =>
    text
      .split('\n')
      .slice(0, line - 1)
      .reduce((n, l) => n + l.length + 1, 0) +
    column -
    1;
  const model = (value: string, uri: { toString: () => string } = { toString: () => 'x' }) => {
    let text = value;
    return {
      getValue: () => text,
      setValue: (v: string) => (text = v),
      dispose: () => undefined,
      uri,
      getLineContent: () => text.split('\n')[0] ?? '',
      getOffsetAt: () => text.length,
    };
  };
  const providers: { provideCompletionItems: (...args: unknown[]) => Promise<{ suggestions: unknown[] }> }[] = [];
  const editorOf = (id: number) => ({
    addCommand: (keybinding: number, handler: () => void) => {
      bindings.push({ keybinding, editorId: null, run: handler, gone: false });
      return null;
    },
    addAction: ({ keybindings, run }: { keybindings: number[]; run: () => void }) => {
      const added = keybindings.map((keybinding) => ({ keybinding, editorId: id, run, gone: false }));
      bindings.push(...added);
      return { dispose: () => added.forEach((b) => (b.gone = true)) };
    },
    getSelection: () => ({ isEmpty: () => selectionEmpty }),
    pushUndoStop: () => {
      edits.log.push('stop');
      return true;
    },
    executeEdits: (source: string, changes: { range: Range; text: string }[]) => {
      const m = live.model!;
      edits.log.push(source);
      edits.undo.push(m.getValue());
      for (const { range, text } of changes) {
        const value = m.getValue();
        const from = offsetAt(value, range.startLineNumber, range.startColumn);
        const to = offsetAt(value, range.endLineNumber, range.endColumn);
        m.setValue(value.slice(0, from) + text + value.slice(to));
      }
      live.onContent();
      return true;
    },
    trigger: (_source: string, id: string) => {
      const before = id === 'undo' ? edits.undo.pop() : undefined;
      if (before !== undefined) {
        live.model!.setValue(before);
        live.onContent();
      }
    },
    onDidChangeModelContent: (listener: () => void) => {
      live.onContent = listener;
      return disposable;
    },
    onDidChangeCursorSelection: () => disposable,
    setModel: (m: ReturnType<typeof model> | null) => (live.model = m),
    getModel: () => live.model,
    saveViewState: () => null,
    restoreViewState: () => undefined,
    focus: () => void focusCalls.n++,
    dispose: () => undefined,
  });
  const monaco = {
    KeyMod,
    KeyCode,
    Uri: { parse: (s: string) => ({ toString: () => s }) },
    editor: {
      create: (_host: unknown, options: unknown) => {
        created.options = options;
        focused = ++editors;
        created.editor = editorOf(focused);
        return created.editor;
      },
      createModel: (value: string, _language: string, uri: { toString: () => string }) => model(value, uri),
      defineTheme: (name: string) => themes.defined.push(name),
      setTheme: (name: string) => themes.set.push(name),
      remeasureFonts: () => fonts.remeasured++,
      registerLinkOpener: (opener: { open: (uri: { scheme: string; toString: () => string }) => boolean }) => {
        linkOpener.open = opener.open;
        return disposable;
      },
    },
    languages: {
      registerCompletionItemProvider: (_language: string, provider: (typeof providers)[number]) => {
        providers.push(provider);
        return disposable;
      },
    },
  };
  return {
    monaco,
    linkOpener,
    bound: (keybinding: number) => bindings.some((b) => b.keybinding === keybinding && !b.gone && b.editorId === focused),
    focus: (id: number) => (focused = id),
    reset: () => {
      bindings.length = 0;
      editors = 0;
      focused = 0;
    },
    created,
    themes,
    fonts,
    focusCalls,
    providers,
    model,
    live,
    edits,
    setSelectionEmpty: (empty: boolean) => (selectionEmpty = empty),
    press: (keybinding: number) =>
      bindings.findLast((b) => b.keybinding === keybinding && !b.gone && (b.editorId === null || b.editorId === focused))?.run(),
    kustoWorker: (): Promise<unknown> => new Promise(() => undefined),
  };
});

vi.mock('monaco-editor/esm/vs/editor/edcore.main.js', () => ({}));
vi.mock('monaco-editor/esm/vs/editor/editor.api.js', () => fake.monaco);
vi.mock('monaco-editor/esm/vs/editor/editor.worker.js?worker', () => ({ default: class {} }));
vi.mock('./kusto.worker?worker', () => ({ default: class {} }));
vi.mock('@kusto/monaco-kusto/release/esm/monaco.contribution.js', () => ({ getKustoWorker: () => fake.kustoWorker() }));
const bridge = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../bridge', () => ({ call: bridge.call, on: () => () => undefined }));

// jsdom has no font loading either: a stand-in whose load resolves when the test says the font is in.
let fontLoaded: () => void = () => undefined;
Object.defineProperty(document, 'fonts', {
  configurable: true,
  value: { load: () => new Promise<void>((resolve) => (fontLoaded = resolve)) },
});

const { default: KqlEditor } = await import('./kql-editor');

const huntingView: SchemaView = {
  source: 'hunting',
  origin: 'tenant',
  fallbackReason: null,
  generatedAt: '2026-10-21T00:00:00Z',
  tables: [{ name: 'DeviceInfo', path: null, area: null, description: '', docsUrl: null, permissions: null, columns: [] }],
  functions: [],
  complexTypes: {},
};

beforeEach(() => {
  fake.reset();
  fake.themes.set.length = 0;
  applyTheme('dark');
  fake.setSelectionEmpty(true);
  fake.kustoWorker = () => new Promise(() => undefined);
  fake.providers.length = 0;
  fake.fonts.remeasured = 0;
  fake.focusCalls.n = 0;
  fake.edits.log.length = 0;
  fake.edits.undo.length = 0;
  bridge.call.mockReset();
  bridge.call.mockResolvedValue([]);
  useTabs.setState({ tabs: [], activeId: null, cursors: {} });
  useTabs.getState().open('graph');
});

describe('KqlEditor', () => {
  it('a clicked https link opens through the host, and no link opens in the window', () => {
    const uri = (scheme: string, text: string) => ({ scheme, toString: () => text });
    expect(fake.linkOpener.open!(uri('https', 'https://learn.microsoft.com/kusto'))).toBe(true);
    expect(bridge.call).toHaveBeenCalledWith('app.openLink', { url: 'https://learn.microsoft.com/kusto' });
    bridge.call.mockClear();
    expect(fake.linkOpener.open!(uri('http', 'http://evil.example'))).toBe(true);
    expect(fake.linkOpener.open!(uri('javascript', 'javascript:alert(1)'))).toBe(true);
    expect(bridge.call).not.toHaveBeenCalled();
    // Monaco's own hover commands stay Monaco's.
    expect(fake.linkOpener.open!(uri('command', 'command:editor.action.showHover'))).toBe(false);
  });

  it('editor_remeasures_the_font_once_it_has_loaded', async () => {
    render(<KqlEditor schemas={{}} onRun={() => undefined} />);
    expect(fake.fonts.remeasured).toBe(0);
    await act(async () => fontLoaded());
    expect(fake.fonts.remeasured).toBe(1);
  });

  it('ctrl_enter_runs_block_shift_enter_runs_all', () => {
    const onRun = vi.fn();
    render(<KqlEditor schemas={{}} onRun={onRun} />);
    const { KeyMod, KeyCode } = fake.monaco;

    fake.press(KeyMod.CtrlCmd | KeyCode.Enter);
    expect(onRun).toHaveBeenLastCalledWith('block');

    fake.press(KeyMod.Shift | KeyCode.Enter);
    expect(onRun).toHaveBeenLastCalledWith('all');

    // With a selection, Ctrl/Cmd+Enter runs only the selection.
    fake.setSelectionEmpty(false);
    fake.press(KeyMod.CtrlCmd | KeyCode.Enter);
    expect(onRun).toHaveBeenLastCalledWith('selection');
    expect(onRun).toHaveBeenCalledTimes(3);
  });

  it('schema_that_fails_to_load_shows_a_notice_and_retries_on_tab_change', async () => {
    const setSchema = vi.fn().mockRejectedValueOnce(new Error('worker crashed')).mockResolvedValue(undefined);
    fake.kustoWorker = () => Promise.resolve(() => Promise.resolve({ setSchema }));
    render(<KqlEditor schemas={{ graph: schema as SchemaView }} onRun={() => undefined} />);

    expect((await screen.findByRole('status')).textContent).toMatch(/Schema not loaded in the editor/);

    act(() => {
      useTabs.getState().open('graph');
    });
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
    expect(setSchema).toHaveBeenCalledTimes(2);
  });

  it('editor_switches_schema_with_the_active_tab_source', async () => {
    const setSchema = vi.fn().mockResolvedValue(undefined);
    fake.kustoWorker = () => Promise.resolve(() => Promise.resolve({ setSchema }));
    const graphTab = useTabs.getState().activeId!;
    const view = render(<KqlEditor schemas={{ graph: schema as SchemaView }} onRun={() => undefined} />);
    await waitFor(() => expect(setSchema).toHaveBeenCalledTimes(1));
    expect(setSchema.mock.calls[0]?.[0].database.name).toBe('graph');

    // A hunting tab whose schema isn't read yet gets an empty hunting database, never Graph's tables.
    act(() => {
      useTabs.getState().open('hunting');
    });
    await waitFor(() => expect(setSchema).toHaveBeenCalledTimes(2));
    expect(setSchema.mock.calls[1]?.[0].database).toMatchObject({ name: 'hunting', tables: [] });

    // Once it is read, the hunting tables.
    view.rerender(<KqlEditor schemas={{ graph: schema as SchemaView, hunting: huntingView }} onRun={() => undefined} />);
    await waitFor(() => expect(setSchema).toHaveBeenCalledTimes(3));
    expect(setSchema.mock.calls[2]?.[0].database.tables.map((t: { name: string }) => t.name)).toEqual(['DeviceInfo']);
    // monaco-kusto keeps a database until its version grows: the read schema must replace the empty one.
    expect(setSchema.mock.calls[2]?.[0].database.majorVersion).toBeGreaterThan(setSchema.mock.calls[1]?.[0].database.majorVersion);

    // Back on the Graph tab, Graph's schema again.
    act(() => useTabs.getState().activate(graphTab));
    await waitFor(() => expect(setSchema).toHaveBeenCalledTimes(4));
    expect(setSchema.mock.calls[3]?.[0].database.name).toBe('graph');
    // The same Graph view keeps its version, so the language service's copy is used again.
    expect(setSchema.mock.calls[3]?.[0].database.majorVersion).toBe(setSchema.mock.calls[0]?.[0].database.majorVersion);
  });

  it('dot_completion_only_on_graph_tabs', async () => {
    const graphTab = useTabs.getState().activeId!;
    const huntingTab = useTabs.getState().open('hunting');
    render(<KqlEditor schemas={{}} onRun={() => undefined} />);
    const provider = fake.providers[0]!;
    const token = { onCancellationRequested: () => ({ dispose: () => undefined }) };
    const ask = (tabId: string) =>
      provider.provideCompletionItems(
        fake.model('applications | extend x = onPremisesPublishing.', { toString: () => `inmemory://kustodian/${tabId}.kql` }),
        { lineNumber: 1, column: 49 },
        {},
        token,
      );

    await ask(huntingTab);
    expect(bridge.call).not.toHaveBeenCalled();

    await ask(graphTab);
    expect(bridge.call).toHaveBeenCalledWith('query.complete', expect.objectContaining({ source: 'graph' }), expect.anything());
  });

  it('registered_command_shortcuts_run_from_the_editor', () => {
    const newTab = vi.fn();
    const palette = vi.fn();
    const unregister = registerCommands([
      { id: 'tab.new', title: 'New Microsoft Graph query', group: 'Tabs', shortcut: 'Mod+T', run: newTab },
      { id: 'palette', title: 'Command palette', group: 'Window', shortcut: 'Mod+K, Mod+Shift+P', run: palette },
    ]);
    render(<KqlEditor schemas={{}} onRun={() => undefined} />);
    const { KeyMod, KeyCode } = fake.monaco;

    fake.press(KeyMod.CtrlCmd | KeyCode.KeyT);
    fake.press(KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyP);
    fake.press(KeyMod.CtrlCmd | KeyCode.KeyK);
    expect(newTab).toHaveBeenCalledTimes(1);
    expect(palette).toHaveBeenCalledTimes(2);

    // A command registered after the editor was made is bound too.
    const close = vi.fn();
    const unregisterClose = registerCommands([{ id: 'tab.close', title: 'Close the tab', group: 'Tabs', shortcut: 'Mod+W', run: close }]);
    fake.press(KeyMod.CtrlCmd | KeyCode.KeyW);
    expect(close).toHaveBeenCalledTimes(1);

    // The run keys stay the editor's own (they know about the selection).
    expect(fake.bound(KeyMod.CtrlCmd | KeyCode.Enter)).toBe(true);
    unregisterClose();
    unregister();
  });

  it('editor_leaves_dropped_files_to_the_window', () => {
    render(<KqlEditor schemas={{}} onRun={() => undefined} />);
    // The window opens a dropped .kql in a new tab; Monaco's drop-into-editor would paste it into this one as well.
    expect(fake.created.options).toMatchObject({ dropIntoEditor: { enabled: false } });
  });

  it('editor_follows_the_theme', () => {
    render(<KqlEditor schemas={{}} onRun={() => undefined} />);
    expect(fake.themes.defined).toEqual(
      expect.arrayContaining(['kustodian-dark', 'kustodian-light', 'kustodian-glass', 'kustodian-dracula']),
    );

    act(() => applyTheme('light'));
    expect(fake.themes.set.at(-1)).toBe('kustodian-light');
    act(() => applyTheme('dark'));
    expect(fake.themes.set.at(-1)).toBe('kustodian-dark');
  });

  it('a draft is edited in place of the tabs, with its own source’s schema', async () => {
    const setSchema = vi.fn().mockResolvedValue(undefined);
    fake.kustoWorker = () => Promise.resolve(() => Promise.resolve({ setSchema }));
    const onChange = vi.fn();
    const before = useTabs.getState().tabs;
    render(
      <KqlEditor
        schemas={{ graph: schema as SchemaView, hunting: huntingView }}
        onRun={() => undefined}
        draft={{ id: 'widget-editor', source: 'hunting', text: 'DeviceInfo', onChange }}
      />,
    );
    expect(fake.live.model?.getValue()).toBe('DeviceInfo');
    await waitFor(() => expect(setSchema).toHaveBeenCalledTimes(1));
    expect(setSchema.mock.calls[0]?.[0].database.tables.map((t: { name: string }) => t.name)).toEqual(['DeviceInfo']);

    fake.live.model?.setValue('DeviceInfo | take 1');
    fake.live.onContent();
    expect(onChange).toHaveBeenCalledWith('DeviceInfo | take 1');
    expect(useTabs.getState().tabs).toBe(before);
  });

  it('run keys stay each editor’s own after a second editor came and went', () => {
    const onRun = vi.fn();
    const onPreview = vi.fn();
    render(<KqlEditor schemas={{}} onRun={onRun} />);
    const second = render(
      <KqlEditor schemas={{}} onRun={onPreview} draft={{ id: 'widget-editor', source: 'graph', text: '', onChange: () => undefined }} />,
    );
    const { KeyMod, KeyCode } = fake.monaco;
    fake.press(KeyMod.CtrlCmd | KeyCode.Enter);
    expect(onPreview).toHaveBeenCalledTimes(1);

    second.unmount();
    fake.focus(1);
    fake.press(KeyMod.CtrlCmd | KeyCode.Enter);
    fake.press(KeyMod.Shift | KeyCode.Enter);
    expect(onRun.mock.calls).toEqual([['block'], ['all']]);
    expect(onPreview).toHaveBeenCalledTimes(1);
  });

  it('a draft’s text goes in with its model; a later render’s older copy never replaces what was typed', () => {
    const onChange = vi.fn();
    const draft = (text: string) => ({ id: 'widget-editor', source: 'graph' as const, text, onChange });
    const view = render(<KqlEditor schemas={{}} onRun={() => undefined} draft={draft('users')} />);
    expect(fake.live.model?.getValue()).toBe('users');
    fake.live.model?.setValue('users | take 2');
    view.rerender(<KqlEditor schemas={{}} onRun={() => undefined} draft={draft('users | take')} />);
    expect(fake.live.model?.getValue()).toBe('users | take 2');
  });

  it('a draft editor leaves focus where it is when it loads (the dialog’s Title has it); a tab’s editor takes it', () => {
    render(
      <KqlEditor
        schemas={{}}
        onRun={() => undefined}
        draft={{ id: 'widget-editor', source: 'graph', text: 'users', onChange: () => undefined }}
      />,
    );
    expect(fake.focusCalls.n).toBe(0);
    useTabs.getState().open('graph');
    render(<KqlEditor schemas={{}} onRun={() => undefined} />);
    expect(fake.focusCalls.n).toBe(1);
  });

  it('a draft editor binds only its run keys, not the window’s command shortcuts (the tab under its dialog)', () => {
    const close = vi.fn();
    const unregister = registerCommands([{ id: 'tab.close', title: 'Close the tab', group: 'Tabs', shortcut: 'Mod+W', run: close }]);
    render(
      <KqlEditor
        schemas={{}}
        onRun={() => undefined}
        draft={{ id: 'widget-editor', source: 'graph', text: '', onChange: () => undefined }}
      />,
    );
    const { KeyMod, KeyCode } = fake.monaco;
    expect(fake.bound(KeyMod.CtrlCmd | KeyCode.KeyW)).toBe(false);
    fake.press(KeyMod.CtrlCmd | KeyCode.KeyW);
    expect(close).not.toHaveBeenCalled();
    expect(fake.bound(KeyMod.CtrlCmd | KeyCode.Enter)).toBe(true);
    unregister();
  });

  it('replaceRange replaces that range as one undoable edit, and the tab gets the new text', () => {
    const ref = createRef<KqlEditorHandle>();
    const id = useTabs.getState().activeId!;
    useTabs.getState().setText(id, 'let a = 1;\nusers | take 5\n\ngroups');
    render(<KqlEditor ref={ref} schemas={{}} onRun={() => undefined} />);

    expect(ref.current!.replaceRange({ line: 2, column: 1 }, { line: 2, column: 15 }, 'users\n| where x == 1\n| take 5')).toBe(true);
    const text = () => useTabs.getState().tabs.find((t) => t.id === id)?.text;
    expect(text()).toBe('let a = 1;\nusers\n| where x == 1\n| take 5\n\ngroups');
    expect(fake.edits.log).toEqual(['stop', 'smart-filter', 'stop']);

    act(() => fake.created.editor?.trigger('', 'undo'));
    expect(text()).toBe('let a = 1;\nusers | take 5\n\ngroups');
  });
});
