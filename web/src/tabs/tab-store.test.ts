import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BridgeError } from '../bridge';
import type { RunResult } from '../wire';
import { useTabs } from './tab-store';

const bridge = vi.hoisted(() => ({
  call: vi.fn(),
  progress: [] as ((data: unknown) => void)[],
}));

vi.mock('../bridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../bridge')>()),
  call: bridge.call,
  on: (event: string, handler: (data: unknown) => void) => {
    if (event === 'query.progress') {
      bridge.progress.push(handler);
    }
    return () => undefined;
  },
}));

const ok: RunResult = {
  outcome: 'ok',
  message: null,
  error: null,
  columns: [{ name: 'Count', type: 'long' }],
  rows: [[3]],
  total: 1,
  tables: [],
  durationMs: 12,
  droppedValues: 0,
  runId: 'run-1',
  diagnostics: [],
};

beforeEach(() => {
  bridge.call.mockReset();
  useTabs.setState({ tabs: [], activeId: null, cursors: {} });
});

describe('tab store', () => {
  it('open_adds_a_numbered_clean_tab_and_activates_it', () => {
    const first = useTabs.getState().open('graph');
    const second = useTabs.getState().open('graph');
    const { tabs, activeId } = useTabs.getState();
    expect(tabs.map((t) => [t.title, t.source, t.dirty])).toEqual([
      ['Query 1', 'graph', false],
      ['Query 2', 'graph', false],
    ]);
    expect(activeId).toBe(second);
    useTabs.getState().close(second);
    expect(useTabs.getState().activeId).toBe(first);
  });

  it('run_block_sends_the_block_at_the_cursor_and_keeps_the_result', async () => {
    bridge.call.mockResolvedValue(ok);
    const id = useTabs.getState().open('graph');
    useTabs.getState().setText(id, 'applications\n| take 1\n\nusers\n| count');
    useTabs.getState().setCursor(id, { line: 5, column: 3, selection: '', selectionLine: 5, selectionColumn: 3 });

    const done = useTabs.getState().run(id, 'block');
    expect(useTabs.getState().tabs[0]?.run?.state).toBe('running');
    bridge.progress.forEach((h) => h({ tabId: id, runId: 'run-1', stage: 'fetching', detail: 'users' }));
    expect(useTabs.getState().tabs[0]?.run).toMatchObject({ stage: 'fetching', detail: 'users' });
    await done;

    expect(bridge.call).toHaveBeenCalledWith(
      'query.run',
      { tabId: id, source: 'graph', kql: 'users\n| count', refresh: false },
      expect.any(AbortSignal),
    );
    expect(useTabs.getState().tabs[0]?.run).toMatchObject({ state: 'done', result: ok });
  });

  it('run_selection_and_all_send_what_they_name', async () => {
    bridge.call.mockResolvedValue(ok);
    const id = useTabs.getState().open('graph');
    useTabs.getState().setText(id, 'applications\n\nusers');
    useTabs.getState().setCursor(id, { line: 1, column: 1, selection: 'appl', selectionLine: 1, selectionColumn: 1 });

    await useTabs.getState().run(id, 'selection');
    await useTabs.getState().run(id, 'all');

    expect(bridge.call.mock.calls.map((c) => (c[1] as { kql: string }).kql)).toEqual(['appl', 'applications\n\nusers']);
  });

  it('cancel_aborts_the_run_and_marks_it_cancelled', async () => {
    bridge.call.mockImplementation(
      (_method: string, _params: unknown, signal: AbortSignal) =>
        new Promise((_, reject) => {
          signal.addEventListener('abort', () => reject(new BridgeError('cancelled', 'The request was cancelled.')));
        }),
    );
    const id = useTabs.getState().open('graph');
    useTabs.getState().setText(id, 'users');

    const done = useTabs.getState().run(id, 'all');
    useTabs.getState().cancel(id);
    await done;

    expect(useTabs.getState().tabs[0]?.run).toMatchObject({ state: 'done', cancelled: true });
  });

  it('a_failed_call_becomes_a_failed_result', async () => {
    bridge.call.mockRejectedValue(new BridgeError('failed', 'The host stopped.'));
    const id = useTabs.getState().open('graph');
    useTabs.getState().setText(id, 'users');

    await useTabs.getState().run(id, 'all');

    expect(useTabs.getState().tabs[0]?.run?.result).toMatchObject({ outcome: 'failed', message: 'The host stopped.' });
  });
});
