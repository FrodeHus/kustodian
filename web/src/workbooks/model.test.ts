import { describe, expect, it } from 'vitest';
import { isoTimespan, MIN_SIZE, newToolButton, newWidget, newWorkbook, parseWorkbook, withFileVersion } from './model';
import type { WorkbookDoc } from './model';

const example = () => ({
  kind: 'kustodian.workbook',
  version: 1,
  id: '5b0f7c1e-0000-4000-8000-000000000001',
  name: 'VM hygiene',
  folder: 'Azure',
  parameters: [{ name: 'Subscriptions', type: 'list', value: '', required: false, multi: true, all: true }],
  widgets: [
    {
      id: 'vms',
      type: 'table',
      title: 'Virtual machines',
      layout: { x: 0, y: 0, w: 12, h: 20 },
      query: {
        saved: { id: '7c1e', name: 'Azure / VMs by power state' },
        source: 'arg',
        text: 'resources | take 1',
        options: null,
      },
      parameters: { PowerState: { from: 'widget', value: 'any' } },
      selection: 'multi',
      tools: [
        { label: 'Stop VM', tool: 'Stop VM', mapping: { id: 'id' }, runsOn: 'selectedOrAll', after: 'refreshWidget', placement: 'header' },
      ],
    },
  ],
  extra: { keep: true },
});

const doc = (json: unknown) => {
  const r = parseWorkbook(json);
  if (typeof r === 'string') {
    throw new Error(r);
  }
  return r;
};

describe('parseWorkbook', () => {
  it('reads the spec example and keeps unknown fields', () => {
    const d = doc(example());
    expect(d.name).toBe('VM hygiene');
    expect(d.parameters[0]).toMatchObject({ name: 'Subscriptions', multi: true, all: true, remember: false });
    expect(d.widgets[0]?.query?.saved?.id).toBe('7c1e');
    expect(d.widgets[0]?.query?.parameters).toEqual([]);
    expect(d.widgets[0]?.selection).toBe('multi');
    expect(d.widgets[0]?.tools).toEqual([
      { label: 'Stop VM', tool: 'Stop VM', mapping: { id: 'id' }, runsOn: 'selectedOrAll', after: 'refreshWidget', placement: 'header' },
    ]);
    expect(d).toMatchObject({ extra: { keep: true } });
  });

  it('refuses another kind and a newer version', () => {
    expect(parseWorkbook({ ...example(), kind: 'other' })).toBe("This isn't a Kustodian workbook.");
    expect(parseWorkbook(null)).toBe("This isn't a Kustodian workbook.");
    expect(parseWorkbook({ ...example(), version: 3 })).toBe('This workbook needs a newer Kustodian.');
  });

  it('drops a widget with an unknown type or a raw source and keeps the rest', () => {
    const e = example();
    const w = e.widgets[0] as Record<string, unknown>;
    e.widgets = [
      { ...w, id: 'a', type: 'map' },
      { ...w, id: 'b', query: { source: 'raw', text: '' } },
      { ...w, id: 'c' },
    ] as never;
    expect(doc(e).widgets.map((x) => x.id)).toEqual(['c']);
  });

  it('fills missing parameters and title', () => {
    const e = example();
    e.widgets = [{ id: 'm', type: 'markdown', layout: { x: 0, y: 0, w: 4, h: 4 } }] as never;
    expect(doc(e).widgets[0]).toMatchObject({ parameters: {}, title: '' });
  });

  it('gives a data widget without a query an empty graph query, and never leaves query null', () => {
    const e = example();
    e.widgets = [
      { id: 'a', type: 'table', query: null },
      { id: 'b', type: 'stat' },
      { id: 'c', type: 'markdown', query: null },
    ] as never;
    const [a, b, c] = doc(e).widgets;
    expect(a?.query).toMatchObject({ source: 'graph', text: '', saved: null, parameters: [] });
    expect(b?.query?.source).toBe('graph');
    expect(c && 'query' in c).toBe(false);
  });

  it('clamps a layout to the grid and the minimum size', () => {
    const e = example();
    e.widgets = [{ id: 'm', type: 'chart', layout: { x: 10, y: -2, w: 1, h: 1 } }] as never;
    const l = doc(e).widgets[0]?.layout;
    expect(l).toEqual({ x: 9, y: 0, w: MIN_SIZE.chart.w, h: MIN_SIZE.chart.h });
    e.widgets = [{ id: 'm', type: 'table', layout: { x: 5, y: 0, w: 40, h: 9 } }] as never;
    expect(doc(e).widgets[0]?.layout).toMatchObject({ x: 0, w: 12 });
  });

  it('repairs overlapping layouts by moving the later widget down', () => {
    const e = example();
    e.widgets = [
      { id: 'a', type: 'markdown', layout: { x: 0, y: 0, w: 6, h: 5 } },
      { id: 'b', type: 'markdown', layout: { x: 3, y: 2, w: 6, h: 5 } },
    ] as never;
    const [a, b] = doc(e).widgets;
    expect(a?.layout.y).toBe(0);
    expect(b?.layout.y).toBe(5);
  });
});

/** A hand-edited or damaged file: every field the app reads has the wrong shape. */
const damaged = () => ({
  ...example(),
  parameters: [
    { name: 'Env', type: 'list', value: 7, required: true, choices: 'x', label: 3 },
    { name: 'Days', type: 'list', value: 'a', choices: ['1', 2] },
  ],
  widgets: [
    { id: 'm', type: 'markdown', markdown: 5, layout: { x: 0, y: 0, w: 4, h: 4 } },
    {
      id: 'm',
      type: 'table',
      layout: { x: 4, y: 0, w: 4, h: 8 },
      parameters: { A: { from: 'bogus', value: 'x' }, B: { from: 'fixed', value: 1 }, C: 'x', D: { from: 'widget', value: 'd' } },
      query: {
        source: 'graph',
        text: 'T {Q} {R}',
        parameters: [
          { name: 'Q', type: 'text', value: 7, required: true },
          'x',
          { name: 'R', type: 'text', value: 'r', required: false, choices: 'y' },
        ],
      },
      chart: 'pie',
      stat: [1],
    },
  ],
});

describe('parseWorkbook on a damaged file', () => {
  const d = () => doc(damaged());

  it('coerces parameter value, label and choices', () => {
    expect(d().parameters[0]).toMatchObject({ value: '', label: null, choices: null, required: true });
    expect(d().parameters[1]?.choices).toBeNull();
  });

  it('makes markdown a string and drops chart and stat that are not objects', () => {
    const [m, t] = d().widgets;
    expect(m?.markdown).toBe('');
    expect(t && ('chart' in t || 'stat' in t)).toBe(false);
  });

  it('keeps only widget parameter entries with a known from and a string value', () => {
    expect(d().widgets[1]?.parameters).toEqual({ D: { from: 'widget', value: 'd' } });
  });

  it('keeps only query parameters with a valid shape, choices a string list or null', () => {
    expect(d().widgets[1]?.query?.parameters).toEqual([{ name: 'R', type: 'text', value: 'r', required: false, choices: null }]);
  });

  it('gives a later widget with a taken id a new one', () => {
    const [a, b] = d().widgets;
    expect(a?.id).toBe('m');
    expect(b?.id).toMatch(/^w[0-9a-f]{8}$/);
  });
});

describe('isoTimespan', () => {
  it.each([
    ['7d', 'P7D'],
    ['12h', 'PT12H'],
    ['90m', 'PT90M'],
    ['45s', 'PT45S'],
    ['1.5d', 'PT36H'],
    ['30d', 'P30D'],
    ['1500ms', 'PT2S'],
    ['31d', null],
    ['7 days', null],
    ['', null],
  ])('%s -> %s', (kql, iso) => {
    expect(isoTimespan(kql)).toBe(iso);
  });
});

describe('new documents', () => {
  it('newWorkbook is empty and valid', () => {
    const w: WorkbookDoc = newWorkbook('x');
    expect(w).toMatchObject({ kind: 'kustodian.workbook', version: 1, name: 'x', folder: null, widgets: [] });
    expect(w.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('newWidget gives data widgets an empty graph query', () => {
    const w = newWidget('chart', { x: 0, y: 0, w: 6, h: 12 });
    expect(w.id).toMatch(/^w[0-9a-f]{8}$/);
    expect(w.query).toMatchObject({ source: 'graph', saved: null, text: '', parameters: [] });
    expect(w.parameters).toEqual({});
    expect(newWidget('markdown', { x: 0, y: 0, w: 4, h: 4 }).query).toBeUndefined();
  });
});

describe('tool buttons and selection', () => {
  const withWidget = (patch: Record<string, unknown>) => {
    const e = example();
    Object.assign(e.widgets[0] as object, patch);
    return doc(e).widgets[0];
  };

  it('gives only table widgets selection and tools', () => {
    const l = { x: 0, y: 0, w: 6, h: 12 };
    expect(newWidget('table', l)).toMatchObject({ selection: 'multi', tools: [] });
    for (const t of ['chart', 'stat', 'markdown'] as const) {
      const w = newWidget(t, l);
      expect('selection' in w || 'tools' in w).toBe(false);
    }
    expect(newToolButton()).toEqual({
      label: '',
      tool: '',
      mapping: {},
      runsOn: 'selectedOrAll',
      after: 'refreshWidget',
      placement: 'header',
    });
  });

  it('keeps only the six known fields of a button (spec section 4)', () => {
    const file = { ...example() };
    (file.widgets[0] as { tools: unknown[] }).tools = [{ tool: 'X', command: '/bin/sh', args: ['-c'], mode: 'run', x: 1 }];
    const d = doc(file);
    expect(Object.keys(d.widgets[0]?.tools?.[0] ?? {}).sort()).toEqual(['after', 'label', 'mapping', 'placement', 'runsOn', 'tool']);
    const json = JSON.stringify(parseWorkbook(file));
    expect(json).not.toContain('"command"');
    expect(json).not.toContain('"args"');
  });

  it('ignores tools and selection on a non-table widget', () => {
    const w = withWidget({ type: 'chart', tools: [{ tool: 'X', command: '/bin/sh' }], selection: 'single' });
    expect(w && ('tools' in w || 'selection' in w)).toBe(false);
  });

  it('repairs buttons', () => {
    const tools = withWidget({
      tools: [
        { label: 'no tool' },
        { tool: '' },
        'x',
        { tool: 'A', mapping: { a: 'x', b: 1 }, runsOn: 'bad', after: 'bad', placement: 'bad' },
        { tool: 'B', label: 'Bee', runsOn: 'selected', after: 'none', placement: 'menu' },
      ],
    })?.tools;
    expect(tools).toEqual([
      { label: 'A', tool: 'A', mapping: { a: 'x' }, runsOn: 'selectedOrAll', after: 'refreshWidget', placement: 'header' },
      { label: 'Bee', tool: 'B', mapping: {}, runsOn: 'selected', after: 'none', placement: 'menu' },
    ]);
    expect(
      withWidget({
        tools: [
          { tool: 'A', label: '  ' },
          { tool: 'B', label: ' Bee ' },
        ],
      })?.tools?.map((b) => b.label),
    ).toEqual(['A', 'Bee']);
    expect(withWidget({ tools: 'nope' })?.tools).toEqual([]);
  });

  it('normalises selection', () => {
    expect(withWidget({ selection: 'single' })?.selection).toBe('single');
    expect(withWidget({ selection: 'none' })?.selection).toBe('none');
    expect(withWidget({ selection: 'weird' })?.selection).toBe('multi');
    expect(withWidget({ selection: undefined })?.selection).toBe('multi');
  });
});

describe('history setting', () => {
  const widget = (type: string, history: unknown) => ({
    id: 'h',
    type,
    layout: { x: 0, y: 0, w: 4, h: 8 },
    ...(type === 'markdown' ? {} : { query: { source: 'graph', text: 'x', options: null } }),
    history,
  });
  const parse = (w: unknown) => {
    const d = parseWorkbook({ kind: 'kustodian.workbook', version: 1, id: 'i', name: 'n', widgets: [w] });
    return typeof d === 'string' ? undefined : d.widgets[0];
  };
  const good = { mode: 'rows', interval: 'week', retentionDays: 365, keys: ['A'], keep: ['B'], since: '2026-10-30' };

  it('parses_a_history_setting', () => {
    expect(parse(widget('table', good))?.history).toEqual(good);
  });
  it('drops_an_unknown_mode_and_keeps_the_rest_of_the_widget', () => {
    const w = parse(widget('table', { ...good, mode: 'nope' }));
    expect(w?.id).toBe('h');
    expect(w && 'history' in w).toBe(false);
  });
  it('falls_back_on_an_unknown_retention_interval_and_since', () => {
    expect(parse(widget('stat', { ...good, retentionDays: 7, interval: 'x', since: 'soon' }))?.history).toMatchObject({
      retentionDays: 90,
      interval: 'day',
      since: 'P7D',
    });
  });
  it('history_on_a_markdown_widget_is_dropped', () => {
    const w = parse(widget('markdown', good));
    expect(w && 'history' in w).toBe(false);
  });
  it('drops_a_non_string_key', () => {
    expect(parse(widget('chart', { ...good, keys: ['A', 1], keep: [null, 'B'] }))?.history).toMatchObject({ keys: ['A'], keep: ['B'] });
  });
});

describe('tabs', () => {
  const L = { x: 0, y: 0, w: 12, h: 12 };
  const md = (id: string, extra: object = {}, layout = L) => ({ id, type: 'markdown', title: id, layout, ...extra });
  const tabsW = (id: string, tabs: unknown, extra: object = {}, layout = L) => ({ id, type: 'tabs', title: '', layout, tabs, ...extra });
  const file = (widgets: unknown[], version = 2) => ({ ...example(), version, widgets });
  const byId = (d: WorkbookDoc, id: string) => d.widgets.find((w) => w.id === id);

  it('parseWorkbook reads a version 2 file with a tabs widget', () => {
    const d = doc(
      file([
        tabsW('t', [
          { id: 'a', name: 'One' },
          { id: 'b', name: 'Two' },
        ]),
        md('m', { in: { tabs: 't', tab: 'b' } }),
      ]),
    );
    expect(d.version).toBe(2);
    expect(byId(d, 't')?.tabs).toEqual([
      { id: 'a', name: 'One' },
      { id: 'b', name: 'Two' },
    ]);
    expect(byId(d, 'm')?.in).toEqual({ tabs: 't', tab: 'b' });
  });

  it('parseWorkbook refuses version 3', () => {
    expect(parseWorkbook(file([], 3))).toBe('This workbook needs a newer Kustodian.');
  });

  it('repairs: a child whose in points to a missing tabs widget or tab, or to a non-tabs widget, goes to the top level at the bottom', () => {
    const d = doc(
      file([
        md('top', {}, { x: 0, y: 0, w: 12, h: 5 }),
        tabsW('t', [{ id: 'a', name: 'One' }], {}, { x: 0, y: 5, w: 12, h: 12 }),
        md('c1', { in: { tabs: 'gone', tab: 'a' } }),
        md('c2', { in: { tabs: 't', tab: 'gone' } }),
        md('c3', { in: { tabs: 'top', tab: 'a' } }),
      ]),
    );
    const bottom = 17;
    for (const id of ['c1', 'c2', 'c3']) {
      expect(byId(d, id)?.in).toBeUndefined();
      expect(byId(d, id)!.layout.y).toBeGreaterThanOrEqual(bottom);
    }
  });

  it('repairs: a tabs widget with no tabs gets one "Tab 1"', () => {
    const d = doc(file([tabsW('t', [])]));
    expect(byId(d, 't')?.tabs).toEqual([{ id: expect.any(String), name: 'Tab 1' }]);
  });

  it('repairs: repeated tab ids in one tabs widget are made unique', () => {
    const d = doc(
      file([
        tabsW('t', [
          { id: 'a', name: 'One' },
          { id: 'a', name: 'Two' },
        ]),
        md('m', { in: { tabs: 't', tab: 'a' } }),
      ]),
    );
    const [first, second] = byId(d, 't')!.tabs!;
    expect(first?.id).toBe('a');
    expect(second?.id).not.toBe('a');
    expect(byId(d, 'm')?.in).toEqual({ tabs: 't', tab: 'a' });
  });

  it('repairs: a tabs widget with in is moved to the top level', () => {
    const d = doc(file([tabsW('t', [{ id: 'a', name: 'One' }]), tabsW('u', [{ id: 'b', name: 'Two' }], { in: { tabs: 't', tab: 'a' } })]));
    expect(byId(d, 'u')?.in).toBeUndefined();
  });

  it('repairs: tab names are trimmed to 40 characters, and an empty name becomes "Tab N"', () => {
    const d = doc(
      file([
        tabsW('t', [
          { id: 'a', name: 'x'.repeat(50) },
          { id: 'b', name: '  ' },
        ]),
      ]),
    );
    expect(byId(d, 't')?.tabs?.map((t) => t.name)).toEqual(['x'.repeat(40), 'Tab 2']);
  });

  it('overlaps are repaired per place', () => {
    const d = doc(
      file([
        tabsW('t', [{ id: 'a', name: 'One' }], {}, { x: 0, y: 0, w: 12, h: 12 }),
        md('c', { in: { tabs: 't', tab: 'a' } }, { x: 0, y: 0, w: 12, h: 12 }),
      ]),
    );
    expect(byId(d, 't')?.layout).toEqual({ x: 0, y: 0, w: 12, h: 12 });
    expect(byId(d, 'c')?.layout).toEqual({ x: 0, y: 0, w: 12, h: 12 });
  });

  it('withFileVersion writes 1 without a tabs widget and 2 with one', () => {
    const d = doc(file([tabsW('t', [{ id: 'a', name: 'One' }])]));
    expect(withFileVersion(d).version).toBe(2);
    expect(withFileVersion({ ...d, widgets: [] }).version).toBe(1);
  });

  it('newWidget(\'tabs\') has one tab "Tab 1", hideTitle, and no query', () => {
    const w = newWidget('tabs', { x: 0, y: 0, w: 12, h: 12 });
    expect(w).toMatchObject({ type: 'tabs', title: '', hideTitle: true, tabs: [{ name: 'Tab 1' }] });
    expect(w.tabs?.[0]?.id).toBeTruthy();
    expect(w.query).toBeUndefined();
  });
});
