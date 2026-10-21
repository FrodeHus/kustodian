import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../fixtures/graph-schema.json';
import { useTabs } from '../tabs/tab-store';
import type { SchemaView } from '../wire';

// Monaco doesn't run in jsdom. A stand-in records what the editor registers, with Monaco's own KeyMod and KeyCode values.
const fake = vi.hoisted(() => {
  const KeyMod = { CtrlCmd: 2048, Shift: 1024, Alt: 512, WinCtrl: 256 };
  const KeyCode = { Enter: 3 };
  const commands = new Map<number, () => void>();
  let selectionEmpty = true;
  const disposable = { dispose: () => undefined };
  const model = (value: string) => {
    let text = value;
    return { getValue: () => text, setValue: (v: string) => (text = v), dispose: () => undefined, uri: { toString: () => 'x' } };
  };
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
      create: () => editor,
      createModel: (value: string) => model(value),
      defineTheme: () => undefined,
      setTheme: () => undefined,
    },
    languages: { registerCompletionItemProvider: () => disposable },
  };
  return {
    monaco,
    commands,
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
vi.mock('../bridge', () => ({ call: vi.fn(), on: () => () => undefined }));

const { default: KqlEditor } = await import('./kql-editor');

beforeEach(() => {
  fake.commands.clear();
  fake.setSelectionEmpty(true);
  fake.kustoWorker = () => new Promise(() => undefined);
  useTabs.setState({ tabs: [], activeId: null, cursors: {} });
  useTabs.getState().open('graph');
});

describe('KqlEditor', () => {
  it('ctrl_enter_runs_block_shift_enter_runs_all', () => {
    const onRun = vi.fn();
    render(<KqlEditor schema={null} onRun={onRun} />);
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
    render(<KqlEditor schema={schema as SchemaView} onRun={() => undefined} />);

    expect((await screen.findByRole('status')).textContent).toMatch(/Schema not loaded in the editor/);

    act(() => {
      useTabs.getState().open('graph');
    });
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
    expect(setSchema).toHaveBeenCalledTimes(2);
  });
});
