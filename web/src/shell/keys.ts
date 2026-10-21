/** Whether the window runs on macOS, where the Ctrl/Cmd key is Cmd. */
export const IS_MAC = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || navigator.userAgent);

/** How the Ctrl/Cmd key is written in shortcut hints on this platform. */
export const MOD = IS_MAC ? '⌘' : 'Ctrl';
