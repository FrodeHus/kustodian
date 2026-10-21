import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// jsdom has no layout, so every element would measure 0×0 and a virtualized list would render no rows at all. Elements report
// a 1000×600 box instead: the result grid renders a window of rows, as in a real window.
Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 600 });
Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 1000 });

// Vitest runs without globals, so Testing Library can't register its own cleanup.
afterEach(() => {
  cleanup();
});
