import { create } from 'zustand';
import { writeSettings } from '../settings/settings-writes';
import type { Theme } from '../wire';

export type { Theme } from '../wire';

/** The theme chosen, and what it comes to now (`system` follows the OS). The editor picks its Monaco theme from `resolved`. */
export const useTheme = create<{ theme: Theme; resolved: 'dark' | 'light' }>()(() => ({ theme: 'dark', resolved: 'dark' }));

const LIGHT_QUERY = '(prefers-color-scheme: light)';
let stopFollowing: (() => void) | undefined;

function show(theme: Theme, light: boolean) {
  document.documentElement.classList.toggle('theme-light', light);
  useTheme.setState({ theme, resolved: light ? 'light' : 'dark' });
}

/** Applies a theme to the window at once: `.theme-light` on `<html>`, and for `system`, the OS's choice as it changes. */
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

/** The theme the host put in the start URL (`?theme=dark|light|system`); dark when it says nothing usable. */
export function initialTheme(search: string): Theme {
  const theme = new URLSearchParams(search).get('theme');
  return theme === 'light' || theme === 'system' ? theme : 'dark';
}

/** Applies a theme and keeps it in the settings, leaving the other settings as they are: the write waits for any other write
 * of the settings that is out (`writeSettings`), so neither undoes the other. */
export async function chooseTheme(theme: Theme): Promise<void> {
  applyTheme(theme);
  await writeSettings((settings) => ({ ...settings, theme }));
}
