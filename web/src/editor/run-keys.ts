import { allCommands, parseShortcut, runCommand, watchCommands, type Chord } from '../shell/commands';
import { IS_MAC } from '../shell/keys';
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
 * Both replace what the keys would do in the editor (insert a line). Returns the keybindings it took.
 */
export function bindRunKeys(editor: RunKeyEditor, keys: RunKeyCodes, onRun: (mode: RunMode) => void): number[] {
  editor.addCommand(keys.CtrlCmd | keys.Enter, () => {
    const selection = editor.getSelection();
    onRun(selection && !selection.isEmpty() ? 'selection' : 'block');
  });
  editor.addCommand(keys.Shift | keys.Enter, () => onRun('all'));
  return [keys.CtrlCmd | keys.Enter, keys.Shift | keys.Enter];
}

/** Monaco's `KeyMod` and `KeyCode`, as far as command shortcuts need them. */
export interface CommandKeyCodes {
  KeyMod: { CtrlCmd: number; Shift: number; Alt: number; WinCtrl: number };
  KeyCode: Record<string, number | string>;
}

/** A shortcut's combination as a Monaco keybinding, or null when Monaco has no code for its key. */
export function monacoKeybinding(chord: Chord, { KeyMod, KeyCode }: CommandKeyCodes): number | null {
  const name = /^[A-Za-z]$/.test(chord.key)
    ? `Key${chord.key.toUpperCase()}`
    : /^[0-9]$/.test(chord.key)
      ? `Digit${chord.key}`
      : chord.key === '.'
        ? 'Period'
        : chord.key;
  const code = KeyCode[name];
  if (typeof code !== 'number') {
    return null;
  }
  // Monaco's WinCtrl is the Control key on macOS but the Windows key elsewhere, where CtrlCmd is Control.
  const ctrl = chord.ctrl ? (IS_MAC ? KeyMod.WinCtrl : KeyMod.CtrlCmd) : 0;
  return (chord.mod ? KeyMod.CtrlCmd : 0) | ctrl | (chord.shift ? KeyMod.Shift : 0) | (chord.alt ? KeyMod.Alt : 0) | code;
}

/**
 * Binds every registered command's shortcut in the editor, so it works there as it does in the rest of the window (where
 * `bindGlobalKeys` leaves keys typed in the editor to it), now and as commands are registered later. A key that `taken` holds
 * keeps what it does in the editor. Each binding runs whichever command has that shortcut when it is pressed. Returns the
 * function that stops binding new ones; Monaco can't remove a binding, and one whose command is gone does nothing.
 */
export function bindCommandKeys(editor: Pick<RunKeyEditor, 'addCommand'>, codes: CommandKeyCodes, taken: number[]): () => void {
  const bound = new Set(taken);
  const commandFor = (keybinding: number) =>
    allCommands().find((c) => parseShortcut(c.shortcut).some((chord) => monacoKeybinding(chord, codes) === keybinding));
  const bindAll = () => {
    for (const cmd of allCommands()) {
      for (const chord of parseShortcut(cmd.shortcut)) {
        const keybinding = monacoKeybinding(chord, codes);
        if (keybinding !== null && !bound.has(keybinding)) {
          bound.add(keybinding);
          editor.addCommand(keybinding, () => {
            const current = commandFor(keybinding);
            if (current) {
              runCommand(current.id);
            }
          });
        }
      }
    }
  };
  bindAll();
  return watchCommands(bindAll);
}
