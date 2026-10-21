import { describe, expect, it } from 'vitest';

// Monaco's DOM sits inside our page, so a global class rule of ours also styles any Monaco element with that class. A shared
// `.main` (ours: a flex column) stacked each suggestion row's icon above its label, and the row clipped the label away.
const monacoCss = import.meta.glob<string>(
  ['/node_modules/monaco-editor/esm/**/*.css', '/node_modules/@kusto/monaco-kusto/release/esm/**/*.css'],
  { query: '?raw', import: 'default', eager: true },
);

// By glob, like Monaco's: the test runner hands a plain `?raw` import of a stylesheet back empty.
const styles = Object.values(import.meta.glob<string>('./styles.css', { query: '?raw', import: 'default', eager: true }))[0] ?? '';

const classesIn = (css: string) =>
  new Set([...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/\.([A-Za-z_][\w-]*)/g)].map((m) => m[1]!));

describe('styles.css', () => {
  it('reads Monaco stylesheets to compare against', () => {
    expect(Object.keys(monacoCss).length).toBeGreaterThan(50);
    expect(classesIn(styles).size).toBeGreaterThan(40);
  });

  it('uses no class name that Monaco or monaco-kusto also uses', () => {
    const theirs = new Set(Object.values(monacoCss).flatMap((css) => [...classesIn(css)]));
    const shared = [...classesIn(styles)].filter((name) => theirs.has(name));
    expect(shared).toEqual([]);
  });
});
