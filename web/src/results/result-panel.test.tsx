import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTabs } from '../tabs/tab-store';
import type { RunResult } from '../wire';
import { ResultPanel } from './result-panel';

const call = vi.hoisted(() => vi.fn());
vi.mock('../bridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../bridge')>()),
  call,
  on: () => () => undefined,
}));

// Recharts can't lay out in jsdom; the chart's own tests cover it.
vi.mock('./chart-view', () => ({ default: () => <p>The chart</p> }));

const result: RunResult = {
  outcome: 'ok',
  message: null,
  error: null,
  columns: [
    { name: 'displayName', type: 'string' },
    { name: 'tags', type: 'dynamic' },
  ],
  rows: [
    ['Contoso', { kind: 'secret' }],
    ['Payroll', null],
  ],
  total: 2,
  tables: [],
  durationMs: 40,
  droppedValues: 0,
  runId: 'run-1',
  diagnostics: [{ atMs: 0, kind: 'request', detail: 'GET applications', status: 200, durationMs: 30, bytes: 100 }],
  permissions: [],
};

const props = { tabId: 't1', title: 'Expired apps', kql: 'applications', result };

beforeEach(() => {
  call.mockReset();
  useTabs.setState({ tabs: [], activeId: null, cursors: {} });
});

describe('ResultPanel', () => {
  it('result_tabs_roving_keys', async () => {
    render(<ResultPanel {...props} />);
    const tabs = screen.getAllByRole('tab');

    expect(tabs.map((t) => t.textContent)).toEqual(['Rows · 2', 'Chart', 'JSON', 'Diagnostics']);
    expect(tabs.map((t) => t.tabIndex)).toEqual([0, -1, -1, -1]);
    for (const tab of tabs) {
      expect(document.getElementById(tab.getAttribute('aria-controls') ?? '')?.getAttribute('role')).toBe('tabpanel');
    }

    tabs[0]!.focus();
    fireEvent.keyDown(tabs[0]!, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(tabs[1]);
    expect(tabs[1]!.getAttribute('aria-selected')).toBe('true');
    expect(await screen.findByText('The chart')).toBeTruthy();

    fireEvent.keyDown(tabs[1]!, { key: 'End' });
    expect(document.activeElement).toBe(tabs[3]);
    expect(screen.getByRole('list', { name: 'Event log' })).toBeTruthy();

    fireEvent.keyDown(tabs[3]!, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(tabs[0]);
    fireEvent.keyDown(tabs[0]!, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(tabs[3]);
    fireEvent.keyDown(tabs[3]!, { key: 'Home' });
    expect(document.activeElement).toBe(tabs[0]);
    expect(screen.getByRole('region', { name: 'Result rows' })).toBeTruthy();

    fireEvent.click(tabs[2]!);
    expect(screen.getByText(/"displayName": "Contoso"/)).toBeTruthy();
  });

  it('result_panel_pin_adds_compare', () => {
    const id = useTabs.getState().openWith({ source: 'graph', title: 'Expired apps', text: 'applications' });
    useTabs.setState((s) => ({
      tabs: s.tabs.map((t) => ({ ...t, run: { state: 'done', runId: 'run-1', result, startedAt: 0, origin: { line: 1, column: 1 } } })),
    }));
    const { rerender } = render(<ResultPanel {...props} tabId={id} />);

    fireEvent.click(screen.getByRole('button', { name: 'Pin to compare' }));
    expect(useTabs.getState().tabs[0]?.pinned).toBe(result);

    rerender(<ResultPanel {...props} tabId={id} pinned={result} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Compare' }));
    expect(screen.getByText('0 added · 0 removed · 0 changed · 2 the same')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Unpin' }));
    expect(useTabs.getState().tabs[0]?.pinned).toBeUndefined();
  });

  it('result_panel_exports_every_row_with_the_tab_title', async () => {
    call.mockResolvedValue({ path: '/tmp/Expired apps.md', name: 'Expired apps.md' });
    render(<ResultPanel {...props} />);

    // Filtering the grid doesn't change what Export writes.
    fireEvent.change(screen.getByRole('searchbox', { name: 'Filter rows' }), { target: { value: 'Payroll' } });
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    fireEvent.click(within(screen.getByRole('menu', { name: 'Export' })).getByRole('menuitem', { name: 'Markdown' }));

    await waitFor(() => expect(call).toHaveBeenCalled());
    expect(call.mock.calls[0]?.[0]).toBe('file.saveAs');
    expect(call.mock.calls[0]?.[1]).toMatchObject({ suggestedName: 'Expired apps.md' });
    const { content } = call.mock.calls[0]![1] as { content: string };
    expect(content.split('\n')).toHaveLength(4);
    expect(await screen.findByText('Exported 2 rows to Expired apps.md.')).toBeTruthy();
  });

  it('result_panel_opens_row_details', () => {
    const { container } = render(<ResultPanel {...props} />);

    fireEvent.doubleClick(container.querySelector('tbody tr[data-index="0"]')!);
    const sheet = screen.getByRole('dialog', { name: 'Row details: Contoso' });
    expect(within(sheet).getByText(/"kind": "secret"/)).toBeTruthy();

    fireEvent.keyDown(sheet, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: /Row details/ })).toBeNull();
  });
});
