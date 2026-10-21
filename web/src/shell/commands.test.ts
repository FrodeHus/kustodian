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

    // The run keys are the editor's alone: anywhere else Enter keeps its meaning (a focused button's, say).
    const button = document.createElement('button');
    document.body.append(button);
    key({ key: 'Enter', code: 'Enter', shiftKey: true }, button);
    key({ key: 'Enter', code: 'Enter', shiftKey: true });
    expect(runAll).not.toHaveBeenCalled();
    monaco.remove();
    button.remove();
  });

  it('in_a_text_field_only_the_palette_and_save_shortcuts_fire', () => {
    const ran: string[] = [];
    const cmd = (id: string, shortcut: string) => ({ id, title: id, group: 'Test', shortcut, run: () => ran.push(id) });
    keep(
      registerCommands([
        cmd('palette', 'Mod+K, Mod+Shift+P'),
        cmd('save', 'Mod+S'),
        cmd('tab.new', 'Mod+T'),
        cmd('format', 'Shift+Alt+F'),
        cmd('run.refresh', 'Mod+Shift+Enter'),
      ]),
    );
    keep(bindGlobalKeys());
    const input = document.createElement('input');
    const area = document.createElement('textarea');
    document.body.append(input, area);

    key({ key: 't', code: 'KeyT', ctrlKey: true }, input);
    key({ key: 'f', code: 'KeyF', shiftKey: true, altKey: true }, area);
    key({ key: 'Enter', code: 'Enter', ctrlKey: true, shiftKey: true }, input);
    expect(ran).toEqual([]);

    key({ key: 'k', code: 'KeyK', ctrlKey: true }, input);
    key({ key: 'P', code: 'KeyP', ctrlKey: true, shiftKey: true }, area);
    key({ key: 's', code: 'KeyS', ctrlKey: true }, input);
    expect(ran).toEqual(['palette', 'palette', 'save']);

    // Outside a field the others fire.
    key({ key: 't', code: 'KeyT', ctrlKey: true });
    key({ key: 'f', code: 'KeyF', shiftKey: true, altKey: true });
    expect(ran).toEqual(['palette', 'palette', 'save', 'tab.new', 'format']);
    input.remove();
    area.remove();
  });

  it('registering_an_id_or_shortcut_twice_warns', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    keep(registerCommands([{ id: 'a', title: 'A', group: 'Test', shortcut: 'Mod+J', run: () => undefined }]));

    keep(registerCommands([{ id: 'b', title: 'B', group: 'Test', shortcut: 'Ctrl+L, Mod+j', run: () => undefined }]));
    keep(registerCommands([{ id: 'c', title: 'C', group: 'Test', shortcut: 'Mod+Shift+J', run: () => undefined }]));
    keep(registerCommands([{ id: 'a', title: 'A again', group: 'Test', run: () => undefined }]));

    expect(warn.mock.calls.map((c) => c[0])).toEqual([
      'The shortcut Mod+j of b is also the shortcut of a.',
      'The command id a is registered twice.',
    ]);
    warn.mockRestore();
  });

  it('global_keys_do_nothing_while_their_guard_says_no', () => {
    const newTab = vi.fn();
    let active = false;
    keep(registerCommands([{ id: 'tab.new', title: 'New Microsoft Graph query', group: 'Tabs', shortcut: 'Mod+T', run: newTab }]));
    keep(bindGlobalKeys(() => active));

    const event = key({ key: 't', code: 'KeyT', ctrlKey: true });
    expect(newTab).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);

    active = true;
    key({ key: 't', code: 'KeyT', ctrlKey: true });
    expect(newTab).toHaveBeenCalledTimes(1);
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
