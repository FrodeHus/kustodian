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
    const runId = useTabs.getState().tabs[0]?.run?.runId;
    bridge.progress.forEach((h) => h({ tabId: id, runId, stage: 'fetching', detail: 'users' }));
    expect(useTabs.getState().tabs[0]?.run).toMatchObject({ stage: 'fetching', detail: 'users' });
    await done;

    expect(bridge.call).toHaveBeenCalledWith(
      'query.run',
      { tabId: id, source: 'graph', kql: 'users\n| count', refresh: false, parameters: [], runId: expect.any(String) },
      expect.any(AbortSignal),
    );
    // The run keeps the text it sent, for the Chart tab's `| render`.
    expect(useTabs.getState().tabs[0]?.run).toMatchObject({ state: 'done', result: ok, kql: 'users\n| count' });
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

  it('openWith_sets_text_title_and_not_dirty', () => {
    const params = [{ name: 'days', type: 'number', value: '30', required: true, choices: null }];
    const id = useTabs.getState().openWith({ source: 'graph', title: 'Stale guests', text: 'users', savedId: 's1', filePath: '/q.kql', parameters: params });

    const tab = useTabs.getState().tabs[0];
    expect(tab).toMatchObject({ id, source: 'graph', title: 'Stale guests', text: 'users', dirty: false, savedId: 's1', filePath: '/q.kql', parameters: params, history: [] });
    expect(useTabs.getState().activeId).toBe(id);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('restore_recreates_tabs_and_active', () => {
    useTabs.getState().open('graph');
    useTabs.getState().restore({
      version: 1,
      activeId: 'b',
      tabs: [
        { id: 'a', source: 'graph', title: 'Apps', text: 'applications', dirty: false, savedId: 's1', parameters: [], filePath: null },
        { id: 'b', source: 'graph', title: 'Draft', text: 'users | take 3', dirty: true, savedId: null, parameters: [], filePath: '/d.kql' },
      ],
    });

    const { tabs, activeId } = useTabs.getState();
    expect(tabs.map((t) => [t.id, t.title, t.text, t.dirty, t.savedId, t.filePath])).toEqual([
      ['a', 'Apps', 'applications', false, 's1', undefined],
      ['b', 'Draft', 'users | take 3', true, undefined, '/d.kql'],
    ]);
    expect(activeId).toBe('b');

    // An active id the session doesn't have falls back to the first tab.
    useTabs.getState().restore({ version: 1, activeId: 'gone', tabs: [{ id: 'c', source: 'graph', title: 'C', text: '', dirty: false, savedId: null, parameters: [], filePath: null }] });
    expect(useTabs.getState().activeId).toBe('c');
  });

  it('markSaved_clears_dirty_and_the_next_save_goes_where_it_last_saved', () => {
    const id = useTabs.getState().open('graph');
    useTabs.getState().setText(id, 'users');
    expect(useTabs.getState().tabs[0]?.dirty).toBe(true);

    useTabs.getState().markSaved(id, { savedId: 's9', filePath: null, title: 'All users', text: 'users' });

    expect(useTabs.getState().tabs[0]).toMatchObject({ dirty: false, savedId: 's9', title: 'All users', filePath: undefined });
    // Saved to a file: the library query is no longer where Save goes.
    useTabs.getState().markSaved(id, { filePath: '/u.kql', savedId: null, title: 'u.kql', text: 'users' });
    expect(useTabs.getState().tabs[0]).toMatchObject({ savedId: undefined, filePath: '/u.kql', title: 'u.kql' });
  });

  it('markSaved_keeps_a_tab_dirty_that_changed_while_it_was_saved', () => {
    const id = useTabs.getState().open('graph');
    useTabs.getState().setText(id, 'users');
    // Typed while the save was out.
    useTabs.getState().setText(id, 'users | take 1');

    useTabs.getState().markSaved(id, { savedId: 's9', title: 'All users', text: 'users' });

    expect(useTabs.getState().tabs[0]).toMatchObject({ dirty: true, savedId: 's9', title: 'All users' });
  });

  it('stale_progress_from_superseded_run_is_ignored', async () => {
    const answers: ((r: RunResult) => void)[] = [];
    bridge.call.mockImplementation(() => new Promise<RunResult>((resolve) => answers.push(resolve)));
    const id = useTabs.getState().open('graph');
    useTabs.getState().setText(id, 'users');

    const first = useTabs.getState().run(id, 'all');
    const firstRunId = useTabs.getState().tabs[0]?.run?.runId;
    const second = useTabs.getState().run(id, 'all');
    const secondRunId = useTabs.getState().tabs[0]?.run?.runId;
    expect(firstRunId).not.toBe(secondRunId);

    bridge.progress.forEach((h) => h({ tabId: id, runId: firstRunId, stage: 'fetching', detail: 'old' }));
    expect(useTabs.getState().tabs[0]?.run?.stage).toBeUndefined();
    bridge.progress.forEach((h) => h({ tabId: id, runId: secondRunId, stage: 'fetching', detail: 'users' }));
    expect(useTabs.getState().tabs[0]?.run).toMatchObject({ stage: 'fetching', detail: 'users' });

    answers.forEach((a) => a(ok));
    await Promise.all([first, second]);
    expect(bridge.call.mock.calls.map((c) => (c[1] as { runId: string }).runId)).toEqual([firstRunId, secondRunId]);
  });

  it('run_sends_parameters_and_refresh', async () => {
    bridge.call.mockResolvedValue(ok);
    const id = useTabs.getState().open('graph');
    useTabs.getState().setText(id, 'users | where createdDateTime > ago({days})');
    useTabs.getState().setParameters(id, [{ name: 'days', type: 'timespan', value: '7d', required: true, choices: null }]);

    await useTabs.getState().run(id, 'all', { refresh: true });

    expect(bridge.call).toHaveBeenCalledWith(
      'query.run',
      {
        tabId: id,
        source: 'graph',
        kql: 'users | where createdDateTime > ago({days})',
        refresh: true,
        parameters: [{ name: 'days', type: 'timespan', value: '7d', required: true }],
        runId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
      },
      expect.any(AbortSignal),
    );
  });

  it('run_sends_a_placeholder_without_a_definition_as_optional_text', async () => {
    bridge.call.mockResolvedValue(ok);
    const id = useTabs.getState().open('graph');
    useTabs.getState().setText(id, 'print {x}, {days}, "{inString}"');
    useTabs.getState().setParameters(id, [
      { name: 'days', type: 'timespan', value: '7d', required: true, choices: null },
      { name: 'gone', type: 'text', value: 'old', required: false, choices: null },
    ]);

    await useTabs.getState().run(id, 'all');

    // The same definitions the parameters form previews: every placeholder, in order, and nothing else.
    expect(bridge.call).toHaveBeenCalledWith(
      'query.run',
      expect.objectContaining({
        parameters: [
          { name: 'x', type: 'text', value: '', required: false },
          { name: 'days', type: 'timespan', value: '7d', required: true },
        ],
      }),
      expect.any(AbortSignal),
    );
  });

  it('run_on_a_raw_tab_does_nothing', async () => {
    const id = useTabs.getState().openWith({ source: 'raw', title: 'Raw request', text: 'GET /me' });

    await useTabs.getState().run(id, 'all');

    expect(bridge.call).not.toHaveBeenCalled();
    expect(useTabs.getState().tabs[0]?.run).toBeUndefined();
  });

  it('history_keeps_5_newest', async () => {
    let n = 0;
    bridge.call.mockImplementation(() => Promise.resolve({ ...ok, total: ++n }));
    const id = useTabs.getState().open('graph');
    useTabs.getState().setText(id, 'users');

    for (let i = 0; i < 7; i++) {
      await useTabs.getState().run(id, 'all');
    }

    expect(useTabs.getState().tabs[0]?.history.map((r) => r.total)).toEqual([7, 6, 5, 4, 3]);
  });

  it('pin_keeps_the_current_result_and_unpin_drops_it', async () => {
    bridge.call.mockResolvedValue(ok);
    const id = useTabs.getState().open('graph');
    useTabs.getState().setText(id, 'users');
    await useTabs.getState().run(id, 'all');

    useTabs.getState().pin(id);
    expect(useTabs.getState().tabs[0]?.pinned).toBe(ok);
    useTabs.getState().unpin(id);
    expect(useTabs.getState().tabs[0]?.pinned).toBeUndefined();
  });

  it('setTitle_renames_the_tab', () => {
    const id = useTabs.getState().open('graph');
    useTabs.getState().setTitle(id, 'Risky apps');
    expect(useTabs.getState().tabs[0]?.title).toBe('Risky apps');
  });

  it('setSource_changes_a_query_tab_and_its_runs_keep_theirs', async () => {
    bridge.call.mockResolvedValue(ok);
    const fresh = useTabs.getState().open('graph');
    const saved = useTabs.getState().openWith({ source: 'graph', title: 'Saved', text: 'DeviceInfo', savedId: 's1' });
    const raw = useTabs.getState().openWith({ source: 'raw', title: 'Raw', text: '' });
    useTabs.getState().setText(fresh, 'DeviceInfo');
    await useTabs.getState().run(fresh, 'all');

    useTabs.getState().setSource(fresh, 'hunting');
    useTabs.getState().setSource(saved, 'arg');
    useTabs.getState().setSource(raw, 'hunting');

    const [a, b, c] = useTabs.getState().tabs;
    expect(a).toMatchObject({ source: 'hunting' });
    // The run that went to Graph stays Graph's.
    expect(a?.run?.source).toBe('graph');
    // A saved query's source is part of what is saved.
    expect(b).toMatchObject({ source: 'arg', dirty: true });
    expect(c?.source).toBe('raw');

    await useTabs.getState().run(fresh, 'all');
    expect(bridge.call).toHaveBeenLastCalledWith('query.run', expect.objectContaining({ source: 'hunting' }), expect.anything());
    expect(useTabs.getState().tabs[0]?.run?.source).toBe('hunting');
  });

  it('hunting_run_sends_timespan_default_p30d', async () => {
    bridge.call.mockResolvedValue(ok);
    const id = useTabs.getState().open('hunting');
    useTabs.getState().setText(id, 'DeviceInfo | take 5');

    await useTabs.getState().run(id, 'all');
    expect(bridge.call).toHaveBeenLastCalledWith(
      'query.run',
      expect.objectContaining({ source: 'hunting', options: { timespan: 'P30D', scope: null } }),
      expect.any(AbortSignal),
    );

    // A picked timespan goes instead, and the run keeps what it had.
    useTabs.getState().setOptions(id, { timespan: 'P7D', scope: null });
    await useTabs.getState().run(id, 'all');
    expect(bridge.call).toHaveBeenLastCalledWith('query.run', expect.objectContaining({ options: { timespan: 'P7D', scope: null } }), expect.anything());
    expect(useTabs.getState().tabs[0]?.run?.options).toEqual({ timespan: 'P7D', scope: null });
  });

  it('arg_run_sends_scope', async () => {
    bridge.call.mockResolvedValue(ok);
    const id = useTabs.getState().open('arg');
    useTabs.getState().setText(id, 'Resources | take 5');

    await useTabs.getState().run(id, 'all');
    expect(bridge.call).toHaveBeenLastCalledWith(
      'query.run',
      expect.objectContaining({ source: 'arg', options: { timespan: null, scope: { kind: 'all', ids: [] } } }),
      expect.any(AbortSignal),
    );

    const scope = { kind: 'subscriptions' as const, ids: ['00000000-0000-0000-0000-000000000011'] };
    // The timespan a tab had as a hunting tab isn't sent to Resource Graph.
    useTabs.getState().setOptions(id, { timespan: 'P1D', scope });
    await useTabs.getState().run(id, 'all');
    expect(bridge.call).toHaveBeenLastCalledWith('query.run', expect.objectContaining({ options: { timespan: null, scope } }), expect.anything());
  });

  it('setOptions_marks_a_saved_tab_changed_and_rerun_sends_the_last_text_again', async () => {
    bridge.call.mockResolvedValue(ok);
    const saved = useTabs.getState().openWith({ source: 'arg', title: 'Saved', text: 'Resources\n\nResourceContainers', savedId: 's1' });
    useTabs.getState().setOptions(saved, { timespan: null, scope: { kind: 'managementGroup', ids: ['contoso-platform'] } });
    expect(useTabs.getState().tabs[0]).toMatchObject({ dirty: true, options: { scope: { kind: 'managementGroup', ids: ['contoso-platform'] } } });

    useTabs.getState().setCursor(saved, { line: 3, column: 1, selection: '', selectionLine: 3, selectionColumn: 1 });
    await useTabs.getState().run(saved, 'block');
    // The cursor moves on; a rerun (after granting Azure access) sends what the run sent.
    useTabs.getState().setCursor(saved, { line: 1, column: 1, selection: '', selectionLine: 1, selectionColumn: 1 });
    await useTabs.getState().rerun(saved);

    expect(bridge.call).toHaveBeenCalledTimes(2);
    expect(bridge.call).toHaveBeenLastCalledWith('query.run', expect.objectContaining({ kql: 'ResourceContainers', refresh: false }), expect.anything());
    expect(useTabs.getState().tabs[0]?.run?.origin).toEqual({ line: 3, column: 1 });
  });

  it('restore_and_openWith_keep_options', () => {
    const options = { timespan: 'P1D', scope: null };
    useTabs.getState().restore({
      version: 1,
      activeId: 'a',
      tabs: [{ id: 'a', source: 'hunting', title: 'A', text: 'DeviceInfo', dirty: false, savedId: null, parameters: [], filePath: null, options }],
    });
    const opened = useTabs.getState().openWith({ source: 'hunting', title: 'B', text: '', options });
    expect(useTabs.getState().tabs.map((t) => t.options)).toEqual([options, options]);
    expect(useTabs.getState().tabs.find((t) => t.id === opened)?.dirty).toBe(false);
  });
});
