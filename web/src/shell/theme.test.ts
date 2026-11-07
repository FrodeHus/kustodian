import { afterEach, describe, expect, it, vi } from 'vitest';
import { THEMES, applyTheme, chooseTheme, initialTheme, themeName, useTheme } from './theme';

const bridge = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../bridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../bridge')>()),
  call: bridge.call,
  on: () => () => undefined,
}));

/** jsdom has no `matchMedia`: a stand-in whose answer the test changes, telling its listeners as the browser does. */
function stubMatchMedia(light: boolean) {
  const listeners = new Set<(e: { matches: boolean }) => void>();
  const query = {
    matches: light,
    media: '(prefers-color-scheme: light)',
    addEventListener: (_: string, l: (e: { matches: boolean }) => void) => listeners.add(l),
    removeEventListener: (_: string, l: (e: { matches: boolean }) => void) => listeners.delete(l),
  };
  const matchMedia = vi.fn(() => query);
  vi.stubGlobal('matchMedia', matchMedia);
  return {
    matchMedia,
    listeners,
    change(next: boolean) {
      query.matches = next;
      listeners.forEach((l) => l({ matches: next }));
    },
  };
}

const isLight = () => document.documentElement.classList.contains('theme-light');

afterEach(() => {
  applyTheme('dark');
  vi.unstubAllGlobals();
  bridge.call.mockReset();
});

describe('theme', () => {
  it('theme_system_follows_media_query', () => {
    const os = stubMatchMedia(false);

    applyTheme('system');
    expect(os.matchMedia).toHaveBeenCalledWith('(prefers-color-scheme: light)');
    expect(isLight()).toBe(false);
    expect(useTheme.getState()).toEqual({ theme: 'system', resolved: 'dark', glass: false });

    os.change(true);
    expect(isLight()).toBe(true);
    expect(useTheme.getState().resolved).toBe('light');

    // A chosen theme stops following the OS.
    applyTheme('dark');
    expect(os.listeners.size).toBe(0);
    os.change(true);
    expect(isLight()).toBe(false);
  });

  it('initial_theme_from_query_string', () => {
    expect(initialTheme('?theme=light')).toBe('light');
    expect(initialTheme('?theme=system')).toBe('system');
    expect(initialTheme('?theme=dark')).toBe('dark');
    expect(initialTheme('?theme=glass')).toBe('glass');
    expect(initialTheme('?theme=liquid-glass')).toBe('liquid-glass');
    expect(initialTheme('?theme=neon')).toBe('dark');
    expect(initialTheme('')).toBe('dark');

    applyTheme(initialTheme('?theme=light'));
    expect(isLight()).toBe(true);
    expect(useTheme.getState()).toEqual({ theme: 'light', resolved: 'light', glass: false });
  });

  it('glass_themes_are_dark_with_their_own_classes', () => {
    const root = document.documentElement.classList;

    applyTheme('liquid-glass');
    expect([root.contains('theme-glass'), root.contains('theme-liquid-glass'), isLight()]).toEqual([true, true, false]);
    expect(useTheme.getState()).toEqual({ theme: 'liquid-glass', resolved: 'dark', glass: true });

    applyTheme('glass');
    expect([root.contains('theme-glass'), root.contains('theme-liquid-glass')]).toEqual([true, false]);

    applyTheme('light');
    expect([root.contains('theme-glass'), root.contains('theme-liquid-glass'), isLight()]).toEqual([false, false, true]);
  });

  it('palette_themes_set_the_tokens_and_other_themes_clear_them', () => {
    const sheet = () => document.getElementById('palette-theme')?.textContent ?? '';
    const accent = () => /--accent: ([^;]+);/.exec(sheet())?.[1] ?? '';

    applyTheme('dracula');
    expect(accent()).toBe('#bd93f9');
    expect(/--accent-soft: ([^;]+);/.exec(sheet())?.[1]).toContain('#bd93f9');
    // On screen only: print is always light.
    expect(sheet()).toMatch(/^@media screen \{ :root \{/);
    expect(useTheme.getState()).toEqual({ theme: 'dracula', resolved: 'dark', glass: false });

    applyTheme('gruvbox-dark');
    expect(accent()).toBe('#fabd2f');

    applyTheme('light');
    expect(accent()).toBe('');
    expect(isLight()).toBe(true);
  });

  it('every_theme_has_a_name_and_survives_the_start_url', () => {
    expect(THEMES).toHaveLength(15);
    for (const theme of THEMES) {
      expect(themeName(theme)).toMatch(/^[A-Z]/);
      expect(initialTheme(`?theme=${theme}`)).toBe(theme);
    }
  });

  it('choosing_a_theme_applies_it_and_keeps_the_other_settings', async () => {
    const settings = { version: 1, theme: 'dark', rawDefaultVersion: 'v1.0', signIn: { clientId: 'c', tenant: 't' }, limits: { fetchBudgetMb: 64 } };
    bridge.call.mockImplementation((method: string, params?: { settings: unknown }) =>
      Promise.resolve({ settings: method === 'settings.set' ? params?.settings : settings, restartNeeded: false, corrupt: false, unreadable: false }),
    );

    await chooseTheme('light');

    expect(isLight()).toBe(true);
    expect(bridge.call).toHaveBeenLastCalledWith('settings.set', { settings: { ...settings, theme: 'light' } });
  });
});
