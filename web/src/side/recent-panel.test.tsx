import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTabs } from '../tabs/tab-store';
import type { RecentRun } from '../wire';
import { RecentPanel } from './recent-panel';

const bridge = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../bridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../bridge')>()),
  call: bridge.call,
  on: () => () => undefined,
}));

const runs: RecentRun[] = [
  {
    id: 'r2',
    source: 'graph',
    text: 'users\n| where createdDateTime > ago({days})',
    parameters: [{ name: 'days', type: 'timespan', value: '7d', required: true }],
    startedAt: '2026-10-21T10:00:00Z',
    durationMs: 1200,
    rows: 42,
    outcome: 'ok',
  },
  { id: 'r1', source: 'graph', text: 'groups | take 1', parameters: [], startedAt: '2026-10-20T09:00:00Z', durationMs: 300, rows: 0, outcome: 'queryError' },
];

let listed: RecentRun[];

beforeEach(() => {
  listed = runs;
  bridge.call.mockReset();
  bridge.call.mockImplementation((method: string) => {
    if (method === 'recent.list') {
      return Promise.resolve({ runs: listed });
    }
    if (method === 'recent.clear') {
      listed = [];
    }
    return Promise.resolve(null);
  });
  useTabs.setState({ tabs: [], activeId: null, cursors: {} });
});

describe('RecentPanel', () => {
  it('recent_click_opens_with_parameters', async () => {
    render(<RecentPanel />);
    const rows = await screen.findAllByRole('button', { name: /^Open the run/ });
    // Newest first, with outcome and row count.
    expect(rows[0]?.textContent).toContain('users');
    expect(rows[0]?.textContent).toContain('42 rows');
    expect(rows[1]?.textContent).toContain('Query error');

    fireEvent.click(rows[0]!);

    const { tabs, activeId } = useTabs.getState();
    expect(tabs).toHaveLength(1);
    expect(tabs[0]).toMatchObject({
      id: activeId,
      source: 'graph',
      text: 'users\n| where createdDateTime > ago({days})',
      title: 'users',
      parameters: [{ name: 'days', type: 'timespan', value: '7d', required: true, choices: null }],
    });
    expect(tabs[0]?.savedId).toBeUndefined();
  });

  it('recent_clear_empties_the_list', async () => {
    render(<RecentPanel />);
    await screen.findAllByRole('button', { name: /^Open the run/ });

    fireEvent.click(screen.getByRole('button', { name: 'Clear recent' }));

    await waitFor(() => expect(bridge.call).toHaveBeenCalledWith('recent.clear'));
    expect(await screen.findByText('No runs yet.')).toBeTruthy();
  });

  it('recent_reloads_when_a_run_ends', async () => {
    render(<RecentPanel />);
    await screen.findAllByRole('button', { name: /^Open the run/ });
    const id = useTabs.getState().open('graph');
    const calls = () => bridge.call.mock.calls.filter((c) => c[0] === 'recent.list').length;
    const before = calls();

    useTabs.setState((s) => ({
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, run: { state: 'done', runId: 'x', startedAt: 0, origin: { line: 1, column: 1 } } } : t)),
    }));

    await waitFor(() => expect(calls()).toBe(before + 1));
  });

  it('recent_follows_active_source_with_all_toggle', async () => {
    listed = [...runs, { id: 'r3', source: 'arg', text: 'Resources | count', parameters: [], startedAt: '2026-10-21T11:00:00Z', durationMs: 900, rows: 1, outcome: 'ok' }];
    render(<RecentPanel source="arg" />);

    expect(await screen.findByRole('button', { name: /Resources \| count/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /groups \| take 1/ })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'All sources' }));
    expect(screen.getByRole('button', { name: /groups \| take 1/ })).toBeTruthy();
  });
});
