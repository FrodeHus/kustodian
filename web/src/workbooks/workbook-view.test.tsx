import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTabs } from '../tabs/tab-store';
import type { RunResult } from '../wire';
import type { ParamChoices } from './choices';
import type { Widget, WidgetQuery, WidgetType, WorkbookDoc, WorkbookParameter } from './model';
import { newWidget, newWorkbook, parseWorkbook } from './model';
import type { WidgetRun, WorkbookState } from './workbook-store';
import { useWorkbooks } from './workbook-store';
import { WorkbookView } from './workbook-view';

// By glob: the test runner hands a plain `?raw` import of a stylesheet back empty.
const styles = Object.values(import.meta.glob<string>('../styles.css', { query: '?raw', import: 'default', eager: true }))[0] ?? '';

const call = vi.hoisted(() => vi.fn());
vi.mock('../bridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../bridge')>()),
  call,
  on: () => () => undefined,
}));

// Recharts can't lay out in jsdom; the chart's own tests cover it.
vi.mock('../results/chart-view', () => ({
  default: ({ picked, controls = true }: { picked: { type?: string }; controls?: boolean }) => (
    <p>
      Chart {picked.type ?? 'auto'}, {controls ? 'with pickers' : 'alone'}
    </p>
  ),
}));

const result = (columns: RunResult['columns'], rows: unknown[][]): RunResult => ({
  outcome: 'ok',
  message: null,
  error: null,
  columns,
  rows,
  total: rows.length,
  tables: [],
  durationMs: 120,
  droppedValues: 0,
  runId: 'r',
  diagnostics: [],
  permissions: [],
});

const env: WorkbookParameter = {
  name: 'Env',
  type: 'list',
  value: 'prod',
  required: false,
  choices: ['prod', 'test'],
  label: 'Environment',
  multi: false,
  all: false,
  remember: false,
  huntingTimespan: false,
};

function widget(id: string, type: WidgetType, title: string, text = 'Users | take 5', extra: Partial<Widget> = {}): Widget {
  const w = newWidget(type, { x: 0, y: 0, w: 4, h: 12 });
  return { ...w, id, title, ...(w.query ? { query: { ...w.query, text } } : {}), ...extra };
}

let doc: WorkbookDoc;
const setWorkbookValue = vi.fn();
const setWidgetValue = vi.fn();

function show(runs: Record<string, WidgetRun>, editing = false, accountKey?: string, choices: Record<string, ParamChoices> = {}) {
  const state: WorkbookState = {
    doc,
    values: { workbook: { Env: 'prod', Days: '7' }, widgets: {} },
    runs,
    editing,
    undo: [],
    redo: [],
    dirty: false,
    selections: {},
    history: {},
    since: {},
    activeTabs: {},
    choices,
    stale: {},
  };
  useWorkbooks.setState({ byTab: { t: state }, setWorkbookValue, setWidgetValue });
  return render(<WorkbookView tabId="t" accountKey={accountKey} />);
}

const frame = (title: string) => screen.getByRole('region', { name: title });

beforeEach(() => {
  setWorkbookValue.mockReset();
  setWidgetValue.mockReset();
  call.mockReset();
  useTabs.setState({ tabs: [], activeId: null });
  doc = {
    ...newWorkbook('Sign-in review'),
    folder: 'Security',
    parameters: [env, { ...env, name: 'Days', type: 'number', value: '7', choices: null, label: null }],
    widgets: [
      widget('m', 'markdown', 'Notes', undefined, { markdown: '# Read me' }),
      widget('c', 'chart', 'Sign-ins by day', 'SignIns | where Env == {Env}'),
      widget('tb', 'table', 'Users', 'Users | take {Top}', { parameters: { Top: { from: 'widget', value: '5' } } }),
      widget('s', 'stat', 'Total', 'Users | count', { stat: { value: 'value', compare: 'previous' } }),
    ],
  };
});

describe('WorkbookView', () => {
  it('a widget refused for want of access gets working access buttons, and the toolbar refreshes access for all of them', async () => {
    const refused = (outcome: RunResult['outcome'], extra: Partial<RunResult> = {}): WidgetRun => ({
      state: 'done',
      result: { ...result([], []), outcome, message: 'Refused.', ...extra },
    });
    const runAll = vi.fn(() => Promise.resolve());
    call.mockResolvedValue(undefined);
    show(
      { c: refused('noPermission'), tb: refused('consentNeeded', { consentAudience: 'logs' }), s: refused('noPermission') },
      false,
      'acc',
    );
    useWorkbooks.setState({ runAll });
    const widgetRefresh = within(frame('Sign-ins by day')).getByRole('button', { name: 'Refresh access' });
    expect((widgetRefresh as HTMLButtonElement).disabled).toBe(false);
    expect((within(frame('Users')).getByRole('button', { name: 'Grant Log Analytics access' }) as HTMLButtonElement).disabled).toBe(false);

    const toolbar = screen.getAllByRole('button', { name: 'Refresh access' }).find((b) => b.closest('.toolbar'));
    fireEvent.click(toolbar!);
    await vi.waitFor(() => expect(runAll).toHaveBeenCalledWith('t', { refresh: true }));
    // Each step once: both noPermission widgets share the Graph token.
    expect(call.mock.calls.filter(([m]) => m.startsWith('account.'))).toEqual([
      ['account.refresh', { key: 'acc', audience: 'graph' }],
      ['account.consent', { key: 'acc', audience: 'logs' }],
    ]);
  });

  it('shows no toolbar Refresh access while no widget lacks access', () => {
    show({ c: { state: 'done', result: result([], []) } }, false, 'acc');
    expect(screen.queryByRole('button', { name: 'Refresh access' })).toBeNull();
  });

  it('shows each widget by its title, and the parameter bar', () => {
    show({});
    expect(screen.getByRole('heading', { name: 'Sign-in review' })).toBeTruthy();
    for (const title of ['Notes', 'Sign-ins by day', 'Users', 'Total']) {
      expect(frame(title)).toBeTruthy();
    }
    expect(screen.getByRole('radiogroup', { name: 'Environment' })).toBeTruthy();
    // The chart widget names the workbook parameter it uses, on its corner link icon.
    expect(within(frame('Sign-ins by day')).getByRole('img', { name: 'Uses workbook parameters Env' })).toBeTruthy();
  });

  it('Print marks this workbook for the print styles, and prints in the page unless the host printed it', async () => {
    const print = vi.spyOn(window, 'print').mockImplementation(() => undefined);
    call.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const { container } = show({});
    const open = () => {
      fireEvent.click(screen.getByRole('button', { name: 'Workbook menu' }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Print or save as PDF…' }));
    };
    open();
    await vi.waitFor(() => expect(print).toHaveBeenCalledTimes(1));
    expect(call).toHaveBeenCalledWith('app.print');
    expect(container.querySelectorAll('.wb-printing')).toHaveLength(1);
    open();
    await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(2));
    await Promise.resolve();
    expect(print).toHaveBeenCalledTimes(1);
    expect(styles).toContain('.wb-printing');
    print.mockRestore();
  });

  it('prints the parameters as a table of their shown values', () => {
    show({});
    const table = screen.getByRole('table', { name: 'Workbook parameters' });
    expect(table.closest('.print-only')).toBeTruthy();
    expect([...table.querySelectorAll('tbody tr')].map((r) => r.textContent)).toEqual(['Environmentprod', 'Days7']);
  });

  it('offers a text parameter with choices as a select, and fills Markdown with a parameter added since opening', () => {
    // Region isn't in the view values (it was added after the workbook opened): its default stands in.
    doc.parameters = [...doc.parameters, { ...env, name: 'Region', type: 'text', value: 'eu', choices: ['eu', 'us'], label: null }];
    doc.widgets = [widget('m', 'markdown', 'Notes', undefined, { markdown: 'Region {Region}' })];
    show({});
    expect(screen.getByRole('radiogroup', { name: 'Region' })).toBeTruthy();
    expect(within(frame('Notes')).getByText('Region eu')).toBeTruthy();
  });

  it('Full screen fixes the widget to the window, and the stylesheet frees it from the boxes that would hold it', () => {
    show({});
    fireEvent.click(within(frame('Notes')).getByRole('button', { name: 'Notes menu' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Full screen' }));
    const notes = frame('Notes');
    expect(notes.classList.contains('wb-full')).toBe(true);
    expect(notes.classList.contains('fixed')).toBe(true);
    // `relative` would win over `fixed` and keep it in its grid cell.
    expect(notes.classList.contains('relative')).toBe(false);
    // A container query container, or the glass workspace's backdrop filter, would be the box `fixed` resolves against.
    expect(styles).toContain('.wb-canvas:has(.wb-full) { container-type: normal; }');
    expect(styles).toContain('.theme-glass .workspace:has(.wb-full) { backdrop-filter: none; }');
  });

  it('Full screen on a widget inside a tab: the tabs widget around it neither holds it nor covers it', () => {
    doc.widgets = [
      { ...widget('tw', 'tabs', ''), tabs: [{ id: 't1', name: 'One' }] },
      widget('in', 'markdown', 'Inside', undefined, { markdown: 'x', in: { tabs: 'tw', tab: 't1' } }),
    ];
    show({});
    fireEvent.click(within(frame('Inside')).getByRole('button', { name: 'Inside menu' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Full screen' }));
    expect(frame('Inside').classList.contains('wb-full')).toBe(true);
    // The glass themes' .card backdrop filter would make the outer tabs widget the box `fixed` resolves against.
    expect(styles).toContain('.theme-glass .wb-widget:has(.wb-full) { backdrop-filter: none; }');
    expect(styles).toContain('.wb-widget:has(.wb-full) { z-index: 20; }');
  });

  it('in the glass themes, nothing in the widget editor has a backdrop filter, which would misplace Monaco’s suggest and hover', () => {
    expect(styles).toContain('.theme-glass .wb-editor, .theme-glass .wb-editor .card { backdrop-filter: none;');
  });

  describe('workspace widgets', () => {
    const ws = { customerId: 'c', name: 'contoso-sentinel', resourceId: '/x' };
    const hunting = () => {
      const w = widget('h', 'table', 'Hunt');
      doc.widgets = [{ ...w, query: { ...w.query!, source: 'hunting', options: { timespan: 'P7D', scope: null, workspaces: [ws] } } }];
    };
    const columns = [{ name: 'a', type: 'long' }];

    it('a_successful_run_names_the_workspace_and_the_fallback', () => {
      hunting();
      show({ h: { state: 'done', result: result(columns, [[1]]) } });
      expect(within(frame('Hunt')).getByText(/contoso-sentinel/)).toBeTruthy();
      expect(
        within(frame('Hunt')).getByText(/If Defender can't reach contoso-sentinel, it answers from your primary workspace\./),
      ).toBeTruthy();
    });

    it('a_run_without_a_workspace_says_nothing_of_one', () => {
      show({ tb: { state: 'done', result: result(columns, [[1]]) } });
      expect(within(frame('Users')).queryByText(/If Defender can't reach/)).toBeNull();
    });

    it('a logs widget with no workspace shows Pick a workspace in edit mode', () => {
      const w = widget('l', 'table', 'Logs');
      doc.widgets = [{ ...w, query: { ...w.query!, source: 'logs', options: { timespan: null, scope: null, workspaces: null } } }];
      show(
        {
          l: {
            state: 'done',
            result: { ...result(columns, []), outcome: 'workspaceUnavailable', message: 'Pick a workspace before running.' },
          },
        },
        true,
      );
      expect(within(frame('Logs')).getByText('Pick a workspace before running.')).toBeTruthy();
      expect(within(frame('Logs')).getByRole('button', { name: 'Pick a workspace' })).toBeTruthy();
    });

    it('an_unavailable_workspace_has_no_pick_button_outside_edit_mode', () => {
      hunting();
      show({ h: { state: 'done', result: { ...result(columns, []), outcome: 'workspaceUnavailable', message: 'gone' } } });
      expect(within(frame('Hunt')).getByText('gone')).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Pick a workspace' })).toBeNull();
    });
  });

  it('says on the parameter itself when the hunting timespan can’t be sent', () => {
    doc.parameters = [{ ...env, name: 'Range', type: 'timespan', value: '90d', choices: null, label: null, huntingTimespan: true }];
    doc.widgets = [];
    show({});
    expect(screen.getByRole('alert').textContent).toBe('Range: at most 30 days for Defender hunting.');
  });

  describe('the timespan alert with a workspace parameter', () => {
    const setup = (customer: string) => {
      call.mockResolvedValue({ workspaces: [], subscriptions: [] });
      doc.parameters = [
        { ...env, name: 'Range', type: 'timespan', value: '90d', choices: null, label: null, huntingTimespan: true },
        { ...env, name: 'Customer', type: 'workspace', value: customer, choices: null, label: null },
      ];
      const h = widget('h', 'table', 'Hunt');
      doc.widgets = [{ ...h, query: { ...h.query!, source: 'hunting', options: null } }];
      show({});
    };

    it('allows 90 days once the parameter has a workspace', () => {
      setup('11111111-1111-1111-1111-111111111111');
      expect(screen.queryByText(/at most 30 days/)).toBeNull();
    });

    it('allows 30 days only while the parameter is empty', () => {
      setup('');
      expect(screen.getByRole('alert').textContent).toBe('Range: at most 30 days for Defender hunting.');
    });
  });

  it('shows a damaged workbook, as parsed, without failing', () => {
    const parsed = parseWorkbook({
      ...doc,
      parameters: [{ name: 'Env', type: 'list', value: 7, required: true, choices: 'x' }],
      widgets: [
        { id: 'm', type: 'markdown', title: 'Notes', markdown: 5, layout: { x: 0, y: 0, w: 4, h: 4 } },
        {
          id: 'm',
          type: 'stat',
          title: 'Total',
          layout: { x: 4, y: 0, w: 4, h: 8 },
          parameters: { Top: { from: 'bogus', value: 1 } },
          query: { source: 'graph', text: 'Users | take {Top} {Q}', parameters: [{ name: 'Q', type: 'text', value: 7, required: true }] },
          stat: 'value',
        },
      ],
    });
    if (typeof parsed === 'string') {
      throw new Error(parsed);
    }
    doc = parsed;
    show({});
    expect(frame('Notes')).toBeTruthy();
    expect(frame('Total')).toBeTruthy();
  });

  it('sets a workbook value from the bar: few short choices are buttons, more are a select', () => {
    show({});
    const group = screen.getByRole('radiogroup', { name: 'Environment' });
    expect(within(group).getByRole('radio', { name: 'prod' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(within(group).getByRole('radio', { name: 'test' }));
    expect(setWorkbookValue).toHaveBeenCalledWith('t', 'Env', 'test', { now: true });

    cleanup();
    doc = { ...doc, parameters: [{ ...env, choices: ['production', 'test'] }] };
    show({});
    fireEvent.change(screen.getByRole('combobox', { name: 'Environment' }), { target: { value: 'test' } });
    expect(setWorkbookValue).toHaveBeenLastCalledWith('t', 'Env', 'test', { now: true });
  });

  it('picks several values in a menu of checks, kept in the choices order', () => {
    doc = {
      ...doc,
      parameters: [{ ...env, name: 'Sev', label: 'Severity', multi: true, all: true, choices: ['High', 'Medium', 'Low'], value: 'High' }],
    };
    show({});
    act(() => useWorkbooks.setState((st) => ({ byTab: { t: { ...st.byTab.t!, values: { workbook: { Sev: 'Low' }, widgets: {} } } } })));
    const pick = screen.getByRole('button', { name: 'Severity' });
    expect(pick.textContent).toContain('Low');
    fireEvent.click(pick);
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'High' }));
    expect(setWorkbookValue).toHaveBeenLastCalledWith('t', 'Sev', 'High\nLow', { now: true });
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Select all' }));
    expect(setWorkbookValue).toHaveBeenLastCalledWith('t', 'Sev', 'High\nMedium\nLow', { now: true });
  });

  describe('choices from a query', () => {
    const queried: WorkbookParameter = {
      ...env,
      name: 'Table',
      label: 'Table',
      value: 'a',
      choices: null,
      choicesQuery: { source: 'graph', text: 'T', options: null },
    };
    const items = [
      { value: 'a', label: 'Alpha table' },
      { value: 'b', label: 'Bravo table' },
      { value: 'c', label: 'Charlie table' },
    ];
    const showQuery = (p: WorkbookParameter, loaded: ParamChoices | undefined, editing = false) => {
      doc = { ...doc, parameters: [p] };
      show({}, editing, undefined, loaded ? { [p.name]: loaded } : {});
      act(() =>
        useWorkbooks.setState((st) => ({ byTab: { t: { ...st.byTab.t!, values: { workbook: { [p.name]: p.value }, widgets: {} } } } })),
      );
    };

    it('query choices show as a select with their labels; picking one reruns at once', () => {
      showQuery(queried, { state: 'done', items, capped: false });
      const pick = screen.getByRole('combobox', { name: 'Table' });
      expect(
        within(pick)
          .getAllByRole('option')
          .map((o) => o.textContent),
      ).toEqual(['Alpha table', 'Bravo table', 'Charlie table']);
      fireEvent.change(pick, { target: { value: 'b' } });
      expect(setWorkbookValue).toHaveBeenLastCalledWith('t', 'Table', 'b', { now: true });
    });

    it('the multi menu button and the collapsed summary show labels, not values', () => {
      showQuery({ ...queried, type: 'list', multi: true, all: false, value: 'a\nb' }, { state: 'done', items, capped: false });
      expect(screen.getByRole('button', { name: 'Table' }).textContent).toContain('Alpha table, Bravo table');
      expect(screen.getByRole('button', { name: 'Table' }).textContent).not.toContain('a, b');
      cleanup();
      showQuery({ ...queried, value: 'b' }, { state: 'done', items, capped: false });
      fireEvent.click(screen.getByRole('button', { name: /Parameters/ }));
      expect(document.querySelector('.param-summary')?.textContent).toContain('Bravo table');
    });

    it('Discard reloads the choices', () => {
      const loadChoices = vi.fn().mockResolvedValue(undefined);
      showQuery(queried, { state: 'done', items, capped: false }, true);
      useWorkbooks.setState({ loadChoices });
      fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
      expect(loadChoices).toHaveBeenCalledWith('t');
    });

    it('a multi list with All over query choices sends every loaded choice and shows All', () => {
      showQuery({ ...queried, type: 'list', multi: true, all: true, value: 'a' }, { state: 'done', items, capped: false });
      fireEvent.click(screen.getByRole('button', { name: 'Table' }));
      fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Select all' }));
      expect(setWorkbookValue).toHaveBeenLastCalledWith('t', 'Table', 'a\nb\nc', { now: true });
      cleanup();
      showQuery({ ...queried, type: 'list', multi: true, all: true, value: 'a\nb\nc' }, { state: 'done', items, capped: false });
      expect(screen.getByRole('button', { name: 'Table' }).textContent).toContain('All');
    });

    it('while loading the current value shows with Loading choices…', () => {
      showQuery({ ...queried, value: 'zed' }, { state: 'loading' });
      expect((screen.getByRole('textbox', { name: 'Table' }) as HTMLInputElement).value).toBe('zed');
      expect(screen.getByRole('status').textContent).toBe('Loading choices…');
    });

    it('a reload keeps the list as a select with the hint', () => {
      showQuery(queried, { state: 'loading', items });
      expect(screen.getByRole('combobox', { name: 'Table' })).toBeTruthy();
      expect(screen.getByRole('status').textContent).toBe('Loading choices…');
    });

    it("a failed choice query is free entry with Couldn't load choices: <error>", () => {
      showQuery(queried, { state: 'failed', error: 'boom' });
      expect(screen.getByRole('textbox', { name: 'Table' })).toBeTruthy();
      expect(screen.getByRole('alert').textContent).toBe("Couldn't load choices: boom");
    });

    it('no rows is free entry with The query returned no choices.', () => {
      showQuery(queried, { state: 'done', items: [], capped: false });
      expect(screen.getByRole('textbox', { name: 'Table' })).toBeTruthy();
      expect(screen.getByRole('status').textContent).toBe('The query returned no choices.');
    });

    it('capped shows Showing the first 1,000 choices.', () => {
      showQuery(queried, { state: 'done', items, capped: true });
      expect(screen.getByRole('combobox', { name: 'Table' })).toBeTruthy();
      expect(screen.getByRole('status').textContent).toBe('Showing the first 1,000 choices.');
    });

    it('a logs query with no workspace says Pick a workspace for these choices. in edit mode', () => {
      showQuery(queried, { state: 'needsWorkspace' }, true);
      expect(screen.getByRole('textbox', { name: 'Table' })).toBeTruthy();
      expect(screen.getByRole('status').textContent).toBe('Pick a workspace for these choices.');
      cleanup();
      showQuery(queried, { state: 'needsWorkspace' }, false);
      expect(screen.queryByRole('status')).toBeNull();
    });

    it('a query with no choices entry is plain free entry with no hint', () => {
      showQuery(queried, undefined);
      expect(screen.getByRole('textbox', { name: 'Table' })).toBeTruthy();
      expect(screen.queryByRole('status')).toBeNull();
      expect(screen.queryByRole('alert')).toBeNull();
    });
  });

  it('collapses to a line of values, and Reset puts changed values back', () => {
    const setParamsCollapsed = vi.fn();
    useWorkbooks.setState({ setParamsCollapsed });
    show({});
    act(() =>
      useWorkbooks.setState((st) => ({ byTab: { t: { ...st.byTab.t!, values: { workbook: { Env: 'test', Days: '7' }, widgets: {} } } } })),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect(setWorkbookValue).toHaveBeenCalledTimes(1);
    expect(setWorkbookValue).toHaveBeenCalledWith('t', 'Env', 'prod', { now: true });

    fireEvent.click(screen.getByRole('button', { name: /^Parameters/ }));
    expect(setParamsCollapsed).toHaveBeenCalledWith('t', true);
    act(() => useWorkbooks.setState((st) => ({ byTab: { t: { ...st.byTab.t!, paramsCollapsed: true } } })));
    expect(screen.queryByRole('radiogroup', { name: 'Environment' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Environment: test' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Days: 7' })).toBeTruthy();
  });

  it('a typed value waits for typing to stop, Enter sends it at once', () => {
    show({});
    const days = screen.getByRole('textbox', { name: 'Days' });
    fireEvent.change(days, { target: { value: '14' } });
    expect(setWorkbookValue).toHaveBeenLastCalledWith('t', 'Days', '14', { now: false });
    fireEvent.keyDown(days, { key: 'Enter' });
    expect(setWorkbookValue).toHaveBeenLastCalledWith('t', 'Days', '7', { now: true });

    const top = within(frame('Users')).getByRole('textbox', { name: 'Top' });
    fireEvent.change(top, { target: { value: '10' } });
    expect(setWidgetValue).toHaveBeenLastCalledWith('t', 'tb', 'Top', '10', { now: false });
    fireEvent.keyDown(top, { key: 'Enter' });
    expect(setWidgetValue).toHaveBeenLastCalledWith('t', 'tb', 'Top', '5', { now: true });
  });

  it('a free-entry list takes one value per line', () => {
    doc = { ...doc, parameters: [...doc.parameters, { ...env, name: 'Accounts', choices: null, label: null, value: '' }] };
    show({});
    const accounts = screen.getByRole('textbox', { name: 'Accounts' });
    expect(accounts.tagName).toBe('TEXTAREA');
    fireEvent.change(accounts, { target: { value: 'a@contoso.com\nb@contoso.com' } });
    expect(setWorkbookValue).toHaveBeenLastCalledWith('t', 'Accounts', 'a@contoso.com\nb@contoso.com', { now: false });
  });

  it('says why a blocked widget did not run', () => {
    show({ tb: { state: 'blocked', reason: 'Needs a value before the widget runs.' } });
    expect(within(frame('Users')).getByText('Needs a value before the widget runs.')).toBeTruthy();
  });

  it('offers to copy the last text into a widget whose saved query is gone', () => {
    const copySavedIntoWidget = vi.fn();
    useWorkbooks.setState({ copySavedIntoWidget });
    show({ tb: { state: 'gone' } });
    const users = frame('Users');
    expect(within(users).getByText('This saved query is gone.')).toBeTruthy();
    fireEvent.click(within(users).getByRole('button', { name: 'Copy the last text into the widget' }));
    expect(copySavedIntoWidget).toHaveBeenCalledWith('t', 'tb');
  });

  it('shows a run’s time in the corner only when it took 5 s or more, and no source badge', () => {
    const columns = [
      { name: 'value', type: 'long' },
      { name: 'previous', type: 'long' },
    ];
    show({ s: { state: 'done', result: result(columns, [[1, 2]]) } });
    expect(within(frame('Total')).queryByText('120 ms')).toBeNull();
    expect(frame('Total').querySelector('.src')).toBeNull();
  });

  it('a run of 5 s or more shows its time in the corner', () => {
    show({ s: { state: 'done', result: { ...result([{ name: 'value', type: 'long' }], [[1]]), durationMs: 6200 } } });
    expect(within(frame('Total')).getByText('6.2 s')).toBeTruthy();
  });

  it('shows a stat with its change against the comparison', () => {
    const columns = [
      { name: 'value', type: 'long' },
      { name: 'previous', type: 'long' },
    ];
    show({ s: { state: 'done', result: result(columns, [[1284, 1088]]) } });
    const total = frame('Total');
    expect(within(total).getByText('1,284')).toBeTruthy();
    expect(within(total).getByText('▲ 196 (18%)')).toBeTruthy();
  });

  it('shows a stat’s unit after its number', () => {
    doc = { ...doc, widgets: doc.widgets.map((w) => (w.id === 's' ? { ...w, stat: { value: 'value', compare: null, unit: '%' } } : w)) };
    show({ s: { state: 'done', result: result([{ name: 'value', type: 'real' }], [[56.1]]) } });
    expect(within(frame('Total')).getByText('56.1').textContent).toBe('56.1%');
  });

  it('a stat with a null or empty cell has no number, and a null comparison no change line', () => {
    const columns = [
      { name: 'value', type: 'long' },
      { name: 'previous', type: 'long' },
    ];
    for (const cell of [null, '', 'n/a']) {
      const { unmount } = show({ s: { state: 'done', result: result(columns, [[cell, 5]]) } });
      expect(within(frame('Total')).getByText('No number to show.')).toBeTruthy();
      unmount();
    }
    show({ s: { state: 'done', result: result(columns, [[7, null]]) } });
    expect(within(frame('Total')).getByText('7')).toBeTruthy();
    expect(within(frame('Total')).queryByText(/▲|▼/)).toBeNull();
  });

  it('draws a chart widget alone, as its own settings say, in view mode, edit mode and full screen', async () => {
    doc.widgets = doc.widgets.map((w) => (w.id === 'c' ? { ...w, chart: { type: 'bar' } } : w));
    const shown = { c: { state: 'done', result: result([{ name: 'n', type: 'long' }], [[1]]) } } as const;
    const view = show(shown);
    expect(await within(frame('Sign-ins by day')).findByText('Chart bar, alone')).toBeTruthy();
    fireEvent.click(within(frame('Sign-ins by day')).getByRole('button', { name: 'Sign-ins by day menu' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Full screen' }));
    expect(within(frame('Sign-ins by day')).getByText('Chart bar, alone')).toBeTruthy();
    view.unmount();
    show(shown, true);
    expect(await within(frame('Sign-ins by day')).findByText('Chart bar, alone')).toBeTruthy();
  });

  it('opens a widget in a query tab with the current values as its parameters', () => {
    show({});
    const chart = frame('Sign-ins by day');
    fireEvent.click(within(chart).getByRole('button', { name: 'Sign-ins by day menu' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open in query tab' }));
    const opened = useTabs.getState().tabs.at(-1);
    expect(opened?.text).toBe('SignIns | where Env == {Env}');
    expect(opened?.source).toBe('graph');
    expect(opened?.parameters).toEqual([{ name: 'Env', type: 'list', value: 'prod', required: false, choices: ['prod', 'test'] }]);
  });

  describe('a workspace parameter', () => {
    const A = { customerId: 'guid-a', name: 'Contoso', resourceId: '/r/a', resourceGroup: 'rg', subscriptionId: 's', location: 'we' };
    const B = { customerId: 'guid-b', name: 'Fabrikam', resourceId: '/r/b', resourceGroup: 'rg', subscriptionId: 's', location: 'we' };
    const withWorkspace = (value: string, list = [A, B], own?: Widget, runs: Record<string, WidgetRun> = {}) => {
      call.mockImplementation((m: string) => Promise.resolve(m === 'arm.workspaces' ? { workspaces: list } : { subscriptions: [] }));
      doc = {
        ...doc,
        parameters: [{ ...env, name: 'Customer', type: 'workspace', value, choices: null, label: 'Customer' }],
        widgets: [own ?? widget('l', 'table', 'Logs', 'T | where Cust == {Customer}')],
      };
      show(runs);
    };
    const trigger = () => screen.getByRole('button', { name: /^Workspace:/ });

    it('is a picker; picking sets the customer id and reruns at once', async () => {
      withWorkspace('');
      expect(trigger().textContent).toContain('None');
      fireEvent.click(trigger());
      fireEvent.click(await screen.findByRole('radio', { name: /^Fabrikam/ }));
      expect(setWorkbookValue).toHaveBeenCalledWith('t', 'Customer', 'guid-b', { now: true });
    });

    it('its picker has the workbook copy, not the hunting tab’s', async () => {
      withWorkspace('');
      fireEvent.click(trigger());
      await screen.findByRole('radio', { name: /^Fabrikam/ });
      expect(screen.getByText(/Log Analytics widgets wait for a workspace/)).toBeTruthy();
      expect(screen.getByText('Every Log Analytics and hunting widget in this workbook uses it.')).toBeTruthy();
      expect(screen.queryByText(/saved with the query/)).toBeNull();
    });

    it('None clears it', async () => {
      withWorkspace('guid-a');
      fireEvent.click(trigger());
      fireEvent.click(await screen.findByRole('radio', { name: /^None/ }));
      expect(setWorkbookValue).toHaveBeenCalledWith('t', 'Customer', '', { now: true });
    });

    it('a value not in the account list shows its short id and not available to this account', async () => {
      withWorkspace('abcdef12-0000-0000-0000-000000000000');
      expect(await screen.findByText(/not available to this account/)).toBeTruthy();
      expect(screen.getAllByText(/abcd…0000/).length).toBeGreaterThan(0);
    });

    it('the collapsed summary shows the workspace name', async () => {
      withWorkspace('guid-a');
      act(() => useWorkbooks.setState((st) => ({ byTab: { t: { ...st.byTab.t!, paramsCollapsed: true } } })));
      expect(await screen.findByRole('button', { name: 'Customer: Contoso' })).toBeTruthy();
    });

    const typedWidget = (source: 'hunting' | 'logs', options: WidgetQuery['options']) => {
      const w = widget('h', 'table', 'Hunt', 'T');
      return { ...w, query: { ...w.query!, source, options } };
    };
    const columns = [{ name: 'a', type: 'long' }];
    const old = { customerId: 'guid-old', name: 'OldWorkspace', resourceId: '/r/old' };

    it('the hunting note names the parameter workspace, not the widgets own', async () => {
      withWorkspace('guid-a', [A, B], typedWidget('hunting', { timespan: 'P7D', scope: null, workspaces: [old] }), {
        h: { state: 'done', result: result(columns, [[1]]) },
      });
      expect(await within(frame('Hunt')).findByText(/Workspace Contoso\. If Defender can't reach Contoso/)).toBeTruthy();
      expect(within(frame('Hunt')).queryByText(/OldWorkspace/)).toBeNull();
    });

    it('the hunting note says nothing while the parameter is empty, whatever the widget has of its own', () => {
      withWorkspace('', [A, B], typedWidget('hunting', { timespan: 'P7D', scope: null, workspaces: [old] }), {
        h: { state: 'done', result: result(columns, [[1]]) },
      });
      expect(within(frame('Hunt')).queryByText(/If Defender can't reach/)).toBeNull();
    });

    it('Open in query tab names the parameter workspace', async () => {
      withWorkspace('guid-a', [A, B], typedWidget('hunting', null));
      await screen.findAllByText(/Contoso/);
      fireEvent.click(within(frame('Hunt')).getByRole('button', { name: 'Hunt menu' }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Open in query tab' }));
      expect(useTabs.getState().tabs.at(-1)?.options?.workspaces?.[0]).toMatchObject({ customerId: 'guid-a', name: 'Contoso' });
    });

    it('Pick a workspace on a logs widget focuses the parameter bars picker', async () => {
      const refused: WidgetRun = {
        state: 'done',
        result: { ...result(columns, []), outcome: 'workspaceUnavailable', message: 'Pick a workspace before running.' },
      };
      withWorkspace('', [A, B], typedWidget('logs', null), { h: refused });
      act(() => useWorkbooks.getState().setParamsCollapsed('t', true));
      fireEvent.click(within(frame('Hunt')).getByRole('button', { name: 'Pick a workspace' }));
      await vi.waitFor(() => expect(document.activeElement).toBe(trigger()));
    });

    it('Open in query tab gives a query tab a text parameter, never the workspace type', () => {
      withWorkspace('guid-a');
      fireEvent.click(within(frame('Logs')).getByRole('button', { name: 'Logs menu' }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Open in query tab' }));
      expect(
        useTabs
          .getState()
          .tabs.at(-1)
          ?.parameters?.map((p) => p.type),
      ).toEqual(['text']);
    });
  });

  it('narrow: the tab’s grid stacks full width like the top level', () => {
    doc.widgets = [
      { ...widget('tw', 'tabs', ''), tabs: [{ id: 't1', name: 'One' }] },
      widget('in', 'markdown', 'Inside', undefined, { markdown: 'x', in: { tabs: 'tw', tab: 't1' } }),
    ];
    show({});
    const inner = document.querySelector('[data-wb-place="tw/t1"]')!;
    expect(inner.classList.contains('wb-grid')).toBe(true);
    expect(document.querySelector('[data-wb-place=""]')?.classList.contains('wb-grid')).toBe(true);
    expect(
      within(inner as HTMLElement)
        .getByRole('region', { name: 'Inside' })
        .classList.contains('wb-widget'),
    ).toBe(true);
    // The container rule is on .wb-widget wherever it sits, under the one .wb-canvas container.
    expect(styles).toMatch(/@container \(max-width: 899px\) \{ \.wb-widget \{ grid-column: 1 \/ -1;/);
  });

  it('reveals a widget: scrolls its frame into view, focuses it and clears the reveal', () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    show({});
    act(() => useWorkbooks.getState().reveal('t', 'tb'));
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView.mock.contexts[0]).toBe(frame('Users'));
    expect(document.activeElement).toBe(frame('Users'));
    expect(useWorkbooks.getState().revealing).toBeNull();
  });

  it('uses a reveal set before the workbook has loaded once its frame appears', () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    useWorkbooks.setState({ byTab: {} });
    const { unmount } = render(<WorkbookView tabId="t" />);
    act(() => useWorkbooks.getState().reveal('t', 'tb'));
    expect(screen.getByText('Opening the workbook…')).toBeTruthy();
    expect(useWorkbooks.getState().revealing).toEqual({ tabId: 't', widgetId: 'tb' });
    unmount();
    show({});
    expect(scrollIntoView.mock.contexts[0]).toBe(frame('Users'));
    expect(document.activeElement).toBe(frame('Users'));
    expect(useWorkbooks.getState().revealing).toBeNull();
  });

  it('leaves a reveal for another tab alone', () => {
    Element.prototype.scrollIntoView = vi.fn();
    show({});
    act(() => useWorkbooks.getState().reveal('other', 'tb'));
    expect(useWorkbooks.getState().revealing).toEqual({ tabId: 'other', widgetId: 'tb' });
    act(() => useWorkbooks.setState({ revealing: null }));
  });
});
