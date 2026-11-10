import { describe, expect, it } from 'vitest';
import type { ParameterDef } from '../wire';
import type { Widget, WidgetParam, WidgetQuery, WorkbookDoc, WorkbookParameter } from './model';
import { newWidget, newWorkbook } from './model';
import { initialValues, missingRequired, toParameterValues, widgetParams, widgetRunOptions, widgetsUsing, workbookValues } from './resolve';

const wbParam = (name: string, value: string, extra: Partial<WorkbookParameter> = {}): WorkbookParameter => ({
  name,
  type: 'text',
  value,
  required: false,
  choices: null,
  label: null,
  multi: false,
  all: false,
  remember: false,
  huntingTimespan: false,
  ...extra,
});

function widget(text: string, extra: Partial<WidgetQuery> = {}, parameters: Record<string, WidgetParam> = {}, type: Widget['type'] = 'table'): Widget {
  const w = newWidget(type, { x: 0, y: 0, w: 3, h: 8 });
  if (w.query) {
    w.query = { ...w.query, text, ...extra };
  }
  return { ...w, parameters };
}

function docOf(parameters: WorkbookParameter[], widgets: Widget[]): WorkbookDoc {
  return { ...newWorkbook('t'), parameters, widgets };
}

const none = { workbook: {}, widgets: {} };

describe('widgetParams', () => {
  it('takes a same-named workbook parameter, with its current value', () => {
    const w = widget('T | where a == {TimeRange}');
    const doc = docOf([wbParam('TimeRange', '7d', { type: 'timespan' })], [w]);
    expect(widgetParams(doc, w, { workbook: { TimeRange: '1h' }, widgets: {} })).toEqual([
      { name: 'TimeRange', type: 'timespan', value: '1h', required: false, from: 'workbook' },
    ]);
    expect(widgetParams(doc, w, none)[0]?.value).toBe('7d');
  });

  it('lets a widget entry win, and the current widget value win over its default', () => {
    const w = widget('T | where a == {TimeRange}', {}, { TimeRange: { from: 'widget', value: '1h' } });
    const doc = docOf([wbParam('TimeRange', '7d')], [w]);
    expect(widgetParams(doc, w, none)[0]).toMatchObject({ from: 'widget', value: '1h' });
    expect(widgetParams(doc, w, { workbook: {}, widgets: { [w.id]: { TimeRange: '2h' } } })[0]?.value).toBe('2h');
  });

  it('uses a fixed entry and ignores the widget values', () => {
    const w = widget('T | where a == {TimeRange}', {}, { TimeRange: { from: 'fixed', value: '3d' } });
    const doc = docOf([wbParam('TimeRange', '7d')], [w]);
    expect(widgetParams(doc, w, { workbook: {}, widgets: { [w.id]: { TimeRange: '2h' } } })[0]).toMatchObject({ from: 'fixed', value: '3d' });
  });

  it('makes an undefined name a widget parameter, from the query definition when there is one', () => {
    const def: ParameterDef = { name: 'User', type: 'text', value: 'bob', required: true, choices: null };
    const w = widget('T | where u == {User}', { parameters: [def] });
    const doc = docOf([], [w]);
    const params = widgetParams(doc, w, none);
    expect(params).toEqual([{ name: 'User', type: 'text', value: 'bob', required: true, from: 'widget' }]);
    expect(missingRequired(params)).toEqual([]);
    expect(missingRequired([{ ...params[0]!, value: '' }])).toEqual(['User']);
  });

  it('runs an unknown name with an empty text value, not required', () => {
    const w = widget('T | where a == {Tmerange}');
    const params = widgetParams(docOf([], [w]), w, none);
    expect(params).toEqual([{ name: 'Tmerange', type: 'text', value: '', required: false, from: 'widget' }]);
    expect(missingRequired(params)).toEqual([]);
    expect(toParameterValues(params)).toEqual([{ name: 'Tmerange', type: 'text', value: '', required: false }]);
  });

  it('takes type and required from the workbook parameter, not the query definition', () => {
    const def: ParameterDef = { name: 'Ids', type: 'text', value: '', required: false, choices: null };
    const w = widget('T | where a in ({Ids})', { parameters: [def] });
    const doc = docOf([wbParam('Ids', '', { type: 'list', required: true })], [w]);
    const params = widgetParams(doc, w, none);
    expect(params[0]).toMatchObject({ type: 'list', required: true, from: 'workbook' });
    expect(missingRequired(params)).toEqual(['Ids']);
  });

  it('has none for a Markdown widget', () => {
    const w = widget('', {}, {}, 'markdown');
    expect(widgetParams(docOf([], [w]), w, none)).toEqual([]);
  });
});

describe('widgetsUsing', () => {
  it('lists data widgets that take the parameter from the workbook only', () => {
    const a = widget('T | where a == {TimeRange}');
    const b = widget('T | where a == {TimeRange}', {}, { TimeRange: { from: 'widget', value: '1h' } });
    const c = widget('T | where a == {TimeRange}', {}, { TimeRange: { from: 'fixed', value: '1h' } });
    const m = { ...widget('', {}, {}, 'markdown'), markdown: '{TimeRange}' };
    const doc = docOf([wbParam('TimeRange', '7d')], [a, b, c, m]);
    expect(widgetsUsing(doc, 'TimeRange')).toEqual([a.id]);
  });
});

describe('widgetRunOptions', () => {
  const hp = wbParam('TimeRange', '7d', { type: 'timespan', huntingTimespan: true });

  it('sends the hunting timespan parameter as ISO, or says why not', () => {
    const w = widget('T | take 1', { source: 'hunting' });
    const doc = docOf([hp], [w]);
    expect(widgetRunOptions(doc, w, none)).toEqual({ timespan: 'P7D', scope: null });
    expect(widgetRunOptions(doc, w, { workbook: { TimeRange: '45d' }, widgets: {} })).toEqual({
      problem: 'TimeRange: at most 30 days for Defender hunting.',
    });
    expect(widgetRunOptions(doc, w, { workbook: { TimeRange: 'a week' }, widgets: {} })).toEqual({
      problem: 'TimeRange: a timespan such as 7d, 12h or 30m for Defender hunting.',
    });
    expect(widgetRunOptions(doc, w, { workbook: { TimeRange: '' }, widgets: {} })).toEqual({
      problem: 'TimeRange: a timespan such as 7d, 12h or 30m for Defender hunting.',
    });
  });

  it('sends nothing for Graph and the own options for ARG', () => {
    const g = widget('x', { source: 'graph' });
    const arg = widget('x', { source: 'arg', options: { timespan: null, scope: { kind: 'subscriptions', ids: ['s'] } } });
    const doc = docOf([hp], [g, arg]);
    expect(widgetRunOptions(doc, g, none)).toBeNull();
    expect(widgetRunOptions(doc, arg, none)).toEqual({ timespan: null, scope: { kind: 'subscriptions', ids: ['s'] } });
  });

  it('falls back to the widget options, with the source default', () => {
    const w = widget('x', { source: 'hunting' });
    expect(widgetRunOptions(docOf([], [w]), w, none)).toEqual({ timespan: 'P30D', scope: null, workspaces: null });
  });
});

describe('initialValues', () => {
  it('takes a remembered value only when the parameter remembers', () => {
    const doc = docOf([wbParam('A', 'a', { remember: true }), wbParam('B', 'b')], []);
    expect(initialValues(doc, { A: 'x', B: 'y' }).workbook).toEqual({ A: 'x', B: 'b' });
  });
});

describe('prototype keys', () => {
  it('names like Object members never read inherited values', () => {
    const w = widget('T | where a == {constructor} and b == {toString}');
    const doc = docOf([wbParam('toString', 'x')], [w]);
    expect(widgetParams(doc, w, { workbook: {}, widgets: { [w.id]: {} } })).toEqual([
      { name: 'constructor', type: 'text', value: '', required: false, from: 'widget' },
      { name: 'toString', type: 'text', value: 'x', required: false, from: 'workbook' },
    ]);
  });
});

describe('workbookValues', () => {
  it('gives every workbook parameter its value: the view value, else the default for one added since opening', () => {
    const doc = docOf([wbParam('dept', 'Finance'), wbParam('range', '7d')], []);
    expect(workbookValues(doc, { workbook: { range: '1d', gone: 'x' }, widgets: {} })).toEqual({ dept: 'Finance', range: '1d' });
  });
});
