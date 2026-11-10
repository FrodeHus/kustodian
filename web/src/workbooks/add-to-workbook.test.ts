import { describe, expect, it } from 'vitest';
import type { ParameterDef, RunResult } from '../wire';
import type { Tab } from '../tabs/tab-store';
import type { Picked } from '../results/chart-view';
import { MAX_WIDGETS, MIN_SIZE, newWidget, newWorkbook } from './model';
import type { Widget, WorkbookDoc } from './model';
import { addWidget, defaultKind, isFull, linksSaved, widgetFromTab } from './add-to-workbook';

const result = (columns: [string, string][], rows: unknown[][]): RunResult =>
  ({ outcome: 'ok', columns: columns.map(([name, type]) => ({ name, type })), rows }) as unknown as RunResult;

const def = (name: string): ParameterDef => ({ name, type: 'text', value: 'x', required: false, choices: null });

const tabOf = (over: Partial<Tab> = {}): Tab =>
  ({
    id: 't1',
    source: 'graph',
    title: 'My query',
    text: 'T | take 1',
    dirty: false,
    parameters: [],
    ...over,
  }) as unknown as Tab;

const picked = { type: 'bar', x: 'a', values: ['b'] } as unknown as Picked;

describe('defaultKind', () => {
  it('is chart for the chart view', () => {
    expect(defaultKind(result([['n', 'long']], [[1], [2]]), 'chart')).toBe('chart');
  });
  it('is stat for one row, one number column', () => {
    expect(defaultKind(result([['n', 'long']], [[1]]), 'rows')).toBe('stat');
  });
  it('is table for one row with two columns', () => {
    expect(
      defaultKind(
        result(
          [
            ['n', 'long'],
            ['s', 'string'],
          ],
          [[1, 'a']],
        ),
        undefined,
      ),
    ).toBe('table');
  });
  it('is table for several rows', () => {
    expect(defaultKind(result([['n', 'long']], [[1], [2], [3]]), 'rows')).toBe('table');
  });
});

describe('widgetFromTab', () => {
  it('links a saved clean tab and copies its query', () => {
    const options = { timespan: 'P1D' } as never;
    const parameters = [def('who')];
    const w = widgetFromTab(tabOf({ savedId: 's1', options, parameters }), 'table', 'T', undefined);
    expect(linksSaved(tabOf({ savedId: 's1' }))).toBe(true);
    expect(w.query).toEqual({ source: 'graph', text: 'T | take 1', options, parameters, saved: { id: 's1', name: 'My query' } });
    expect('highlights' in w.query!).toBe(false);
  });
  it('copies a dirty saved tab', () => {
    const t = tabOf({ savedId: 's1', dirty: true });
    expect(linksSaved(t)).toBe(false);
    expect(widgetFromTab(t, 'table', 'T', undefined).query?.saved).toBeNull();
  });
  it('carries highlights', () => {
    const highlights = [{ column: 'a' }] as never;
    expect(widgetFromTab(tabOf({ highlights }), 'table', 'T', undefined).query?.highlights).toBe(highlights);
  });
  it('sets chart picks for a chart only, and the title', () => {
    const c = widgetFromTab(tabOf(), 'chart', 'Hello', picked);
    expect(c.chart).toBe(picked);
    expect(c.title).toBe('Hello');
    const t = widgetFromTab(tabOf(), 'table', 'Hello', picked);
    expect('chart' in t).toBe(false);
    expect(t.selection).toBe('multi');
    expect(t.tools).toEqual([]);
  });
});

describe('addWidget', () => {
  const widget = (kind: 'table' | 'stat', text = 'T') => ({ ...widgetFromTab(tabOf({ text }), kind, 'T', undefined) });
  it('places on an empty doc', () => {
    const d = addWidget(newWorkbook('w'), widget('table'), []);
    expect(d.widgets[0]?.layout).toEqual({ x: 0, y: 0, w: 12, h: MIN_SIZE.table.h });
  });
  const withWidgets = (ws: Widget[]): WorkbookDoc => ({ ...newWorkbook('w'), widgets: ws });
  it('goes below the lowest top-level widget, ignoring nested ones', () => {
    const a = newWidget('table', { x: 0, y: 12, w: 12, h: 8 });
    const nested = { ...newWidget('table', { x: 0, y: 50, w: 12, h: 8 }), in: { tabs: 'tabs1', tab: 'a' } };
    expect(addWidget(withWidgets([a, nested]), widget('table'), []).widgets[2]?.layout.y).toBe(20);
  });
  it('sizes a stat by MIN_SIZE', () => {
    const l = addWidget(newWorkbook('w'), widget('stat'), []).widgets[0]?.layout;
    expect(l).toMatchObject(MIN_SIZE.stat);
  });
  it('adds only the missing parameters', () => {
    const who = {
      name: 'who',
      type: 'text',
      value: 'keep',
      required: true,
      choices: null,
      label: null,
      multi: false,
      all: false,
      remember: false,
      huntingTimespan: false,
    };
    const doc = { ...newWorkbook('w'), parameters: [who] } as WorkbookDoc;
    const out = addWidget(doc, widget('table', 'T | where a == {who} and b == {when}'), [def('who'), def('when')]);
    expect(out.parameters[0]).toBe(who);
    expect(out.parameters).toHaveLength(2);
    expect(out.parameters[1]).toEqual({ ...def('when'), label: null, multi: false, all: false, remember: false, huntingTimespan: false });
    expect(out.widgets[0]?.parameters).toEqual({ who: { from: 'workbook', value: '' }, when: { from: 'workbook', value: '' } });
    expect(out.name).toBe('w');
    expect(out.id).toBe(doc.id);
  });
});

describe('isFull', () => {
  it('is true at the maximum', () => {
    const ws = Array.from({ length: MAX_WIDGETS }, () => newWidget('markdown', { x: 0, y: 0, w: 2, h: 3 }));
    expect(isFull({ widgets: ws })).toBe(true);
    expect(isFull({ widgets: ws.slice(1) })).toBe(false);
  });
});
