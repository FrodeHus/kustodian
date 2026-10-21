import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTabs } from '../tabs/tab-store';

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
  };
});

vi.mock('monaco-editor/esm/vs/editor/edcore.main.js', () => ({}));
vi.mock('monaco-editor/esm/vs/editor/editor.api.js', () => fake.monaco);
vi.mock('monaco-editor/esm/vs/editor/editor.worker.js?worker', () => ({ default: class {} }));
vi.mock('./kusto.worker?worker', () => ({ default: class {} }));
vi.mock('@kusto/monaco-kusto/release/esm/monaco.contribution.js', () => ({ getKustoWorker: () => new Promise(() => undefined) }));
vi.mock('../bridge', () => ({ call: vi.fn(), on: () => () => undefined }));

const { default: KqlEditor } = await import('./kql-editor');

beforeEach(() => {
  fake.commands.clear();
  fake.setSelectionEmpty(true);
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
});
