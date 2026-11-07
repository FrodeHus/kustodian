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
  useWorkbooks.setState((s) => ({ byTab: { ...s.byTab, [tabId]: { ...s.byTab[tabId]!, activeTabs: { ...s.byTab[tabId]!.activeTabs, [tabsId]: tab } } } })),
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
const done: WidgetRun = { state: 'done', result: { outcome: 'ok', message: null, error: null, columns: [], rows: [], total: 0, tables: [], durationMs: 1, droppedValues: 0, runId: 'r', diagnostics: [], permissions: [] }, finishedAt: 1 } as WidgetRun;

beforeEach(() => {
  call.mockReset().mockReturnValue(new Promise(() => undefined));
  showTab.mockClear();
  refreshTab.mockClear();
  runWidget.mockClear();
  doc = {
    ...newWorkbook('Tabbed'),
    widgets: [
      widget('m', 'markdown', 'Notes', { markdown: 'Top' }),
      widget('tw', 'tabs', '', { layout: { x: 0, y: 12, w: 12, h: 30 }, tabs: [{ id: 't1', name: 'Overview' }, { id: 't2', name: 'Details' }, { id: 't3', name: 'Empty' }] }),
      widget('a', 'markdown', 'Alpha', { markdown: 'A', in: { tabs: 'tw', tab: 't1' } }),
      widget('b', 'table', 'Beta', { in: { tabs: 'tw', tab: 't2' } }),
    ],
  };
});

describe('TabsWidget', () => {
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

  it('arrow keys move between tabs', () => {
    show();
    fireEvent.keyDown(tab(/Overview/), { key: 'ArrowRight' });
    expect(document.activeElement).toBe(tab(/Details/));
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
  });

  it('tab marks show "not run" and "out of date"', () => {
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
});
