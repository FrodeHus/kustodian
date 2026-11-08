import { create } from 'zustand';
import { writeSettings } from '../settings/settings-writes';
import type { Theme } from '../wire';
import { PALETTES, isPalette, paletteVars } from './palettes';

export type { Theme } from '../wire';

/** Every theme, in the order Settings and the palette list them. */
export const THEMES: readonly Theme[] = ['dark', 'light', 'system', 'glass', 'liquid-glass', ...(Object.keys(PALETTES) as Theme[])];

const NAMES: Record<string, string> = { dark: 'Dark', light: 'Light', system: 'System', glass: 'Glass', 'liquid-glass': 'Liquid glass' };

/** A theme's name as the window shows it. */
export const themeName = (theme: Theme): string => (isPalette(theme) ? PALETTES[theme].name : NAMES[theme]!);

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

/** The <style> element that holds the palette theme's tokens. */
function paletteSheet(): HTMLStyleElement {
  let sheet = document.getElementById('palette-theme') as HTMLStyleElement | null;
  if (!sheet) {
    sheet = document.head.appendChild(document.createElement('style'));
    sheet.id = 'palette-theme';
  }
  return sheet;
}

function show(theme: Theme, light: boolean) {
  const root = document.documentElement.classList;
  root.toggle('theme-light', light);
  // Both glass themes share `.theme-glass`; liquid glass adds its own class on top.
  root.toggle('theme-glass', isGlass(theme));
  root.toggle('theme-liquid-glass', theme === 'liquid-glass');
  root.toggle('theme-aurora', theme === 'aurora');
  // A palette theme sets the tokens over the dark ones, on screen only (print is always light); any other theme clears them.
  paletteSheet().textContent = isPalette(theme)
    ? `@media screen { :root { ${Object.entries(paletteVars(PALETTES[theme])).map(([name, value]) => `${name}: ${value};`).join(' ')} } }`
    : '';
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
