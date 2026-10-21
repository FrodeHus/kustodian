import { afterEach, describe, expect, it, vi } from 'vitest';
import { allCommands, bindGlobalKeys, formatShortcut, matchScore, registerCommands, runCommand } from './commands';

let cleanups: (() => void)[] = [];
const keep = (cleanup: () => void) => cleanups.push(cleanup);

afterEach(() => {
  cleanups.forEach((c) => c());
  cleanups = [];
});

const key = (init: KeyboardEventInit, target: EventTarget = document.body) => {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
};

describe('commands', () => {
  it('global_keys_run_registered_command', () => {
    const newTab = vi.fn();
    const runAll = vi.fn();
    keep(
      registerCommands([
        { id: 'tab.new', title: 'New Microsoft Graph query', group: 'Tabs', shortcut: 'Mod+T', run: newTab },
        { id: 'run.all', title: 'Run all', group: 'Run', shortcut: 'Shift+Enter', run: runAll },
      ]),
    );
    keep(bindGlobalKeys());

    // Not a Mac in jsdom: Mod is Ctrl. Letters match by the physical key.
    const event = key({ key: 't', code: 'KeyT', ctrlKey: true });
    expect(newTab).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);

    // Other modifiers are another shortcut.
    key({ key: 'T', code: 'KeyT', ctrlKey: true, shiftKey: true });
    expect(newTab).toHaveBeenCalledTimes(1);

    // Monaco binds the same shortcuts itself, so keys typed in the editor are left to it.
    const monaco = document.createElement('div');
    monaco.className = 'monaco-editor';
    const inner = document.createElement('textarea');
    monaco.append(inner);
    document.body.append(monaco);
    key({ key: 't', code: 'KeyT', ctrlKey: true }, inner);
    expect(newTab).toHaveBeenCalledTimes(1);

    // A shortcut without Ctrl or Alt doesn't fire while typing in a field.
    const input = document.createElement('input');
    document.body.append(input);
    key({ key: 'Enter', code: 'Enter', shiftKey: true }, input);
    expect(runAll).not.toHaveBeenCalled();
    key({ key: 'Enter', code: 'Enter', shiftKey: true });
    expect(runAll).toHaveBeenCalledTimes(1);
    monaco.remove();
    input.remove();
  });

  it('a_disabled_command_does_not_run', () => {
    const cancel = vi.fn();
    keep(registerCommands([{ id: 'run.cancel', title: 'Cancel the run', group: 'Run', shortcut: 'Mod+.', run: cancel, enabled: () => false }]));
    keep(bindGlobalKeys());

    const event = key({ key: '.', code: 'Period', ctrlKey: true });
    runCommand('run.cancel');

    expect(cancel).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it('unregistering_removes_the_commands', () => {
    const unregister = registerCommands([{ id: 'cache.clear', title: 'Clear the cache', group: 'Graph', run: () => undefined }]);
    expect(allCommands().map((c) => c.id)).toContain('cache.clear');
    unregister();
    expect(allCommands().map((c) => c.id)).not.toContain('cache.clear');
  });

  it('shortcuts_are_written_for_the_platform', () => {
    expect(formatShortcut('Mod+K, Mod+Shift+P')).toEqual(['Ctrl K', 'Ctrl Shift P']);
    expect(formatShortcut('Shift+Alt+F')).toEqual(['Shift Alt F']);
    expect(formatShortcut(undefined)).toEqual([]);
  });

  it('match_is_a_case_insensitive_subsequence', () => {
    expect(matchScore('exp', 'Explain the query')).not.toBeNull();
    expect(matchScore('rnal', 'Run all')).not.toBeNull();
    expect(matchScore('xyz', 'Run all')).toBeNull();
    expect(matchScore('', 'Run all')).toBe(0);
    // Letters together and at the start score better (lower) than letters spread out.
    expect(matchScore('run', 'Run all')!).toBeLessThan(matchScore('run', 'Restore unsaved notes')!);
  });
});
