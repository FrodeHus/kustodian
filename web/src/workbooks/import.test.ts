import { describe, expect, it } from 'vitest';
import type { ToolList } from '../wire';
import { applyImport, importFolder, importSummary, linkedQueries, matchTools, readWorkbookFile } from './import';
import { parseWorkbook, type WorkbookDoc } from './model';

const ID = '7c1e0000-0000-0000-0000-000000000000';
const button = (label: string, tool: string, extra: object = {}) => ({
  label,
  tool,
  mapping: { id: 'id' },
  runsOn: 'selectedOrAll',
  after: 'refreshWidget',
  placement: 'header',
  ...extra,
});
const linked = (id: string, title: string, savedName: string, tools: object[] = []) => ({
  id,
  type: 'table',
  title,
  layout: { x: 0, y: id === 'vms' ? 0 : 20, w: 12, h: 20 },
  query: {
    saved: { id: ID, name: savedName },
    source: 'arg',
    text: 'resources | take 1',
    options: null,
    parameters: [{ name: 'PowerState', type: 'text', value: 'any', required: false }],
  },
  parameters: { PowerState: { from: 'widget', value: 'any' } },
  selection: 'multi',
  tools,
});
const file = (over: object = {}) => ({
  kind: 'kustodian.workbook',
  version: 1,
  id: '11111111-1111-1111-1111-111111111111',
  name: 'VM hygiene',
  folder: 'Azure',
  modifiedAt: '2026-11-01T00:00:00Z',
  parameters: [{ name: 'Subscriptions', type: 'list', value: '', required: false, multi: true, all: true }],
  widgets: [
    linked('vms', 'Virtual machines', 'Azure / VMs by power state', [
      button('Start VM', 'Start VM'),
      button('Stop VM', 'Stop VM', { command: '/bin/sh' }),
    ]),
    {
      id: 'h',
      type: 'chart',
      title: 'Hunt',
      layout: { x: 0, y: 40, w: 6, h: 12 },
      query: { source: 'hunting', text: 'DeviceInfo', options: null, parameters: [], saved: null },
      parameters: {},
    },
  ],
  ...over,
});
const doc = (over: object = {}): WorkbookDoc => parseWorkbook(file(over)) as WorkbookDoc;
const twoLinked = (over: object = {}) =>
  doc({
    widgets: [
      linked('vms', 'Virtual machines', 'VMs', [button('Start VM', 'Start VM'), button('Stop VM', 'Stop VM')]),
      linked('vms2', 'More', 'Other'),
      ...((over as { widgets?: [] }).widgets ?? []),
    ],
  });

describe('readWorkbookFile', () => {
  it('says what is wrong', () => {
    expect(readWorkbookFile('{')).toBe("This file isn't JSON.");
    expect(readWorkbookFile('{"kind":"x"}')).toBe("This isn't a Kustodian workbook.");
    expect(typeof readWorkbookFile(JSON.stringify(file()))).toBe('object');
  });
  it('keeps only the fields Kustodian knows, at every level', () => {
    const vms = linked('vms', 'Virtual machines', 'VMs');
    const planted = file({
      command: 'top',
      parameters: [{ name: 'S', type: 'text', value: '', required: false, command: 'param' }],
      widgets: [
        {
          ...vms,
          command: 'widget',
          stat: { value: null, compare: null, command: 'stat' },
          chart: { type: 'bar', command: 'chart' },
          parameters: { P: { from: 'fixed', value: 'x', command: 'wparam' } },
          query: {
            ...vms.query,
            command: 'query',
            options: { timespan: null, scope: null, command: 'opts' },
            saved: { id: ID, name: 'VMs', command: 'saved' },
            parameters: [{ name: 'P', type: 'text', value: '', required: false, command: 'qparam' }],
          },
        },
      ],
    });
    const out = readWorkbookFile(JSON.stringify(planted)) as WorkbookDoc;
    expect(JSON.stringify(out)).not.toContain('command');
    expect(out.widgets[0]).toMatchObject({
      id: 'vms',
      title: 'Virtual machines',
      selection: 'multi',
      stat: { value: null },
      chart: { type: 'bar' },
    });
    expect(out.widgets[0]?.query).toMatchObject({ source: 'arg', text: 'resources | take 1', saved: { id: ID, name: 'VMs' } });
    expect(out.parameters[0]).toMatchObject({ name: 'S', type: 'text' });
    expect('modifiedAt' in out).toBe(false);
  });
  it('keeps a tabs widget, its tabs, hideTitle and the place of the widgets in it (export and import carry tabs, spec §15.4)', () => {
    const tabs = {
      id: 't',
      type: 'tabs',
      title: 'Views',
      hideTitle: true,
      layout: { x: 0, y: 0, w: 12, h: 12 },
      parameters: {},
      tabs: [
        { id: 'a', name: 'A', command: 'tab' },
        { id: 'b', name: 'B' },
      ],
    };
    const inB = {
      id: 'm',
      type: 'markdown',
      title: 'Note',
      markdown: 'hi',
      layout: { x: 0, y: 0, w: 4, h: 4 },
      parameters: {},
      in: { tabs: 't', tab: 'b', command: 'in' },
    };
    const out = readWorkbookFile(JSON.stringify(file({ version: 2, widgets: [tabs, inB] }))) as WorkbookDoc;
    expect(JSON.stringify(out)).not.toContain('command');
    expect(out.widgets[0]).toMatchObject({
      type: 'tabs',
      hideTitle: true,
      tabs: [
        { id: 'a', name: 'A' },
        { id: 'b', name: 'B' },
      ],
    });
    expect(out.widgets[1]?.in).toEqual({ tabs: 't', tab: 'b' });
    expect(parseWorkbook(JSON.parse(JSON.stringify(out)))).toEqual(out);
  });
});

describe('importSummary', () => {
  it('counts widgets, parameters, distinct sources and linked widgets', () => {
    expect(importSummary(doc())).toEqual({ widgets: 2, parameters: 1, sources: ['hunting', 'arg'], linked: 1 });
  });
});

describe('importFolder', () => {
  it('replaces slashes, cuts and falls back', () => {
    expect(importFolder('Azure / VMs')).toBe('Azure - VMs');
    expect(importFolder('a'.repeat(100))).toBe('a'.repeat(80));
    expect(importFolder('  ')).toBe('Imported workbook');
  });
});

describe('linkedQueries', () => {
  it('gives one query per saved id, from the first widget', () => {
    const q = linkedQueries(twoLinked());
    expect(q).toHaveLength(1);
    expect(q[0]).toMatchObject({ savedId: ID, name: 'VMs', source: 'arg', text: 'resources | take 1' });
  });
  it('cuts a long name and falls back to the title, then a fixed name', () => {
    expect(linkedQueries(doc({ widgets: [linked('vms', 'T', 'x'.repeat(250))] }))[0]?.name).toBe('x'.repeat(200));
    expect(linkedQueries(doc({ widgets: [linked('vms', 'Title', '  ')] }))[0]?.name).toBe('Title');
    expect(linkedQueries(doc({ widgets: [linked('vms', '', '')] }))[0]?.name).toBe('Imported query');
  });
});

describe('matchTools', () => {
  const list = (tools: string[], problem: string | null = null): ToolList => ({
    tools: tools.map((name) => ({ name, command: 'x', args: [] }) as unknown as ToolList['tools'][number]),
    problem,
    path: '',
    missing: [],
  });
  it('matches by exact name, once per tool', () => {
    expect(matchTools(twoLinked(), list(['Start VM', 'stop vm']))).toEqual([
      { tool: 'Start VM', mine: true },
      { tool: 'Stop VM', mine: false },
    ]);
  });
  it('matches nothing without tools', () => {
    const none = [
      { tool: 'Start VM', mine: false },
      { tool: 'Stop VM', mine: false },
    ];
    expect(matchTools(twoLinked(), null)).toEqual(none);
    expect(matchTools(twoLinked(), list([], 'bad'))).toEqual(none);
  });
});

describe('applyImport', () => {
  const choices = { added: null, tools: { 'Start VM': 'Start VM', 'Stop VM': 'Start VM' }, id: 'new' };
  it('relinks to the added queries', () => {
    const out = applyImport(twoLinked(), { ...choices, added: { [ID]: { id: 'n1', name: 'VMs' } } });
    for (const w of out.widgets) {
      expect(w.query?.saved).toEqual({ id: 'n1', name: 'VMs' });
      expect(w.query?.text).toBe('resources | take 1');
    }
  });
  it('copies linked queries into the widgets', () => {
    const before = twoLinked();
    const out = applyImport(before, choices);
    out.widgets.forEach((w, i) => {
      expect(w.query?.saved).toBeNull();
      expect({ ...w.query, saved: 1 }).toEqual({ ...before.widgets[i]?.query, saved: 1 });
    });
  });
  it('renames, removes and drops unknown tools', () => {
    const d = twoLinked();
    const renamed = applyImport(d, { ...choices, tools: { 'Start VM': 'Start VM', 'Stop VM': 'Deallocate VM' } });
    expect(renamed.widgets[0]?.tools).toEqual([d.widgets[0]?.tools?.[0], { ...d.widgets[0]?.tools?.[1], tool: 'Deallocate VM' }]);
    expect(applyImport(d, { ...choices, tools: { 'Start VM': 'Start VM', 'Stop VM': null } }).widgets[0]?.tools).toHaveLength(1);
    expect(applyImport(d, { ...choices, tools: { 'Start VM': 'Start VM' } }).widgets[0]?.tools).toHaveLength(1);
  });
  it('looks up only own keys: "constructor" and "__proto__" find nothing unless added', () => {
    const odd = doc({
      widgets: [
        {
          ...linked('vms', 'V', 'Q', [button('A', 'constructor'), button('B', '__proto__')]),
          query: { ...linked('vms', 'V', 'Q').query, saved: { id: 'constructor', name: 'Q' } },
        },
        linked('w2', 'W', 'R'),
      ],
    });
    odd.widgets[1]!.query!.saved = { id: '__proto__', name: 'R' };
    const none = applyImport(odd, { added: {}, tools: {}, id: 'x' });
    expect(none.widgets.map((w) => w.query?.saved)).toEqual([null, null]);
    expect(none.widgets[0]?.tools).toEqual([]);
    // fromEntries makes own keys, as JSON.parse and saveImported's map do.
    const added = Object.fromEntries([
      ['constructor', { id: 'n1', name: 'Q' }],
      ['__proto__', { id: 'n2', name: 'R' }],
    ]);
    const tools = Object.fromEntries([
      ['constructor', 'Start VM'],
      ['__proto__', 'Stop VM'],
    ]);
    const out = applyImport(odd, { added, tools, id: 'x' });
    expect(out.widgets.map((w) => w.query?.saved)).toEqual([
      { id: 'n1', name: 'Q' },
      { id: 'n2', name: 'R' },
    ]);
    expect(out.widgets[0]?.tools?.map((b) => b.tool)).toEqual(['Start VM', 'Stop VM']);
  });
  it('never carries a command', () => {
    expect(JSON.stringify(applyImport(doc(), { ...choices, tools: { 'Stop VM': 'Stop VM' } }))).not.toContain('"command"');
  });
  it('sets the id, drops modifiedAt and leaves the input alone', () => {
    const d = doc();
    const snapshot = JSON.stringify(d);
    const out = applyImport(d, choices);
    expect(out).not.toBe(d);
    expect(out.id).toBe('new');
    expect('modifiedAt' in out).toBe(false);
    expect(JSON.stringify(d)).toBe(snapshot);
  });
});
