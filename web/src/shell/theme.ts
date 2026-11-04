import { create } from 'zustand';
import { writeSettings } from '../settings/settings-writes';
import type { Theme } from '../wire';

export type { Theme } from '../wire';

const THEMES: readonly Theme[] = ['dark', 'light', 'system', 'glass', 'liquid-glass'];

/** The glass themes: dark tokens over a colourful backdrop, with frosted panels. */
const isGlass = (theme: Theme) => theme === 'glass' || theme === 'liquid-glass';

/** The theme chosen, and what it comes to now (`system` follows the OS; the glass themes are dark). The editor picks its Monaco
 * theme from `resolved` and `glass`. */
export const useTheme = create<{ theme: Theme; resolved: 'dark' | 'light'; glass: boolean }>()(() => ({
  theme: 'dark',
  resolved: 'dark',
  glass: false,
}));

const LIGHT_QUERY = '(prefers-color-scheme: light)';
let stopFollowing: (() => void) | undefined;

function show(theme: Theme, light: boolean) {
  const root = document.documentElement.classList;
  root.toggle('theme-light', light);
  // Both glass themes share `.theme-glass`; liquid glass adds its own class on top.
  root.toggle('theme-glass', isGlass(theme));
  root.toggle('theme-liquid-glass', theme === 'liquid-glass');
  useTheme.setState({ theme, resolved: light ? 'light' : 'dark', glass: isGlass(theme) });
}

/** Applies a theme to the window at once: its classes on `<html>`, and for `system`, the OS's choice as it changes. */
export function applyTheme(theme: Theme): void {
  stopFollowing?.();
  stopFollowing = undefined;
  if (theme !== 'system') {
    show(theme, theme === 'light');
    return;
  }
  const query = window.matchMedia(LIGHT_QUERY);
  const onChange = (e: { matches: boolean }) => show('system', e.matches);
  query.addEventListener('change', onChange);
  stopFollowing = () => query.removeEventListener('change', onChange);
  show('system', query.matches);
}

/** The theme the host put in the start URL (`?theme=dark|light|system|glass|liquid-glass`); dark when it says nothing usable. */
export function initialTheme(search: string): Theme {
  const theme = new URLSearchParams(search).get('theme');
  return THEMES.find((t) => t === theme) ?? 'dark';
}

/** Applies a theme and keeps it in the settings, leaving the other settings as they are: the write waits for any other write
 * of the settings that is out (`writeSettings`), so neither undoes the other. */
export async function chooseTheme(theme: Theme): Promise<void> {
  applyTheme(theme);
  await writeSettings((settings) => ({ ...settings, theme }));
}
