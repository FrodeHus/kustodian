import { describe, expect, it } from 'vitest';

// Monaco's DOM sits inside our page, so a global class rule of ours also styles any Monaco element with that class. A shared
// `.main` (ours: a flex column) stacked each suggestion row's icon above its label, and the row clipped the label away.
// monaco-kusto ships no stylesheet of its own (its release has no .css), so Monaco's are the ones to compare against.
const monacoCss = import.meta.glob<string>('/node_modules/monaco-editor/esm/**/*.css', {
  query: '?raw',
  import: 'default',
  eager: true,
});

// By glob, like Monaco's: the test runner hands a plain `?raw` import of a stylesheet back empty.
const styles = Object.values(import.meta.glob<string>('./styles.css', { query: '?raw', import: 'default', eager: true }))[0] ?? '';

const components = import.meta.glob<string>(['./**/*.tsx', '!./**/*.test.tsx'], {
  query: '?raw',
  import: 'default',
  eager: true,
});

const classesIn = (css: string) =>
  new Set([...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/\.([A-Za-z_][\w-]*)/g)].map((m) => m[1]!));

/** The class tokens a component's `className` attributes name: a plain string, or the string literals of an expression. */
function classNamesIn(tsx: string): string[] {
  const values = [...tsx.matchAll(/className=(?:"([^"]*)"|\{([\s\S]*?)\}(?=[\s/>]))/g)].flatMap(([, plain, expression]) =>
    plain !== undefined ? [plain] : [...(expression ?? '').matchAll(/(["'`])((?:(?!\1)[^\\$]|\$(?!\{))*)\1/g)].map((m) => m[2]!),
  );
  return values.flatMap((v) => v.split(/\s+/)).filter(Boolean);
}

// The classes renamed for the clash above: none may be left in a component, where they would match no rule of ours.
const renamed = ['body', 'code', 'input', 'light', 'main', 'overlay', 'status', 'tree'];

describe('styles.css', () => {
  it('reads Monaco stylesheets and ours to compare', () => {
    expect(Object.keys(monacoCss).length).toBeGreaterThan(50);
    expect(classesIn(styles).size).toBeGreaterThan(40);
  });

  it('uses no class name that Monaco also uses', () => {
    const theirs = new Set(Object.values(monacoCss).flatMap((css) => [...classesIn(css)]));
    const shared = [...classesIn(styles)].filter((name) => theirs.has(name));
    expect(shared).toEqual([]);
  });

  it('reads the class names components use', () => {
    const used = Object.values(components).flatMap(classNamesIn);
    expect(Object.keys(components).length).toBeGreaterThan(5);
    expect(used).toContain('codeblock');
    expect(used).toContain('schema-tree');
  });

  it('leaves no renamed class in a component', () => {
    const stale = Object.entries(components).flatMap(([file, tsx]) =>
      classNamesIn(tsx)
        .filter((name) => renamed.includes(name))
        .map((name) => `${file}: ${name}`),
    );
    expect(stale).toEqual([]);
  });
});
