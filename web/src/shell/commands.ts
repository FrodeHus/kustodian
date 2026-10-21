import { IS_MAC, MOD } from './keys';

/**
 * An action of the window (spec 6.11: every action is a command, and the palette lists each with its shortcut).
 *
 * `shortcut` is written as `Mod+Shift+P`: `Mod` is Ctrl, or Cmd on macOS; `Ctrl` is the Control key on every platform; then
 * `Shift` and `Alt`, and last the key (a letter, a digit, `.`, or a key name such as `Enter`, `Tab` or `F5`). Alternatives are
 * separated by commas: `Mod+K, Mod+Shift+P`.
 */
export type Command = {
  id: string;
  title: string;
  shortcut?: string;
  group: string;
  run: () => void;
  enabled?: () => boolean;
};

/** One key combination of a shortcut. */
export interface Chord {
  mod: boolean;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  key: string;
}

const registry = new Map<string, Command>();
const watchers = new Set<() => void>();

const changed = () => watchers.forEach((w) => w());

/** Adds commands (a command with an id already there replaces it); returns the function that removes them again. */
export function registerCommands(cmds: Command[]): () => void {
  for (const cmd of cmds) {
    registry.set(cmd.id, cmd);
  }
  changed();
  return () => {
    for (const cmd of cmds) {
      // Only if it is still this one: a later registration under the same id stays.
      if (registry.get(cmd.id) === cmd) {
        registry.delete(cmd.id);
      }
    }
    changed();
  };
}

/** The registered commands, in the order they were registered. */
export function allCommands(): Command[] {
  return [...registry.values()];
}

/** Calls `watcher` whenever commands are registered or removed; returns the function that stops it. */
export function watchCommands(watcher: () => void): () => void {
  watchers.add(watcher);
  return () => {
    watchers.delete(watcher);
  };
}

const isEnabled = (cmd: Command) => cmd.enabled?.() ?? true;

/** Runs a command when it is registered and enabled; returns whether it ran. */
export function runCommand(id: string): boolean {
  const cmd = registry.get(id);
  if (!cmd || !isEnabled(cmd)) {
    return false;
  }
  cmd.run();
  return true;
}

/** A shortcut's key combinations. */
export function parseShortcut(shortcut: string | undefined): Chord[] {
  if (!shortcut) {
    return [];
  }
  return shortcut
    .split(',')
    .map((alt) => alt.trim())
    .filter((alt) => alt !== '')
    .map((alt) => {
      const parts = alt.split('+');
      // The key is last; `Mod+.` and a lone `+` key both keep their key.
      const key = parts.pop() || '+';
      return { mod: parts.includes('Mod'), ctrl: parts.includes('Ctrl'), shift: parts.includes('Shift'), alt: parts.includes('Alt'), key };
    });
}

/** How a shortcut is shown: one string per alternative, such as `Ctrl Shift P` or `⌘ Shift P`. */
export function formatShortcut(shortcut: string | undefined): string[] {
  return parseShortcut(shortcut).map((c) =>
    [c.mod && MOD, c.ctrl && 'Ctrl', c.shift && 'Shift', c.alt && 'Alt', c.key].filter((p): p is string => !!p).join(' '),
  );
}

/** Whether a key event is this combination. Letters and digits match by the key pressed, whatever the layout or Alt makes of
 * them; other keys by name. */
export function matchesChord(e: KeyboardEvent, c: Chord): boolean {
  const ctrl = c.ctrl || (c.mod && !IS_MAC);
  const meta = c.mod && IS_MAC;
  if (e.ctrlKey !== ctrl || e.metaKey !== meta || e.shiftKey !== c.shift || e.altKey !== c.alt) {
    return false;
  }
  if (/^[A-Za-z]$/.test(c.key)) {
    return e.code === `Key${c.key.toUpperCase()}`;
  }
  if (/^[0-9]$/.test(c.key)) {
    return e.code === `Digit${c.key}`;
  }
  return c.key === '.' ? e.code === 'Period' : e.key === c.key;
}

function isEditable(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || target.isContentEditable)
  );
}

/**
 * One keydown listener for the window that runs the command whose shortcut was pressed. Keys pressed in the editor are left to
 * it (it binds the same shortcuts), and so are keys something else already handled. A shortcut without Ctrl, Cmd or Alt
 * doesn't fire while typing in a field. Returns the function that removes the listener.
 */
export function bindGlobalKeys(): () => void {
  const onKey = (e: KeyboardEvent) => {
    if (e.defaultPrevented || (e.target instanceof Element && e.target.closest('.monaco-editor'))) {
      return;
    }
    for (const cmd of registry.values()) {
      const chord = parseShortcut(cmd.shortcut).find((c) => matchesChord(e, c));
      if (!chord) {
        continue;
      }
      if ((!chord.mod && !chord.ctrl && !chord.alt && isEditable(e.target)) || !isEnabled(cmd)) {
        return;
      }
      e.preventDefault();
      cmd.run();
      return;
    }
  };
  window.addEventListener('keydown', onKey);
  return () => window.removeEventListener('keydown', onKey);
}

/**
 * How well `query` matches `text` as a case-insensitive subsequence: null when it doesn't, else a score where lower is
 * better (letters that follow each other, and an early first letter, score better).
 */
export function matchScore(query: string, text: string): number | null {
  const q = query.toLowerCase().replace(/\s+/g, '');
  const t = text.toLowerCase();
  let score = 0;
  let last = -1;
  for (const ch of q) {
    const at = t.indexOf(ch, last + 1);
    if (at < 0) {
      return null;
    }
    score += last < 0 ? at : at - last - 1;
    last = at;
  }
  return score;
}
