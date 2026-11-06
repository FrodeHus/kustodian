import { describe, expect, it } from 'vitest';
import { isoTimespan, MIN_SIZE, newWidget, newWorkbook, parseWorkbook } from './model';
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
      tools: [{ label: 'Stop VM' }],
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
    expect(d.widgets[0]).toMatchObject({ selection: 'multi', tools: [{ label: 'Stop VM' }] });
    expect(d).toMatchObject({ extra: { keep: true } });
  });

  it('refuses another kind and a newer version', () => {
    expect(parseWorkbook({ ...example(), kind: 'other' })).toBe("This isn't a Kustodian workbook.");
    expect(parseWorkbook(null)).toBe("This isn't a Kustodian workbook.");
    expect(parseWorkbook({ ...example(), version: 2 })).toBe('This workbook needs a newer Kustodian.');
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
