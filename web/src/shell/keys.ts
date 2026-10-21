const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || navigator.userAgent);

/** How the Ctrl/Cmd key is written in shortcut hints on this platform. */
export const MOD = isMac ? '⌘' : 'Ctrl';
