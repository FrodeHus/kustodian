import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Widget, WidgetType, WorkbookDoc } from './model';
import { MIN_SIZE, newWidget, newWorkbook } from './model';
import { place } from './layout';
import { useWorkbooks } from './workbook-store';
import { WorkbookView } from './workbook-view';

const call = vi.hoisted(() => vi.fn());
vi.mock('../bridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../bridge')>()),
  call,
  on: () => () => undefined,
}));

// Monaco doesn't run in jsdom; the widget editor's own tests cover it.
vi.mock('../editor/kql-editor', () => ({ default: () => null }));
// Recharts can't lay out in jsdom; the chart's own tests cover it.
vi.mock('../results/chart-view', () => ({ default: () => null }));

function widget(id: string, type: WidgetType, title: string, x: number, y: number): Widget {
  const w = newWidget(type, { x, y, w: 4, h: 12 });
  return { ...w, id, title };
}

let doc: WorkbookDoc;
const runAll = vi.fn(() => Promise.resolve());

function show() {
  useWorkbooks.setState({
    byTab: { t: { doc, values: { workbook: {}, widgets: {} }, runs: {}, editing: false, undo: [], redo: [], dirty: false, selections: {} } },
    runAll,
  });
  const view = render(<WorkbookView tabId="t" />);
  fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
  return view;
}

const state = () => useWorkbooks.getState().byTab.t!;
const layoutOf = (id: string) => state().doc.widgets.find((w) => w.id === id)?.layout;
const grip = (title: string) => screen.getByRole('button', { name: `Move ${title}` });
const live = () => document.querySelector('.wb-announce')!;

beforeEach(() => {
  call.mockReset().mockReturnValue(new Promise(() => undefined));
  runAll.mockClear();
  doc = { ...newWorkbook('Sign-in review'), widgets: [widget('a', 'table', 'Users', 0, 0), widget('b', 'markdown', 'Notes', 4, 0)] };
});

describe('workbook edit mode', () => {
  it('switches to the EDITING toolbar', () => {
    show();
    expect(screen.getByText('EDITING')).toBeTruthy();
    for (const name of ['+ Add widget', 'Parameters', 'Undo', 'Redo', 'Discard', 'Done']) {
      expect(screen.getByRole('button', { name })).toBeTruthy();
    }
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Parameters' }));
    expect(screen.getByRole('dialog', { name: 'Workbook parameters' })).toBeTruthy();
  });

  it('Add widget → Chart adds a widget at place’s spot, twice its minimum height', () => {
    show();
    const spot = place(doc.widgets, MIN_SIZE.chart.w, MIN_SIZE.chart.h * 2);
    fireEvent.click(screen.getByRole('button', { name: '+ Add widget' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Chart' }));
    const added = state().doc.widgets.at(-1)!;
    expect(added.type).toBe('chart');
    expect(added.layout).toEqual(spot);
  });

  it('shows each widget’s size, and Edit widget, Duplicate and Remove on the selected one', () => {
    show();
    const users = screen.getByRole('region', { name: 'Users' });
    expect(within(users).getByText('4 × 12')).toBeTruthy();
    expect(within(users).queryByRole('button', { name: 'Duplicate' })).toBeNull();
    fireEvent.focus(grip('Users'));
    const editWidget = within(users).getByRole('button', { name: 'Edit widget' });
    fireEvent.click(editWidget);
    const dialog = screen.getByRole('dialog', { name: 'Edit widget' });
    expect((within(dialog).getByRole('textbox', { name: 'Title' }) as HTMLInputElement).value).toBe('Users');
    // Ctrl+Z in the editor isn't the workbook's undo.
    fireEvent.keyDown(within(dialog).getByRole('button', { name: 'Cancel' }), { key: 'z', ctrlKey: true });
    expect(live().textContent).not.toBe('Undone');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(editWidget);
    fireEvent.click(within(users).getByRole('button', { name: 'Duplicate' }));
    expect(state().doc.widgets).toHaveLength(3);
    expect(state().doc.widgets[2]?.title).toBe('Users');
  });

  it('arrow right on a selected widget moves it one column and says where', () => {
    show();
    fireEvent.keyDown(grip('Notes'), { key: 'ArrowRight' });
    expect(layoutOf('b')).toMatchObject({ x: 5, y: 0 });
    expect(live().textContent).toBe('Moved to column 6, row 1');
  });

  it('Shift+arrow down grows it one row', () => {
    show();
    fireEvent.keyDown(grip('Users'), { key: 'ArrowDown', shiftKey: true });
    expect(layoutOf('a')).toMatchObject({ w: 4, h: 13 });
    expect(live().textContent).toBe('Resized to 4 × 13');
  });

  it('Delete removes it and focuses the previous grip; Ctrl+Z there restores it, Ctrl+Shift+Z removes it again', () => {
    show();
    fireEvent.keyDown(grip('Notes'), { key: 'Delete' });
    expect(layoutOf('b')).toBeUndefined();
    expect(document.activeElement).toBe(grip('Users'));
    fireEvent.keyDown(document.activeElement!, { key: 'z', ctrlKey: true });
    expect(layoutOf('b')).toBeTruthy();
    fireEvent.keyDown(document.activeElement!, { key: 'Z', ctrlKey: true, shiftKey: true });
    expect(layoutOf('b')).toBeUndefined();
  });

  it('Delete focuses the next grip, and Undo once the last widget is gone', () => {
    show();
    fireEvent.keyDown(grip('Users'), { key: 'Delete' });
    expect(document.activeElement).toBe(grip('Notes'));
    fireEvent.keyDown(grip('Notes'), { key: 'Delete' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Undo' }));
    fireEvent.keyDown(document.activeElement!, { key: 'z', ctrlKey: true });
    expect(layoutOf('b')).toBeTruthy();
  });

  it('says the same thing twice when it happens twice', () => {
    show();
    fireEvent.keyDown(grip('Users'), { key: 'ArrowLeft' });
    const first = live().firstChild;
    expect(live().textContent).toBe('Moved to column 1, row 1');
    fireEvent.keyDown(grip('Users'), { key: 'ArrowLeft' });
    expect(live().textContent).toBe('Moved to column 1, row 1');
    expect(live().firstChild).not.toBe(first);
  });

  it('moves focus and says so on Edit, Done and Discard', () => {
    show();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '+ Add widget' }));
    expect(live().textContent).toBe('Editing the workbook');
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Edit' }));
    expect(live().textContent).toBe('Done editing');
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Edit' }));
    expect(live().textContent).toBe('Changes discarded');
  });

  it('Discard restores the doc from when editing began', () => {
    show();
    fireEvent.keyDown(grip('Notes'), { key: 'Delete' });
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(state().doc).toBe(doc);
    expect(state().editing).toBe(false);
    expect(state().dirty).toBe(false);
    expect(runAll).not.toHaveBeenCalled();
  });

  it('Done leaves the tab dirty and reruns the changed workbook', () => {
    show();
    fireEvent.keyDown(grip('Notes'), { key: 'ArrowRight' });
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(state().editing).toBe(false);
    expect(state().dirty).toBe(true);
    expect(runAll).toHaveBeenCalledWith('t');
    expect(screen.getByRole('button', { name: 'Edit' })).toBeTruthy();
  });

  it('Done without a change doesn’t rerun', () => {
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(runAll).not.toHaveBeenCalled();
  });

  it('a pointer drag on the grip shows a drop target and moves by whole cells', () => {
    show();
    // 12 columns of 88 px with 12 px gaps: 100 px per column; rows are 8 + 12 = 20 px.
    const grid = document.querySelector('.wb-grid')!;
    grid.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, width: 1188, height: 600, right: 1188, bottom: 600, toJSON: () => ({}) });
    const g = grip('Users');
    fireEvent.pointerDown(g, { clientX: 10, clientY: 10, button: 0, pointerId: 1 });
    fireEvent.pointerMove(g, { clientX: 10 + 2 * 100 + 30, clientY: 10 + 3 * 20 + 4, pointerId: 1 });
    const target = document.querySelector<HTMLElement>('.wb-drop')!;
    // Where it lands: column 3, and up to the top, as the grid reflows.
    expect(target.style.getPropertyValue('--x')).toBe('3');
    expect(target.style.getPropertyValue('--y')).toBe('1');
    fireEvent.pointerUp(g, { clientX: 10 + 2 * 100 + 30, clientY: 10 + 3 * 20 + 4, pointerId: 1 });
    expect(document.querySelector('.wb-drop')).toBeNull();
    expect(layoutOf('a')).toMatchObject({ x: 2, y: 0 });
    // One edit for the whole gesture.
    expect(state().undo).toHaveLength(1);
  });

  it('Esc during a drag drops it, and so does losing the pointer capture: nothing moves', () => {
    show();
    const grid = document.querySelector('.wb-grid')!;
    grid.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, width: 1188, height: 600, right: 1188, bottom: 600, toJSON: () => ({}) });
    const g = grip('Users');
    const before = layoutOf('a');
    fireEvent.pointerDown(g, { clientX: 10, clientY: 10, button: 0, pointerId: 1 });
    fireEvent.pointerMove(g, { clientX: 230, clientY: 10, pointerId: 1 });
    expect(document.querySelector('.wb-drop')).not.toBeNull();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(document.querySelector('.wb-drop')).toBeNull();
    fireEvent.pointerUp(g, { clientX: 230, clientY: 10, pointerId: 1 });
    expect(layoutOf('a')).toEqual(before);

    fireEvent.pointerDown(g, { clientX: 10, clientY: 10, button: 0, pointerId: 2 });
    fireEvent.pointerMove(g, { clientX: 230, clientY: 10, pointerId: 2 });
    fireEvent(g, new Event('lostpointercapture', { bubbles: true }));
    expect(document.querySelector('.wb-drop')).toBeNull();
    fireEvent.pointerUp(g, { clientX: 230, clientY: 10, pointerId: 2 });
    expect(layoutOf('a')).toEqual(before);
    expect(state().undo).toHaveLength(0);
  });

  it('stops adding and duplicating at 100 widgets, and says why', () => {
    doc = { ...doc, widgets: Array.from({ length: 100 }, (_, i) => widget(`w${i}`, 'markdown', `Note ${i}`, (i % 3) * 4, Math.floor(i / 3) * 12)) };
    show();
    fireEvent.click(screen.getByRole('button', { name: '+ Add widget' }));
    expect(screen.getByText('A workbook can have at most 100 widgets.')).toBeTruthy();
    for (const item of screen.getAllByRole('menuitem')) {
      expect((item as HTMLButtonElement).disabled).toBe(true);
    }
    fireEvent.focus(grip('Note 0'));
    expect((screen.getByRole('button', { name: 'Duplicate' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('the saved-query picker takes focus with an empty library, so Esc closes it, and gives focus back to + Add widget', async () => {
    call.mockResolvedValue({ queries: [], folders: [], skipped: 0 });
    show();
    fireEvent.click(screen.getByRole('button', { name: '+ Add widget' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'From a saved query…' }));
    const picker = await screen.findByRole('dialog', { name: 'Add a saved query' });
    await within(picker).findByText('No saved queries yet.');
    expect(picker.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '+ Add widget' }));
  });

  it('the corner handle resizes', () => {
    show();
    const grid = document.querySelector('.wb-grid')!;
    grid.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, width: 1188, height: 600, right: 1188, bottom: 600, toJSON: () => ({}) });
    fireEvent.focus(grip('Users'));
    const corner = document.querySelector('.wb-resize-corner')!;
    fireEvent.pointerDown(corner, { clientX: 0, clientY: 0, button: 0, pointerId: 1 });
    fireEvent.pointerMove(corner, { clientX: 200, clientY: 40, pointerId: 1 });
    fireEvent.pointerUp(corner, { clientX: 200, clientY: 40, pointerId: 1 });
    expect(layoutOf('a')).toMatchObject({ w: 6, h: 14 });
  });

  it('From a saved query… adds a linked Table widget titled with the query’s name', async () => {
    call.mockResolvedValue({
      queries: [{ id: 'q1', name: 'Risky sign-ins', folder: null, source: 'hunting', text: 'SigninLogs', parameters: [], options: { timespan: 'P1D' }, version: 1, createdAt: '', modifiedAt: '' }],
      folders: [],
      skipped: 0,
    });
    show();
    fireEvent.click(screen.getByRole('button', { name: '+ Add widget' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'From a saved query…' }));
    expect(call).toHaveBeenCalledWith('library.list');
    const picker = await screen.findByRole('dialog', { name: 'Add a saved query' });
    await act(async () => fireEvent.click(await within(picker).findByRole('button', { name: /Risky sign-ins/ })));
    const added = state().doc.widgets.at(-1)!;
    expect(added.type).toBe('table');
    expect(added.title).toBe('Risky sign-ins');
    expect(added.query).toEqual({ source: 'hunting', text: 'SigninLogs', options: { timespan: 'P1D' }, parameters: [], saved: { id: 'q1', name: 'Risky sign-ins' } });
    expect(screen.queryByRole('dialog')).toBeNull();
    // Done re-reads the library for the new link, then runs without skipping the result cache.
    call.mockClear();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Done' })));
    expect(call).toHaveBeenCalledWith('library.list');
    expect(runAll).toHaveBeenCalledWith('t');
  });

  it('Done after an undo back to the start doesn’t rerun', () => {
    show();
    fireEvent.keyDown(grip('Notes'), { key: 'ArrowRight' });
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(runAll).not.toHaveBeenCalled();
  });

  it('closing the parameters dialog, by Cancel or Esc, returns focus to Parameters', () => {
    show();
    const button = screen.getByRole('button', { name: 'Parameters' });
    for (const close of [
      () => fireEvent.click(screen.getByRole('button', { name: 'Cancel' })),
      () => fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' }),
    ]) {
      fireEvent.click(button);
      close();
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(document.activeElement).toBe(button);
    }
  });

  it('Ctrl+Z is not the workbook’s undo while the parameters dialog is open', () => {
    show();
    fireEvent.keyDown(grip('Notes'), { key: 'ArrowRight' });
    const moved = layoutOf('b');
    fireEvent.click(screen.getByRole('button', { name: 'Parameters' }));
    fireEvent.keyDown(screen.getByRole('button', { name: 'Cancel' }), { key: 'z', ctrlKey: true });
    expect(layoutOf('b')).toEqual(moved);
    expect(state().undo).toHaveLength(1);
  });

  it('Ctrl+Z is not the workbook’s undo while the saved-query picker is open', () => {
    show();
    fireEvent.keyDown(grip('Notes'), { key: 'ArrowRight' });
    const moved = layoutOf('b');
    fireEvent.click(screen.getByRole('button', { name: '+ Add widget' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'From a saved query…' }));
    fireEvent.keyDown(screen.getByRole('button', { name: 'Cancel' }), { key: 'z', ctrlKey: true });
    expect(layoutOf('b')).toEqual(moved);
    expect(state().undo).toHaveLength(1);
  });

  it('the parameters dialog focuses its first parameter on open, or Add parameter when there is none', () => {
    doc = { ...doc, parameters: [{ name: 'Env', type: 'text', value: '', required: false, choices: null, label: null, multi: false, all: false, remember: false, huntingTimespan: false }] };
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Parameters' }));
    expect(document.activeElement).toBe(within(screen.getByRole('list', { name: 'Parameters' })).getByRole('button'));
    fireEvent.click(screen.getByRole('button', { name: 'Remove parameter' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    fireEvent.click(screen.getByRole('button', { name: 'Parameters' }));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Add parameter' }));
  });

  it('the widget editor focuses its Title on open', () => {
    show();
    fireEvent.focus(grip('Users'));
    fireEvent.click(within(screen.getByRole('region', { name: 'Users' })).getByRole('button', { name: 'Edit widget' }));
    expect(document.activeElement).toBe(within(screen.getByRole('dialog', { name: 'Edit widget' })).getByRole('textbox', { name: 'Title' }));
  });

  it('the widget editor, parameters dialog and saved-query picker cover the whole window, outside the workspace', () => {
    const { container } = show();
    const outside = (dialog: HTMLElement) => {
      expect(container.contains(dialog)).toBe(false);
      expect(dialog.closest('.fixed')?.parentElement).toBe(document.body);
    };
    fireEvent.focus(grip('Users'));
    fireEvent.click(within(screen.getByRole('region', { name: 'Users' })).getByRole('button', { name: 'Edit widget' }));
    outside(screen.getByRole('dialog', { name: 'Edit widget' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Parameters' }));
    outside(screen.getByRole('dialog', { name: 'Workbook parameters' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: '+ Add widget' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'From a saved query…' }));
    outside(screen.getByRole('dialog', { name: 'Add a saved query' }));
  });
});
