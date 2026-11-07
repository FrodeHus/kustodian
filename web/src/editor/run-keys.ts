import { allCommands, parseShortcut, runCommand, watchCommands, type Chord } from '../shell/commands';
import { IS_MAC } from '../shell/keys';
import type { RunMode } from '../tabs/tab-store';

/** The part of Monaco's editor the run keys need. Keys go in as actions: `addCommand` binds a key for every editor, last one
 * wins and disposing the editor doesn't remove it, while an action's key is its editor's own and goes with `dispose`. */
export interface RunKeyEditor {
  addAction(action: { id: string; label: string; keybindings: number[]; run: () => void }): { dispose(): void };
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
 * Both replace what the keys would do in the editor (insert a line). Returns the keybindings it took and what unbinds them.
 */
export function bindRunKeys(editor: RunKeyEditor, keys: RunKeyCodes, onRun: (mode: RunMode) => void): { taken: number[]; dispose: () => void } {
  const block = editor.addAction({
    id: 'kustodian.run.block',
    label: 'Run the block',
    keybindings: [keys.CtrlCmd | keys.Enter],
    run: () => {
      const selection = editor.getSelection();
      onRun(selection && !selection.isEmpty() ? 'selection' : 'block');
    },
  });
  const all = editor.addAction({ id: 'kustodian.run.all', label: 'Run all', keybindings: [keys.Shift | keys.Enter], run: () => onRun('all') });
  return {
    taken: [keys.CtrlCmd | keys.Enter, keys.Shift | keys.Enter],
    dispose: () => {
      block.dispose();
      all.dispose();
    },
  };
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
 * keeps what it does in the editor. Each binding runs whichever command has that shortcut when it is pressed; one whose command
 * is gone does nothing. Returns the function that unbinds them all and stops binding new ones.
 */
export function bindCommandKeys(editor: Pick<RunKeyEditor, 'addAction'>, codes: CommandKeyCodes, taken: number[]): () => void {
  const bound = new Set(taken);
  const actions: { dispose(): void }[] = [];
  const commandFor = (keybinding: number) =>
    allCommands().find((c) => parseShortcut(c.shortcut).some((chord) => monacoKeybinding(chord, codes) === keybinding));
  const bindAll = () => {
    for (const cmd of allCommands()) {
      for (const chord of parseShortcut(cmd.shortcut)) {
        const keybinding = monacoKeybinding(chord, codes);
        if (keybinding !== null && !bound.has(keybinding)) {
          bound.add(keybinding);
          actions.push(
            editor.addAction({
              id: `kustodian.command.${keybinding}`,
              label: cmd.title,
              keybindings: [keybinding],
              run: () => {
                const current = commandFor(keybinding);
                if (current) {
                  runCommand(current.id);
                }
              },
            }),
          );
        }
      }
    }
  };
  bindAll();
  const stop = watchCommands(bindAll);
  return () => {
    stop();
    actions.forEach((a) => a.dispose());
  };
}
