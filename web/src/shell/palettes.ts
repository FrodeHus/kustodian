import type { PaletteTheme } from '../wire';

/** A theme's colours, one per design token of styles.css (`--bg`, `--panel` ...); the soft tints are mixed from them. */
export type Palette = {
  name: string;
  bg: string;
  panel: string;
  panel2: string;
  raise: string;
  line: string;
  text: string;
  muted: string;
  faint: string;
  accent: string;
  accentInk: string;
  warn: string;
  bad: string;
  ok: string;
  /** Syntax: keywords and operators, tables, columns, strings, numbers, functions, comments. */
  kw: string;
  tbl: string;
  col: string;
  str: string;
  num: string;
  fn: string;
  cm: string;
};

/** Aurora, Kustodian's own: the logo's and banner's cyan, blue, violet and mint on navy ink (`.theme-aurora` in styles.css adds its
 * glow and tinted cards). Then the ten most used editor themes (VS Code Marketplace installs and GitHub stars, November 2026), each in its flagship dark
 * variant. The editor colours are the themes' own; the window's panels and lines are picked from each theme's UI colours. */
export const PALETTES: Record<PaletteTheme, Palette> = {
  aurora: {
    name: 'Aurora',
    bg: '#0a0c1c', panel: '#12152f', panel2: '#161a3a', raise: '#1e2350', line: '#272c55',
    text: '#e8ecf8', muted: '#a6aecd', faint: '#8089b0',
    accent: '#22e4f5', accentInk: '#04141c', warn: '#ffc46b', bad: '#ff8da0', ok: '#3ef0c0',
    kw: '#c3a2ff', tbl: '#22e4f5', col: '#ffd27a', str: '#6ff0c8', num: '#ff9e6b', fn: '#7fb0ff', cm: '#8089b0',
  },
  'github-dark': {
    name: 'GitHub Dark',
    bg: '#0d1117', panel: '#010409', panel2: '#161b22', raise: '#21262d', line: '#30363d',
    text: '#e6edf3', muted: '#9198a1', faint: '#7d8590',
    accent: '#4493f8', accentInk: '#ffffff', warn: '#d29922', bad: '#f85149', ok: '#3fb950',
    kw: '#ff7b72', tbl: '#79c0ff', col: '#ffa657', str: '#a5d6ff', num: '#79c0ff', fn: '#d2a8ff', cm: '#8b949e',
  },
  'one-dark': {
    name: 'One Dark',
    bg: '#282c34', panel: '#21252b', panel2: '#2c313a', raise: '#323842', line: '#3e4451',
    text: '#d7dae0', muted: '#abb2bf', faint: '#8b929e',
    accent: '#61afef', accentInk: '#1b1f27', warn: '#e5c07b', bad: '#e06c75', ok: '#98c379',
    kw: '#c678dd', tbl: '#e5c07b', col: '#e06c75', str: '#98c379', num: '#d19a66', fn: '#61afef', cm: '#7f848e',
  },
  dracula: {
    name: 'Dracula',
    bg: '#282a36', panel: '#21222c', panel2: '#2d2f3d', raise: '#343746', line: '#44475a',
    text: '#f8f8f2', muted: '#c4c6d4', faint: '#8b93bd',
    accent: '#bd93f9', accentInk: '#21222c', warn: '#ffb86c', bad: '#ff5555', ok: '#50fa7b',
    kw: '#ff79c6', tbl: '#8be9fd', col: '#ffb86c', str: '#f1fa8c', num: '#bd93f9', fn: '#50fa7b', cm: '#8b93bd',
  },
  material: {
    name: 'Material',
    bg: '#263238', panel: '#1e282d', panel2: '#2b3a42', raise: '#314549', line: '#37474f',
    text: '#eeffff', muted: '#b0bec5', faint: '#8a9ba3',
    accent: '#80cbc4', accentInk: '#14211f', warn: '#ffcb6b', bad: '#f07178', ok: '#c3e88d',
    kw: '#c792ea', tbl: '#ffcb6b', col: '#f07178', str: '#c3e88d', num: '#f78c6c', fn: '#82aaff', cm: '#7d939c',
  },
  monokai: {
    name: 'Monokai',
    bg: '#272822', panel: '#1e1f1c', panel2: '#2d2e27', raise: '#3e3d32', line: '#49483e',
    text: '#f8f8f2', muted: '#cfcfc2', faint: '#a09e8a',
    accent: '#a6e22e', accentInk: '#1e1f1c', warn: '#fd971f', bad: '#f92672', ok: '#a6e22e',
    kw: '#f92672', tbl: '#66d9ef', col: '#fd971f', str: '#e6db74', num: '#ae81ff', fn: '#a6e22e', cm: '#959178',
  },
  'ayu-dark': {
    name: 'Ayu Dark',
    bg: '#0b0e14', panel: '#0d1017', panel2: '#131721', raise: '#1b1f29', line: '#1e232b',
    text: '#bfbdb6', muted: '#a6a49d', faint: '#7c8089',
    accent: '#e6b450', accentInk: '#0b0e14', warn: '#ffb454', bad: '#f07178', ok: '#aad94c',
    kw: '#ff8f40', tbl: '#39bae6', col: '#f29668', str: '#aad94c', num: '#d2a6ff', fn: '#ffb454', cm: '#7c8089',
  },
  'night-owl': {
    name: 'Night Owl',
    bg: '#011627', panel: '#01111d', panel2: '#0b2942', raise: '#13344f', line: '#1d3b53',
    text: '#d6deeb', muted: '#a7b4c6', faint: '#7f95a8',
    accent: '#82aaff', accentInk: '#011627', warn: '#ffcb8b', bad: '#ef5350', ok: '#addb67',
    kw: '#c792ea', tbl: '#ffcb8b', col: '#7fdbca', str: '#ecc48d', num: '#f78c6c', fn: '#82aaff', cm: '#7f95a8',
  },
  'tokyo-night': {
    name: 'Tokyo Night',
    bg: '#1a1b26', panel: '#16161e', panel2: '#1f2335', raise: '#292e42', line: '#2a2e42',
    text: '#c0caf5', muted: '#a9b1d6', faint: '#7b84ad',
    accent: '#7aa2f7', accentInk: '#16161e', warn: '#e0af68', bad: '#f7768e', ok: '#9ece6a',
    kw: '#bb9af7', tbl: '#2ac3de', col: '#73daca', str: '#9ece6a', num: '#ff9e64', fn: '#7aa2f7', cm: '#7b84ad',
  },
  'catppuccin-mocha': {
    name: 'Catppuccin Mocha',
    bg: '#1e1e2e', panel: '#181825', panel2: '#232334', raise: '#313244', line: '#45475a',
    text: '#cdd6f4', muted: '#bac2de', faint: '#9399b2',
    accent: '#89b4fa', accentInk: '#11111b', warn: '#f9e2af', bad: '#f38ba8', ok: '#a6e3a1',
    kw: '#cba6f7', tbl: '#f9e2af', col: '#94e2d5', str: '#a6e3a1', num: '#fab387', fn: '#89b4fa', cm: '#9399b2',
  },
  'gruvbox-dark': {
    name: 'Gruvbox Dark',
    bg: '#282828', panel: '#1d2021', panel2: '#32302f', raise: '#3c3836', line: '#504945',
    text: '#ebdbb2', muted: '#d5c4a1', faint: '#a89984',
    accent: '#fabd2f', accentInk: '#1d2021', warn: '#fe8019', bad: '#fb4934', ok: '#b8bb26',
    kw: '#fb4934', tbl: '#83a598', col: '#fabd2f', str: '#b8bb26', num: '#d3869b', fn: '#8ec07c', cm: '#a89984',
  },
};

export const isPalette = (theme: string): theme is PaletteTheme => Object.hasOwn(PALETTES, theme);

/** The palette as CSS custom properties, the tokens styles.css defines, to set on the root element. */
export function paletteVars(p: Palette): Record<string, string> {
  const soft = (colour: string, percent: number) => `color-mix(in srgb, ${colour} ${percent}%, transparent)`;
  return {
    '--bg': p.bg, '--panel': p.panel, '--panel2': p.panel2, '--raise': p.raise, '--line': p.line,
    '--text': p.text, '--muted': p.muted, '--faint': p.faint,
    '--accent': p.accent, '--accent-ink': p.accentInk, '--accent-soft': soft(p.accent, 16),
    '--warn': p.warn, '--warn-soft': soft(p.warn, 14), '--bad': p.bad, '--bad-soft': soft(p.bad, 14), '--ok': p.ok,
    '--kw': p.kw, '--tbl': p.tbl, '--col': p.col, '--str': p.str, '--num': p.num, '--fn': p.fn, '--cm': p.cm,
  };
}
