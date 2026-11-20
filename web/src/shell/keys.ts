/** Whether the window runs on macOS, where the Ctrl/Cmd key is Cmd. */
export const IS_MAC = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || navigator.userAgent);

/** Whether the page runs in the app's own window (its user agent, AppWindow.UserAgent) on macOS or Windows; false in a browser. */
const HOST_UA = typeof navigator !== 'undefined' ? navigator.userAgent : '';
export const HOST_MAC = HOST_UA.startsWith('Kustodian (Macintosh)');
export const HOST_WINDOWS = HOST_UA.startsWith('Kustodian (Windows)');

/** How the Ctrl/Cmd key is written in shortcut hints on this platform. */
export const MOD = IS_MAC ? '⌘' : 'Ctrl';

/** How the Shift key is written in shortcut hints on this platform. */
export const SHIFT = IS_MAC ? '⇧' : 'Shift';
