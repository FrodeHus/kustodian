import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../fixtures/graph-schema.json';
import { registerCommands } from '../shell/commands';
import { applyTheme } from '../shell/theme';
import { useTabs } from '../tabs/tab-store';
import type { SchemaView } from '../wire';

// Monaco doesn't run in jsdom. A stand-in records what the editor registers, with Monaco's own KeyMod and KeyCode values.
const fake = vi.hoisted(() => {
  const KeyMod = { CtrlCmd: 2048, Shift: 1024, Alt: 512, WinCtrl: 256 };
  const KeyCode = { Enter: 3, KeyK: 41, KeyP: 46, KeyT: 50, KeyW: 53 };
  const commands = new Map<number, () => void>();
  const created = { options: null as unknown };
  const themes = { defined: [] as string[], set: [] as string[] };
  let selectionEmpty = true;
  const disposable = { dispose: () => undefined };
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
  const editor = {
    addCommand: (keybinding: number, handler: () => void) => {
      commands.set(keybinding, handler);
      return null;
    },
    getSelection: () => ({ isEmpty: () => selectionEmpty }),
    onDidChangeModelContent: () => disposable,
    onDidChangeCursorSelection: () => disposable,
    setModel: () => undefined,
    getModel: () => null,
    saveViewState: () => null,
    restoreViewState: () => undefined,
    focus: () => undefined,
    dispose: () => undefined,
  };
  const monaco = {
    KeyMod,
    KeyCode,
    Uri: { parse: (s: string) => ({ toString: () => s }) },
    editor: {
      create: (_host: unknown, options: unknown) => {
        created.options = options;
        return editor;
      },
      createModel: (value: string, _language: string, uri: { toString: () => string }) => model(value, uri),
      defineTheme: (name: string) => themes.defined.push(name),
      setTheme: (name: string) => themes.set.push(name),
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
    commands,
    created,
    themes,
    providers,
    model,
    setSelectionEmpty: (empty: boolean) => (selectionEmpty = empty),
    press: (keybinding: number) => commands.get(keybinding)?.(),
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

const { default: KqlEditor } = await import('./kql-editor');

const huntingView: SchemaView = {
  source: 'hunting',
  origin: 'tenant',
  fallbackReason: null,
  generatedAt: '2026-10-21T00:00:00Z',
  tables: [{ name: 'DeviceInfo', path: null, description: '', docsUrl: null, permissions: null, columns: [] }],
  functions: [],
  complexTypes: {},
};

beforeEach(() => {
  fake.commands.clear();
  fake.themes.set.length = 0;
  applyTheme('dark');
  fake.setSelectionEmpty(true);
  fake.kustoWorker = () => new Promise(() => undefined);
  fake.providers.length = 0;
  bridge.call.mockReset();
  bridge.call.mockResolvedValue([]);
  useTabs.setState({ tabs: [], activeId: null, cursors: {} });
  useTabs.getState().open('graph');
});

describe('KqlEditor', () => {
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
    expect(fake.commands.has(KeyMod.CtrlCmd | KeyCode.Enter)).toBe(true);
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
    expect(fake.themes.defined).toEqual(expect.arrayContaining(['kustodian-dark', 'kustodian-light']));

    act(() => applyTheme('light'));
    expect(fake.themes.set.at(-1)).toBe('kustodian-light');
    act(() => applyTheme('dark'));
    expect(fake.themes.set.at(-1)).toBe('kustodian-dark');
  });
});
