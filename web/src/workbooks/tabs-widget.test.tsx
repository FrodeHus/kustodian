import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Widget, WidgetType, WorkbookDoc } from './model';
import { newWidget, newWorkbook } from './model';
import type { WidgetRun, WorkbookState } from './workbook-store';
import { useWorkbooks } from './workbook-store';
import { WorkbookView } from './workbook-view';

const call = vi.hoisted(() => vi.fn());
vi.mock('../bridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../bridge')>()),
  call,
  on: () => () => undefined,
}));
vi.mock('../results/chart-view', () => ({ default: () => null }));

function widget(id: string, type: WidgetType, title: string, extra: Partial<Widget> = {}): Widget {
  return { ...newWidget(type, { x: 0, y: 0, w: 4, h: 12 }), id, title, ...extra };
}

let doc: WorkbookDoc;
const showTab = vi.fn((tabId: string, tabsId: string, tab: string) =>
  useWorkbooks.setState((s) => ({
    byTab: { ...s.byTab, [tabId]: { ...s.byTab[tabId]!, activeTabs: { ...s.byTab[tabId]!.activeTabs, [tabsId]: tab } } },
  })),
);
const refreshTab = vi.fn(() => Promise.resolve());
const runWidget = vi.fn(() => Promise.resolve());

function show(extra: Partial<WorkbookState> = {}, editing = false) {
  const state: WorkbookState = {
    doc,
    values: { workbook: {}, widgets: {} },
    runs: {},
    editing,
    undo: [],
    redo: [],
    dirty: false,
    selections: {},
    history: {},
    since: {},
    activeTabs: {},
    stale: {},
    ...extra,
  };
  useWorkbooks.setState({ byTab: { t: state }, showTab, refreshTab, runWidget });
  return render(<WorkbookView tabId="t" />);
}

const tab = (name: string | RegExp) => screen.getByRole('tab', { name });
const done: WidgetRun = {
  state: 'done',
  result: {
    outcome: 'ok',
    message: null,
    error: null,
    columns: [],
    rows: [],
    total: 0,
    tables: [],
    durationMs: 1,
    droppedValues: 0,
    runId: 'r',
    diagnostics: [],
    permissions: [],
  },
  finishedAt: 1,
} as WidgetRun;

beforeEach(() => {
  call.mockReset().mockReturnValue(new Promise(() => undefined));
  showTab.mockClear();
  refreshTab.mockClear();
  runWidget.mockClear();
  doc = {
    ...newWorkbook('Tabbed'),
    widgets: [
      widget('m', 'markdown', 'Notes', { markdown: 'Top' }),
      widget('tw', 'tabs', '', {
        layout: { x: 0, y: 12, w: 12, h: 30 },
        tabs: [
          { id: 't1', name: 'Overview' },
          { id: 't2', name: 'Details' },
          { id: 't3', name: 'Empty' },
        ],
      }),
      widget('a', 'markdown', 'Alpha', { markdown: 'A', in: { tabs: 'tw', tab: 't1' } }),
      widget('b', 'table', 'Beta', { in: { tabs: 'tw', tab: 't2' } }),
    ],
  };
});

describe('TabsWidget', () => {
  it('print renders every tab under its name, running the hidden tabs’ widgets that haven’t run first', async () => {
    const print = vi.spyOn(window, 'print').mockImplementation(() => undefined);
    call.mockResolvedValue(false);
    doc.widgets = doc.widgets.map((w) => (w.id === 'b' ? { ...w, query: { ...w.query!, text: 'Users' } } : w));
    const { container } = show();
    fireEvent.click(screen.getByRole('button', { name: 'Workbook menu' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Print or save as PDF…' }));
    await vi.waitFor(() => expect(print).toHaveBeenCalledTimes(1));
    expect(runWidget).toHaveBeenCalledWith('t', 'b');
    const printed = container.querySelector('.wb-print-tabs')!;
    expect([...printed.querySelectorAll('h3')].map((h) => h.textContent)).toEqual(['Overview', 'Details', 'Empty']);
    expect(within(printed as HTMLElement).getByRole('region', { name: 'Beta' })).toBeTruthy();
    // The screen keeps its one tab; the print copy goes once the print ends.
    expect(printed.classList.contains('print-only')).toBe(true);
    fireEvent(window, new Event('afterprint'));
    expect(container.querySelector('.wb-print-tabs')).toBeNull();
    print.mockRestore();
  });

  it('a workbook with a tabs widget shows plain widgets and the first tab’s widgets only', () => {
    show();
    expect(screen.getByRole('region', { name: 'Notes' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Alpha' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Beta' })).toBeNull();
    expect(tab(/Overview/).getAttribute('aria-selected')).toBe('true');
    expect(tab(/Overview/).dataset.wbTab).toBe('t1');
    expect(tab(/Overview/).dataset.wbTabs).toBe('tw');
    expect(within(screen.getByRole('tabpanel')).getByRole('region', { name: 'Alpha' })).toBeTruthy();
  });

  it('clicking a tab shows its widgets and calls showTab', () => {
    show();
    fireEvent.click(tab(/Details/));
    expect(showTab).toHaveBeenCalledWith('t', 'tw', 't2');
    expect(screen.getByRole('region', { name: 'Beta' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Alpha' })).toBeNull();
    expect(tab(/Details/).getAttribute('aria-selected')).toBe('true');
  });

  it('arrow keys move focus between tabs; Enter or Space shows one', () => {
    show();
    fireEvent.keyDown(tab(/Overview/), { key: 'ArrowRight' });
    expect(document.activeElement).toBe(tab(/Details/));
    expect(tab(/Details/).tabIndex).toBe(0);
    // Showing a tab runs its queries: arrowing past one doesn't show it.
    expect(tab(/Overview/).getAttribute('aria-selected')).toBe('true');
    expect(showTab).not.toHaveBeenCalled();
    fireEvent.keyDown(tab(/Details/), { key: 'Enter' });
    expect(showTab).toHaveBeenCalledWith('t', 'tw', 't2');
    expect(tab(/Details/).getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(tab(/Details/), { key: 'End' });
    expect(document.activeElement).toBe(tab(/Empty/));
    fireEvent.keyDown(tab(/Empty/), { key: 'ArrowRight' });
    expect(document.activeElement).toBe(tab(/Overview/));
    fireEvent.keyDown(tab(/Overview/), { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(tab(/Empty/));
    fireEvent.keyDown(tab(/Empty/), { key: 'Home' });
    expect(document.activeElement).toBe(tab(/Overview/));
    expect(tab(/Overview/).tabIndex).toBe(0);
    expect(tab(/Details/).tabIndex).toBe(-1);
    expect(showTab).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(tab(/Overview/), { key: ' ' });
    expect(showTab).toHaveBeenLastCalledWith('t', 'tw', 't1');
    expect(screen.getByRole('tabpanel').tabIndex).toBe(0);
  });

  it('tab marks show "not run" and "out of date"; a widget without query text never runs, so it isn\'t "not run"', () => {
    doc.widgets[3] = { ...doc.widgets[3]!, query: { ...doc.widgets[3]!.query!, text: 'T' } };
    doc.widgets.push(widget('e', 'table', 'Empty query', { in: { tabs: 'tw', tab: 't1' } }));
    const { unmount } = show();
    expect(tab(/Details/).textContent).toContain('not run');
    expect(tab(/Overview/).textContent).not.toContain('not run');
    unmount();
    show({ runs: { b: done }, stale: { b: true } });
    expect(tab(/Details/).textContent).toContain('out of date');
    expect(tab(/Details/).textContent).not.toContain('not run');
  });

  it('an empty tab shows its text, in view and edit mode', () => {
    const { unmount } = show({ activeTabs: { tw: 't3' } });
    expect(screen.getByText('No widgets on this tab')).toBeTruthy();
    unmount();
    show({ activeTabs: { tw: 't3' } }, true);
    expect(screen.getByText('Drag a widget here or use Move to…')).toBeTruthy();
    expect(document.querySelector('[data-wb-place="tw/t3"]')).toBeTruthy();
  });

  it('the tabs widget’s Refresh reruns the visible tab only', () => {
    show({ activeTabs: { tw: 't2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Untitled widget menu' }));
    expect(screen.getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['Refresh', 'Full screen']);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Refresh' }));
    expect(refreshTab).toHaveBeenCalledWith('t', 'tw');
    expect(runWidget).not.toHaveBeenCalled();
  });

  describe('editing tabs', () => {
    const tabsOf = () =>
      useWorkbooks
        .getState()
        .byTab.t!.doc.widgets.find((w) => w.id === 'tw')!
        .tabs!.map((t) => t.name);
    const widgets = () => useWorkbooks.getState().byTab.t!.doc.widgets;
    const menu = (name: string) => fireEvent.click(screen.getByRole('button', { name: `${name} tab menu` }));
    const item = (name: string) => screen.getByRole('menuitem', { name }) as HTMLButtonElement;

    it('Add tab adds and focuses a rename box', () => {
      show({}, true);
      fireEvent.click(screen.getByRole('button', { name: 'Add tab' }));
      expect(tabsOf()).toEqual(['Overview', 'Details', 'Empty', 'Tab 4']);
      const added = useWorkbooks.getState().byTab.t!.doc.widgets.find((w) => w.id === 'tw')!.tabs![3]!;
      expect(showTab).toHaveBeenCalledWith('t', 'tw', added.id);
      const box = screen.getByRole('textbox', { name: 'Tab name' }) as HTMLInputElement;
      expect(document.activeElement).toBe(box);
      expect(box.value).toBe('Tab 4');
      expect(useWorkbooks.getState().byTab.t!.dirty).toBe(true);
    });

    it('rename commits on Enter, cancels on Esc, and keeps the old name when empty', () => {
      show({}, true);
      // Enter on the shown tab renames it; on another it shows that tab.
      fireEvent.keyDown(tab(/Overview/), { key: 'Enter' });
      let box = screen.getByRole('textbox', { name: 'Tab name' }) as HTMLInputElement;
      expect(box.maxLength).toBe(40);
      fireEvent.change(box, { target: { value: 'Summary' } });
      fireEvent.keyDown(box, { key: 'Enter' });
      expect(tabsOf()[0]).toBe('Summary');
      expect(screen.queryByRole('textbox', { name: 'Tab name' })).toBeNull();
      expect(document.activeElement).toBe(tab(/Summary/));
      const undos = useWorkbooks.getState().byTab.t!.undo.length;
      fireEvent.doubleClick(tab(/Summary/));
      box = screen.getByRole('textbox', { name: 'Tab name' }) as HTMLInputElement;
      fireEvent.change(box, { target: { value: 'Nope' } });
      fireEvent.keyDown(box, { key: 'Escape' });
      expect(tabsOf()[0]).toBe('Summary');
      fireEvent.doubleClick(tab(/Summary/));
      box = screen.getByRole('textbox', { name: 'Tab name' }) as HTMLInputElement;
      fireEvent.change(box, { target: { value: '   ' } });
      fireEvent.blur(box);
      expect(tabsOf()[0]).toBe('Summary');
      expect(useWorkbooks.getState().byTab.t!.undo).toHaveLength(undos);
      fireEvent.keyDown(tab(/Details/), { key: 'Enter' });
      expect(showTab).toHaveBeenLastCalledWith('t', 'tw', 't2');
      expect(screen.queryByRole('textbox', { name: 'Tab name' })).toBeNull();
      menu('Details');
      fireEvent.click(item('Rename'));
      expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Tab name' }));
    });

    it('Move left and Move right reorder, and are disabled at the ends', () => {
      show({}, true);
      menu('Overview');
      expect(item('Move left').disabled).toBe(true);
      fireEvent.click(item('Move right'));
      expect(tabsOf()).toEqual(['Details', 'Overview', 'Empty']);
      menu('Overview');
      fireEvent.click(item('Move right'));
      expect(tabsOf()).toEqual(['Details', 'Empty', 'Overview']);
      menu('Overview');
      expect(item('Move right').disabled).toBe(true);
      fireEvent.click(item('Move left'));
      expect(tabsOf()).toEqual(['Details', 'Overview', 'Empty']);
    });

    it('dragging a tab past another reorders it, and a click still shows a tab', () => {
      show({}, true);
      screen
        .getAllByRole('tab')
        .forEach((el, i) => (el.getBoundingClientRect = () => ({ left: i * 100, width: 100, right: i * 100 + 100 }) as DOMRect));
      fireEvent.pointerDown(tab(/Overview/), { button: 0, clientX: 50, pointerId: 1 });
      fireEvent.pointerMove(tab(/Overview/), { clientX: 260, pointerId: 1 });
      fireEvent.pointerUp(tab(/Overview/), { clientX: 260, pointerId: 1 });
      fireEvent.click(tab(/Overview/));
      expect(tabsOf()).toEqual(['Details', 'Empty', 'Overview']);
      // Overview stays shown (pinned before the move), and the click that ends the drag shows nothing.
      expect(showTab.mock.calls).toEqual([['t', 'tw', 't1']]);
      expect(tab(/Overview/).getAttribute('aria-selected')).toBe('true');
      fireEvent.pointerDown(tab(/Details/), { button: 0, clientX: 50, pointerId: 1 });
      fireEvent.pointerUp(tab(/Details/), { clientX: 52, pointerId: 1 });
      fireEvent.click(tab(/Details/));
      expect(showTab).toHaveBeenCalledWith('t', 'tw', 't2');
      expect(tabsOf()).toEqual(['Details', 'Empty', 'Overview']);
    });

    it('Esc or a lost pointer capture drops a tab drag: nothing moves, and the click after Esc shows nothing', () => {
      show({}, true);
      screen
        .getAllByRole('tab')
        .forEach((el, i) => (el.getBoundingClientRect = () => ({ left: i * 100, width: 100, right: i * 100 + 100 }) as DOMRect));
      fireEvent.pointerDown(tab(/Details/), { button: 0, clientX: 150, pointerId: 1 });
      fireEvent.pointerMove(tab(/Details/), { clientX: 260, pointerId: 1 });
      fireEvent.keyDown(window, { key: 'Escape' });
      fireEvent.pointerUp(tab(/Details/), { clientX: 260, pointerId: 1 });
      fireEvent.click(tab(/Details/));
      expect(showTab).not.toHaveBeenCalled();
      fireEvent.pointerDown(tab(/Details/), { button: 0, clientX: 150, pointerId: 1 });
      fireEvent.pointerMove(tab(/Details/), { clientX: 260, pointerId: 1 });
      fireEvent.lostPointerCapture(tab(/Details/), { pointerId: 1 });
      fireEvent.pointerUp(tab(/Details/), { clientX: 260, pointerId: 1 });
      expect(tabsOf()).toEqual(['Overview', 'Details', 'Empty']);
      expect(useWorkbooks.getState().byTab.t!.undo).toHaveLength(0);
    });

    it('deleting the last tab removes the tabs widget the way Remove does: focus to the next grip, and said', () => {
      doc = { ...doc, widgets: doc.widgets.filter((w) => w.id !== 'b').map((w) => (w.id === 'tw' ? { ...w, tabs: [w.tabs![0]!] } : w)) };
      show({}, true);
      menu('Overview');
      fireEvent.click(item('Delete'));
      fireEvent.click(screen.getByRole('button', { name: 'Delete them too' }));
      expect(widgets().map((w) => w.id)).toEqual(['m']);
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Move Notes' }));
      expect(document.querySelector('.wb-announce')!.textContent).toBe('Removed Untitled widget');
    });

    it('deleting an empty tab asks nothing', () => {
      show({}, true);
      fireEvent.click(tab(/Empty/));
      menu('Empty');
      fireEvent.click(item('Delete'));
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(tabsOf()).toEqual(['Overview', 'Details']);
    });

    it('deleting a tab with widgets asks, and Move them moves them to the next tab', () => {
      show({}, true);
      menu('Overview');
      fireEvent.click(item('Delete'));
      const dialog = screen.getByRole('dialog', { name: 'Delete Overview? It has 1 widget.' });
      const moveThem = within(dialog).getByRole('button', { name: 'Move them to Details' });
      expect(document.activeElement).toBe(moveThem);
      expect(within(dialog).getByRole('button', { name: 'Delete them too' })).toBeTruthy();
      fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
      expect(tabsOf()).toEqual(['Overview', 'Details', 'Empty']);
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Overview tab menu' }));
      menu('Overview');
      fireEvent.click(item('Delete'));
      fireEvent.click(screen.getByRole('button', { name: 'Move them to Details' }));
      expect(tabsOf()).toEqual(['Details', 'Empty']);
      expect(widgets().find((w) => w.id === 'a')?.in).toEqual({ tabs: 'tw', tab: 't2' });
      expect(showTab).toHaveBeenLastCalledWith('t', 'tw', 't2');
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('the last tab’s confirm moves its widgets to the top level', () => {
      doc = { ...doc, widgets: doc.widgets.filter((w) => w.id !== 'b').map((w) => (w.id === 'tw' ? { ...w, tabs: [w.tabs![0]!] } : w)) };
      show({}, true);
      menu('Overview');
      fireEvent.click(item('Delete'));
      fireEvent.click(screen.getByRole('button', { name: 'Move them to the top level' }));
      expect(widgets().map((w) => w.id)).toEqual(['m', 'a']);
      expect(widgets().find((w) => w.id === 'a')?.in).toBeUndefined();
    });

    it('Delete them too deletes them', () => {
      show({}, true);
      menu('Overview');
      fireEvent.click(item('Delete'));
      fireEvent.click(screen.getByRole('button', { name: 'Delete them too' }));
      expect(tabsOf()).toEqual(['Details', 'Empty']);
      expect(widgets().map((w) => w.id)).toEqual(['m', 'tw', 'b']);
    });

    it('Undo after deleting a tab with widgets brings back the tab and its widgets with the same ids and layouts', () => {
      show({}, true);
      const before = widgets();
      menu('Overview');
      fireEvent.click(item('Delete'));
      fireEvent.click(screen.getByRole('button', { name: 'Move them to Details' }));
      fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
      expect(widgets()).toEqual(before);
      expect(tabsOf()).toEqual(['Overview', 'Details', 'Empty']);
    });
  });
});
