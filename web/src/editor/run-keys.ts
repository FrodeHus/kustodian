import type { RunMode } from '../tabs/tab-store';

/** The part of Monaco's editor the run keys need. */
export interface RunKeyEditor {
  addCommand(keybinding: number, handler: () => void): unknown;
  getSelection(): { isEmpty(): boolean } | null;
}

/** Monaco's `KeyMod.CtrlCmd`, `KeyMod.Shift` and `KeyCode.Enter`. */
export interface RunKeyCodes {
  CtrlCmd: number;
  Shift: number;
  Enter: number;
}

/**
 * Spec 6.2: Ctrl/Cmd+Enter runs the block at the cursor, or only the selection when there is one; Shift+Enter runs the whole tab.
 * Both replace what the keys would do in the editor (insert a line).
 */
export function bindRunKeys(editor: RunKeyEditor, keys: RunKeyCodes, onRun: (mode: RunMode) => void): void {
  editor.addCommand(keys.CtrlCmd | keys.Enter, () => {
    const selection = editor.getSelection();
    onRun(selection && !selection.isEmpty() ? 'selection' : 'block');
  });
  editor.addCommand(keys.Shift | keys.Enter, () => onRun('all'));
}
