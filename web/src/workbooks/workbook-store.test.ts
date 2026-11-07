import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HistoryRecordAnswer, HistoryRecordParams, QueryRunParams, RunResult, SavedQuery } from '../wire';
import type { Widget, WidgetParam, WidgetQuery, WorkbookDoc, WorkbookParameter } from './model';
import { newWidget, newWorkbook } from './model';
import { useTabs } from '../tabs/tab-store';
import { saveWorkbook, startWorkbookTabs, useWorkbooks } from './workbook-store';

const bridge = vi.hoisted(() => ({ call: vi.fn() }));

vi.mock('../bridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../bridge')>()),
  call: bridge.call,
}));

const result = (rows: unknown[][]): RunResult => ({
  outcome: 'ok',
  message: null,
  error: null,
  columns: [{ name: 'n', type: 'long' }],
  rows,
  total: rows.length,
  tables: [],
  durationMs: 1,
  droppedValues: 0,
  runId: 'r',
  diagnostics: [],
  permissions: [],
});

/** Each `query.run` waits until the test answers it. */
interface Pending {
  params: QueryRunParams;
  signal: AbortSignal;
  answer: (r: RunResult) => void;
}
let runs: Pending[];
let library: SavedQuery[];
let remembered: Record<string, string>;
/** When set, `library.list` answers only after it resolves. */
let libraryGate: Promise<void> | null;
/** What `history.record` does: answer, or reject when null. */
let recordAnswer: HistoryRecordAnswer | null;

const saved = (id: string, text: string): SavedQuery => ({
  version: 1,
  id,
  name: id,
  folder: null,
  source: 'graph',
  text,
  parameters: [],
  createdAt: '',
  modifiedAt: '',
  options: null,
});

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

function widget(id: string, text: string, query: Partial<WidgetQuery> = {}, parameters: Record<string, WidgetParam> = {}): Widget {
  const w = newWidget('table', { x: 0, y: 0, w: 3, h: 8 });
  return { ...w, id, parameters, query: { ...w.query!, text, ...query } };
}

const docOf = (parameters: WorkbookParameter[], widgets: Widget[]): WorkbookDoc => ({ ...newWorkbook('t'), parameters, widgets });
const tab = () => useWorkbooks.getState().byTab.t!;
const state = (id: string) => tab().runs[id]?.state;
const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
  runs = [];
  library = [];
  remembered = {};
  libraryGate = null;
  recordAnswer = { recorded: true, skipped: null, reset: false };
  bridge.call.mockReset();
  bridge.call.mockImplementation((method: string, params: unknown, signal: AbortSignal) => {
    switch (method) {
      case 'library.list':
        return (libraryGate ?? Promise.resolve()).then(() => ({ queries: library, folders: [], skipped: 0 }));
      case 'workbook.values.get':
        return Promise.resolve({ values: remembered });
      case 'workbook.values.save':
        return Promise.resolve(null);
      case 'workbook.save':
        return Promise.resolve({ workbook: { ...(params as { workbook: WorkbookDoc }).workbook, modifiedAt: 'now' } });
      case 'history.record':
        return recordAnswer ? Promise.resolve(recordAnswer) : Promise.reject(new Error('disk'));
      case 'query.run':
        return new Promise((resolve) => runs.push({ params: params as QueryRunParams, signal, answer: resolve }));
      default:
        return Promise.reject(new Error(method));
    }
  });
  useWorkbooks.setState({ byTab: {} });
});

afterEach(() => {
  useWorkbooks.getState().unload('t');
  vi.useRealTimers();
});

describe('workbook store', () => {
  it('runs every data widget, at most three per source at once', async () => {
    const hunting = ['a', 'b', 'c', 'd'].map((id) => widget(id, `T${id}`, { source: 'hunting' }));
    const md = newWidget('markdown', { x: 0, y: 0, w: 2, h: 3 });
    void useWorkbooks.getState().load('t', docOf([], [...hunting, md, widget('g', 'users')]));
    await flush();

    expect(['a', 'b', 'c', 'd', 'g'].map(state)).toEqual(['running', 'running', 'running', 'waiting', 'running']);
    expect(state(md.id)).toBeUndefined();
    expect(runs[0]?.params).toEqual({
      tabId: 't/a',
      runId: expect.any(String),
      source: 'hunting',
      kql: 'Ta',
      parameters: [],
      options: { timespan: 'P30D', scope: null },
      refresh: false,
      addToRecent: false,
    });

    runs[0]!.answer(result([[1]]));
    await flush();
    expect(state('a')).toBe('done');
    expect(state('d')).toBe('running');
  });

  it('a workbook value reruns only the widgets using it; text waits 400 ms after the last change, Enter runs at once', async () => {
    const doc = docOf([wbParam('Name', 'x'), wbParam('Kind', 'k', { type: 'list', choices: ['k', 'j'] })], [widget('a', 'T {Name}'), widget('b', 'T {Kind}')]);
    void useWorkbooks.getState().load('t', doc);
    await flush();
    runs.forEach((r) => r.answer(result([])));
    await flush();
    runs = [];

    useWorkbooks.getState().setWorkbookValue('t', 'Name', 'y');
    await vi.advanceTimersByTimeAsync(300);
    useWorkbooks.getState().setWorkbookValue('t', 'Name', 'yz');
    await vi.advanceTimersByTimeAsync(399);
    expect(runs).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(runs.map((r) => [r.params.tabId, r.params.parameters?.[0]?.value])).toEqual([['t/a', 'yz']]);

    useWorkbooks.getState().setWorkbookValue('t', 'Name', 'q', { now: true });
    await flush();
    expect(runs.map((r) => r.params.tabId)).toEqual(['t/a', 't/a']);
    expect(runs[0]!.signal.aborted).toBe(true);

    useWorkbooks.getState().setWorkbookValue('t', 'Kind', 'j');
    await flush();
    expect(runs.map((r) => r.params.tabId)).toEqual(['t/a', 't/a', 't/b']);
    expect(tab().doc).toBe(doc);
  });

  it('a typed value of any type waits 400 ms after the last change; Enter runs at once', async () => {
    const top = { Top: { from: 'widget' as const, value: '5' } };
    const doc = docOf([wbParam('Count', '1', { type: 'number' })], [widget('a', 'T {Count}'), widget('b', 'T {Top}', {}, top)]);
    void useWorkbooks.getState().load('t', doc);
    await flush();
    runs.forEach((r) => r.answer(result([])));
    await flush();
    runs = [];

    useWorkbooks.getState().setWorkbookValue('t', 'Count', '1');
    await vi.advanceTimersByTimeAsync(300);
    useWorkbooks.getState().setWorkbookValue('t', 'Count', '12');
    await vi.advanceTimersByTimeAsync(399);
    expect(runs).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(runs.map((r) => [r.params.tabId, r.params.parameters?.[0]?.value])).toEqual([['t/a', '12']]);
    useWorkbooks.getState().setWorkbookValue('t', 'Count', '123', { now: true });
    await flush();
    expect(runs).toHaveLength(2);

    runs = [];
    useWorkbooks.getState().setWidgetValue('t', 'b', 'Top', '1');
    await vi.advanceTimersByTimeAsync(300);
    useWorkbooks.getState().setWidgetValue('t', 'b', 'Top', '10');
    await vi.advanceTimersByTimeAsync(399);
    expect(runs).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(runs.map((r) => [r.params.tabId, r.params.parameters?.[0]?.value])).toEqual([['t/b', '10']]);
    useWorkbooks.getState().setWidgetValue('t', 'b', 'Top', '100', { now: true });
    await flush();
    expect(runs).toHaveLength(2);
  });

  it('only the latest run of a widget lands', async () => {
    void useWorkbooks.getState().load('t', docOf([wbParam('Name', 'x')], [widget('a', 'T {Name}')]));
    await flush();
    useWorkbooks.getState().setWorkbookValue('t', 'Name', 'one', { now: true });
    await flush();
    useWorkbooks.getState().setWorkbookValue('t', 'Name', 'two', { now: true });
    await flush();
    const [, first, second] = runs;

    second!.answer(result([['two']]));
    await flush();
    first!.answer(result([['one']]));
    await flush();
    expect(tab().runs.a).toMatchObject({ state: 'done', result: result([['two']]) });
  });

  it('runDraft runs a draft widget as the preview, with the workbook values, and only its latest call lands', async () => {
    void useWorkbooks.getState().load('t', docOf([wbParam('Name', 'x')], [widget('a', 'T')]));
    await flush();
    const { runDraft } = useWorkbooks.getState();
    const first = runDraft('t', widget('a', 'one {Name}'));
    const second = runDraft('t', widget('a', 'two {Name}'));
    const replaced = expect(first).rejects.toThrow('A newer preview replaced this one.');
    await flush();
    const preview = runs.filter((r) => r.params.tabId === 't/preview');
    expect(preview.map((r) => r.params.kql)).toEqual(['one {Name}', 'two {Name}']);
    expect(preview[1]?.params).toMatchObject({ addToRecent: false, parameters: [{ name: 'Name', value: 'x' }] });
    expect(preview[0]?.signal.aborted).toBe(true);
    await replaced;

    preview[0]!.answer(result([['one']]));
    preview[1]!.answer(result([['two']]));
    await expect(second).resolves.toEqual(result([['two']]));
    expect(Object.keys(tab().runs)).toEqual(['a']);
    await expect(runDraft('t', widget('a', ''))).rejects.toThrow('No query yet.');
  });

  it('a widget missing a required value is blocked and not sent', async () => {
    const doc = docOf([wbParam('Name', '', { required: true })], [widget('a', 'T {Name}'), widget('b', 'users')]);
    void useWorkbooks.getState().load('t', doc);
    await flush();
    expect(tab().runs.a).toEqual({ state: 'blocked', reason: 'Needs a value before the widget runs.' });
    expect(runs.map((r) => r.params.tabId)).toEqual(['t/b']);
  });

  it('a widget whose saved query is gone says so, the rest run, and copying it in runs the copy', async () => {
    library = [saved('s1', 'users | take 1')];
    const linked = widget('a', 'old copy', { saved: { id: 's1', name: 's1' } });
    const gone = widget('b', 'last copy', { saved: { id: 'missing', name: 'Missing' } });
    void useWorkbooks.getState().load('t', docOf([], [linked, gone, widget('c', 'groups')]));
    await flush();

    expect(tab().runs.b).toEqual({ state: 'gone' });
    expect(runs.map((r) => [r.params.tabId, r.params.kql])).toEqual([
      ['t/a', 'users | take 1'],
      ['t/c', 'groups'],
    ]);

    useWorkbooks.getState().copySavedIntoWidget('t', 'b');
    await flush();
    expect(tab().doc.widgets[1]?.query).toMatchObject({ saved: null, text: 'last copy' });
    expect(tab().dirty).toBe(true);
    expect(runs.at(-1)?.params).toMatchObject({ tabId: 't/b', kql: 'last copy' });
    expect(state('b')).toBe('running');
  });

  it('edit and undo restore the doc, undo keeps 50 steps, and a discard restores the doc from before editing', async () => {
    const doc = docOf([], [widget('a', 'users')]);
    void useWorkbooks.getState().load('t', doc);
    await flush();
    const rename = (name: string) => (d: WorkbookDoc) => ({ ...d, name });
    const { edit, undoEdit, redoEdit, setEditing } = useWorkbooks.getState();

    expect(tab().dirty).toBe(false);
    edit('t', rename('one'));
    expect(tab()).toMatchObject({ dirty: true, doc: { name: 'one' } });
    undoEdit('t');
    expect(tab().doc).toBe(doc);
    redoEdit('t');
    expect(tab().doc.name).toBe('one');

    for (let i = 0; i < 51; i++) {
      edit('t', rename(`n${i}`));
    }
    expect(tab().undo).toHaveLength(50);

    useWorkbooks.getState().markSaved('t', tab().doc);
    expect(tab().dirty).toBe(false);
    const before = tab().doc;
    setEditing('t', true);
    edit('t', rename('draft'));
    setEditing('t', false, true);
    expect(tab()).toMatchObject({ editing: false, doc: before, dirty: false });
  });

  it('values are view state until saved as defaults, through edit', async () => {
    const w = widget('a', 'T {Name} {Top}', {}, { Top: { from: 'widget', value: '5' } });
    void useWorkbooks.getState().load('t', docOf([wbParam('Name', 'x')], [w]));
    await flush();
    const doc = tab().doc;
    useWorkbooks.getState().setWorkbookValue('t', 'Name', 'y', { now: true });
    useWorkbooks.getState().setWidgetValue('t', 'a', 'Top', '10', { now: true });
    expect(tab()).toMatchObject({ doc, dirty: false });
    expect(runs.at(-1)?.params.parameters?.map((p) => p.value)).toEqual(['y', '10']);

    useWorkbooks.getState().saveValuesAsDefaults('t');
    expect(tab().doc.parameters[0]?.value).toBe('y');
    expect(tab().doc.widgets[0]?.parameters.Top).toEqual({ from: 'widget', value: '10' });
    expect(tab()).toMatchObject({ dirty: true, undo: [doc] });
  });

  it('a selection is view state, and a new result clears it', async () => {
    void useWorkbooks.getState().load('t', docOf([], [widget('a', 'T')]));
    await flush();
    runs[0]!.answer(result([[1], [2]]));
    await flush();
    const before = tab();
    useWorkbooks.getState().setSelection('t', 'a', [1]);
    expect(tab().selections.a).toEqual({ selected: [1], shown: null });
    expect([tab().doc, tab().dirty]).toEqual([before.doc, before.dirty]);

    void useWorkbooks.getState().runWidget('t', 'a');
    runs.at(-1)!.answer(result([[3]]));
    await flush();
    expect(tab().selections.a).toBeUndefined();
  });

  it('setShown with an equal array changes nothing', () => {
    void useWorkbooks.getState().load('t', docOf([], [widget('a', 'T')]));
    useWorkbooks.getState().setShown('t', 'a', [1, 0]);
    expect(tab().selections.a).toEqual({ selected: [], shown: [1, 0] });
    const was = useWorkbooks.getState().byTab.t;
    useWorkbooks.getState().setShown('t', 'a', [1, 0]);
    expect(useWorkbooks.getState().byTab.t).toBe(was);
  });

  it('a change while the library is read does not stop the load, and the change wins over the remembered value', async () => {
    let open!: () => void;
    libraryGate = new Promise((resolve) => (open = resolve));
    remembered = { Name: 'kept' };
    void useWorkbooks.getState().load('t', docOf([wbParam('Name', 'x', { remember: true })], [widget('a', 'T {Name}'), widget('b', 'users')]));
    await flush();
    useWorkbooks.getState().setWorkbookValue('t', 'Name', 'mine', { now: true });
    runs = [];
    open();
    await flush();
    expect(tab().values.workbook.Name).toBe('mine');
    expect(runs.map((r) => [r.params.tabId, r.params.parameters?.[0]?.value])).toEqual([
      ['t/a', 'mine'],
      ['t/b', undefined],
    ]);
  });

  it('a linked widget reruns for a value its library query uses, not its local copy', async () => {
    library = [saved('s1', 'T {Name}')];
    void useWorkbooks.getState().load('t', docOf([wbParam('Name', 'x')], [widget('a', 'old copy', { saved: { id: 's1', name: 's1' } })]));
    await flush();
    runs = [];
    useWorkbooks.getState().setWorkbookValue('t', 'Name', 'y', { now: true });
    await flush();
    expect(runs.map((r) => [r.params.tabId, r.params.kql])).toEqual([['t/a', 'T {Name}']]);
  });

  it('a hunting-timespan value reruns the hunting widgets it applies to, not those overriding it', async () => {
    const own = { Span: { from: 'fixed' as const, value: '1d' } };
    const doc = docOf(
      [wbParam('Span', '7d', { type: 'timespan', huntingTimespan: true })],
      [widget('h', 'T', { source: 'hunting' }), widget('o', 'T', { source: 'hunting' }, own), widget('g', 'users')],
    );
    void useWorkbooks.getState().load('t', doc);
    await flush();
    runs.forEach((r) => r.answer(result([])));
    await flush();
    runs = [];
    useWorkbooks.getState().setWorkbookValue('t', 'Span', '1h', { now: true });
    await flush();
    expect(runs.map((r) => [r.params.tabId, r.params.options?.timespan])).toEqual([['t/h', 'PT1H']]);
  });

  it('a workbook deleted from the library is unsaved, also after a discard back to its saved doc', async () => {
    void useWorkbooks.getState().load('t', docOf([], []));
    await flush();
    const { setEditing, edit, markUnsaved } = useWorkbooks.getState();
    setEditing('t', true);
    edit('t', (d) => ({ ...d, name: 'draft' }));
    markUnsaved('t');
    setEditing('t', false, true);
    expect(tab().dirty).toBe(true);
  });

  it('saving while editing makes a later discard return to what was saved', async () => {
    void useWorkbooks.getState().load('t', docOf([], [widget('a', 'users')]));
    await flush();
    const { edit, setEditing, markSaved } = useWorkbooks.getState();
    setEditing('t', true);
    edit('t', (d) => ({ ...d, name: 'saved' }));
    markSaved('t', tab().doc);
    const savedDoc = tab().doc;
    edit('t', (d) => ({ ...d, name: 'draft' }));
    setEditing('t', false, true);
    expect(tab()).toMatchObject({ doc: savedDoc, dirty: false, editing: false });
  });

  it('remembered values load on open and are saved, debounced', async () => {
    remembered = { Name: 'kept' };
    const doc = docOf([wbParam('Name', 'x', { remember: true }), wbParam('Other', 'o')], [widget('a', 'T {Name}')]);
    void useWorkbooks.getState().load('t', doc, { dirty: true });
    await flush();
    expect(tab().dirty).toBe(true);
    expect(runs[0]?.params.parameters?.[0]?.value).toBe('kept');

    useWorkbooks.getState().setWorkbookValue('t', 'Name', 'a');
    useWorkbooks.getState().setWorkbookValue('t', 'Name', 'ab');
    const saves = () => bridge.call.mock.calls.filter(([m]) => m === 'workbook.values.save');
    await vi.advanceTimersByTimeAsync(399);
    expect(saves()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(saves()).toEqual([['workbook.values.save', { id: doc.id, values: { Name: 'ab' } }]]);
  });

  it('a workbook tab loads when it opens, mirrors its dirty flag and unloads when it closes', async () => {
    useTabs.setState({ tabs: [], activeId: null, cursors: {} });
    const stop = startWorkbookTabs();
    const id = useTabs.getState().openWorkbook(docOf([], []));
    expect(useWorkbooks.getState().byTab[id]).toBeDefined();

    useWorkbooks.getState().edit(id, (d) => ({ ...d, widgets: [widget('a', 'users')] }));
    expect(useTabs.getState().tabs[0]).toMatchObject({ dirty: true, workbook: useWorkbooks.getState().byTab[id]!.doc });

    useTabs.getState().close(id);
    expect(useWorkbooks.getState().byTab[id]).toBeUndefined();
    stop();
  });

  it('saving refreshes linked copies from the library, then marks the workbook and its tab saved', async () => {
    library = [{ ...saved('q1', 'users | take 5'), name: 'Five users' }];
    useTabs.setState({ tabs: [], activeId: null, cursors: {} });
    const stop = startWorkbookTabs();
    const linked = widget('a', 'old', { saved: { id: 'q1', name: 'old name' } });
    const id = useTabs.getState().openWorkbook(docOf([], [linked]), { dirty: true });
    await flush();

    await saveWorkbook(id, { name: 'Hygiene', folder: 'Ops' });
    const sent = bridge.call.mock.calls.find(([m]) => m === 'workbook.save')?.[1] as { workbook: WorkbookDoc };
    expect(sent.workbook).toMatchObject({ name: 'Hygiene', folder: 'Ops' });
    expect(sent.workbook.widgets[0]?.query).toMatchObject({ text: 'users | take 5', saved: { id: 'q1', name: 'Five users' } });
    expect(useWorkbooks.getState().byTab[id]).toMatchObject({ dirty: false, doc: { name: 'Hygiene', modifiedAt: 'now' } });
    expect(useTabs.getState().tabs[0]).toMatchObject({ dirty: false, title: 'Hygiene', savedId: sent.workbook.id });

    useTabs.getState().close(id);
    stop();
  });

  it('a damaged workbook from the session is repaired; one that cannot be read is said once and not tried again', async () => {
    const good = widget('a', 'users');
    const damaged = { ...docOf([], []), parameters: undefined, widgets: [good, { ...good, id: 'b', type: 'map' }] } as unknown as WorkbookDoc;
    const other = { ...docOf([], []), kind: 'other' } as unknown as WorkbookDoc;
    const tabOf = (id: string, title: string, workbook: WorkbookDoc) =>
      ({ id, source: 'workbook' as const, title, text: '', dirty: true, savedId: null, parameters: [], filePath: null, workbook });
    useTabs.getState().restore({ version: 1, activeId: 'w1', tabs: [tabOf('w1', 'Fixed', damaged), tabOf('w2', 'Other', other)] });
    const notify = vi.fn();
    const stop = startWorkbookTabs(notify);
    await flush();

    expect(useWorkbooks.getState().byTab.w1?.doc).toMatchObject({ parameters: [], widgets: [{ id: 'a' }] });
    expect(useWorkbooks.getState().byTab.w1?.doc.widgets).toHaveLength(1);
    expect(useTabs.getState().tabs[0]).toMatchObject({ dirty: true, workbook: { parameters: [] } });
    expect(useWorkbooks.getState().byTab.w2).toBeUndefined();
    expect(notify).toHaveBeenCalledWith("Other couldn’t be opened: This isn't a Kustodian workbook.");

    // Later tab changes don't try it again; its document stays in the tab for the session.
    useTabs.getState().open('graph');
    expect(notify).toHaveBeenCalledTimes(1);
    expect(useTabs.getState().tabs[1]?.workbook).toBe(other);

    useTabs.getState().close('w1');
    useTabs.getState().close('w2');
    stop();
  });

  describe('history', () => {
    const withHistory = (id: string, text = 'users', history: Partial<NonNullable<Widget['history']>> = {}): Widget => ({
      ...widget(id, text),
      history: { mode: 'values', interval: 'day', retentionDays: 30, keys: [], keep: [], since: 'previous', ...history },
    });
    const records = () => bridge.call.mock.calls.filter(([m]) => m === 'history.record');
    const open = async (w: Widget, opts?: { dirty?: boolean }, ps: WorkbookParameter[] = []) => {
      void useWorkbooks.getState().load('t', docOf(ps, [w]), opts);
      await flush();
    };
    const answer = async (r: RunResult) => {
      runs.at(-1)!.answer(r);
      await flush();
    };

    it('a_finished_run_with_history_is_recorded', async () => {
      const w = withHistory('a', 'T {Name}', { keep: ['ignored'], since: 'P7D' });
      await open(w, undefined, [wbParam('Name', 'x')]);
      await answer(result([[1], [2]]));
      expect(records()).toEqual([
        [
          'history.record',
          {
            workbookId: tab().doc.id,
            widgetId: 'a',
            query: { source: 'graph', text: 'T {Name}', options: runs[0]!.params.options ?? null, parameters: [{ name: 'Name', value: 'x' }] },
            setting: { mode: 'values', interval: 'day', retentionDays: 30, keys: [] },
            label: 'Name = x',
            columns: [{ name: 'n', type: 'long' }],
            rows: [[1], [2]],
          } satisfies HistoryRecordParams,
        ],
      ]);
      expect(tab().history.a).toEqual({ skipped: null, reset: false, recordedAt: expect.any(Number) });
    });

    it('a_cut_off_run_is_not_recorded_and_says_why', async () => {
      await open(withHistory('a'));
      await answer({ ...result([[1]]), total: 5 });
      expect(records()).toHaveLength(0);
      expect(tab().history.a?.skipped).toBe('cutOff');
    });

    it('a_failed_run_is_not_recorded', async () => {
      await open(withHistory('a'));
      bridge.call.mockImplementationOnce(() => Promise.reject(new Error('x')));
      const pending = runs.length;
      void useWorkbooks.getState().runWidget('t', 'a');
      await flush();
      expect(runs.length).toBe(pending);
      expect(records()).toHaveLength(0);
      expect(tab().history.a?.skipped).toBe('failed');
    });

    it('a_dirty_workbook_is_not_recorded', async () => {
      await open(withHistory('a'), { dirty: true });
      await answer(result([[1]]));
      expect(records()).toHaveLength(0);
      expect(tab().history.a?.skipped).toBe('unsaved');
    });

    it('a dirty flag set by edit after the run started counts at answer time', async () => {
      await open(withHistory('a'));
      useWorkbooks.getState().edit('t', (d) => ({ ...d, name: 'x' }));
      await answer(result([[1]]));
      expect(records()).toHaveLength(0);
      expect(tab().history.a?.skipped).toBe('unsaved');
    });

    it('the_preview_never_records', async () => {
      await open(withHistory('a'));
      await answer(result([[1]]));
      bridge.call.mockClear();
      const preview = useWorkbooks.getState().runDraft('t', withHistory('p'));
      await flush();
      runs.at(-1)!.answer(result([[1]]));
      await preview;
      expect(records()).toHaveLength(0);
    });

    it('a_widget_without_history_never_records', async () => {
      await open(widget('a', 'users'));
      await answer(result([[1]]));
      expect(records()).toHaveLength(0);
      expect(tab().history.a).toBeUndefined();
    });

    it('a_cancelled_or_dropped_run_is_not_recorded_and_has_no_skip_line', async () => {
      await open(withHistory('a'));
      useWorkbooks.getState().unload('t');
      await flush();
      expect(records()).toHaveLength(0);
    });

    it('a_record_failure_does_not_break_the_run', async () => {
      recordAnswer = null;
      await open(withHistory('a'));
      await answer(result([[1]]));
      expect(state('a')).toBe('done');
      expect(tab().history.a).toEqual({ skipped: null, reset: false, recordedAt: null });
    });

    it('host_skips_map_to_reasons', async () => {
      await open(withHistory('a'));
      recordAnswer = { recorded: false, skipped: 'tooManyRows', reset: false };
      await answer(result([[1]]));
      expect(tab().history.a?.skipped).toBe('tooManyRows');
      recordAnswer = { recorded: false, skipped: 'interval', reset: false };
      void useWorkbooks.getState().runWidget('t', 'a');
      await flush();
      await answer(result([[1]]));
      expect(tab().history.a).toEqual({ skipped: null, reset: false, recordedAt: null });
    });

    it('reset_stays_for_the_session', async () => {
      await open(withHistory('a'));
      recordAnswer = { recorded: true, skipped: null, reset: true };
      await answer(result([[1]]));
      recordAnswer = { recorded: true, skipped: null, reset: false };
      void useWorkbooks.getState().runWidget('t', 'a');
      await flush();
      await answer(result([[1]]));
      expect(tab().history.a?.reset).toBe(true);
    });

    it('rows_mode_with_repeated_keys_is_not_recorded', async () => {
      await open(withHistory('a', 'users', { mode: 'rows', keys: ['n'] }));
      await answer(result([[1], [1]]));
      expect(records()).toHaveLength(0);
      expect(tab().history.a?.skipped).toBe('keysNotUnique');
    });

    it('setSince keeps the choice per widget and reruns nothing', async () => {
      await open(withHistory('a'));
      await answer(result([[1]]));
      const before = runs.length;
      useWorkbooks.getState().setSince('t', 'a', 'P7D');
      await flush();
      expect(tab().since).toEqual({ a: 'P7D' });
      expect(runs.length).toBe(before);
    });
  });
});
