import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BridgeError } from '../bridge';
import { useTabs } from '../tabs/tab-store';
import type { Session, SessionAnswer } from '../wire';
import { startSessionSync } from './session-sync';

const bridge = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../bridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../bridge')>()),
  call: bridge.call,
  on: () => () => undefined,
}));

const saved: Session = {
  version: 1,
  activeId: 'b',
  tabs: [
    { id: 'a', source: 'graph', title: 'Apps', text: 'applications', dirty: false, savedId: 's1', parameters: [], filePath: null },
    { id: 'b', source: 'graph', title: 'Draft', text: 'users | take 3', dirty: true, savedId: null, parameters: [], filePath: null },
  ],
};

function host(answer: SessionAnswer | Error) {
  bridge.call.mockImplementation((method: string) => {
    if (method === 'session.get') {
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    }
    return Promise.resolve({ dropped: 0 });
  });
}

const saves = () => bridge.call.mock.calls.filter((c) => c[0] === 'session.save').map((c) => (c[1] as { session: Session }).session);

const UNREADABLE = 'Couldn’t read your last session; changes won’t be saved until it can be read.';

let stop: (() => void) | undefined;

beforeEach(() => {
  bridge.call.mockReset();
  useTabs.setState({ tabs: [], activeId: null, cursors: {} });
});

afterEach(() => {
  stop?.();
  stop = undefined;
  vi.useRealTimers();
});

describe('session sync', () => {
  it('session_sync_keeps_a_raw_tabs_request_but_never_a_header_it_could_not_send', async () => {
    vi.useFakeTimers();
    host({ session: { ...saved, tabs: [] }, corrupt: false });
    stop = startSessionSync();
    await vi.waitFor(() => expect(useTabs.getState().tabs).toHaveLength(1));

    const id = useTabs.getState().openWith({
      source: 'raw',
      title: 'Raw request 1',
      text: 'me',
      raw: {
        version: 'v1.0',
        headers: [
          { name: 'Authorization', value: 'Bearer typed-token' },
          { name: ' ConsistencyLevel ', value: 'eventual' },
          { name: ' Authorization', value: 'Bearer typed-token' },
          { name: 'X-Line', value: 'a\r\nb' },
          { name: 'Proxy-Authorization', value: 'Basic proxy-secret' },
          { name: 'Transfer-Encoding', value: 'chunked' },
          { name: 'Content-Type', value: 'application/json' },
        ],
      },
    });
    await vi.advanceTimersByTimeAsync(1000);

    const tabs = saves().at(-1)!.tabs;
    expect(tabs.find((t) => t.id === id)!.raw).toEqual({ version: 'v1.0', headers: [{ name: 'ConsistencyLevel', value: 'eventual' }] });
    expect(JSON.stringify(saves())).not.toContain('typed-token');
    expect(JSON.stringify(saves())).not.toContain('proxy-secret');
    // Other tabs have no raw request.
    expect(tabs.find((t) => t.id !== id)).not.toHaveProperty('raw');
  });

  it('session_sync_debounces_saves_1s', async () => {
    vi.useFakeTimers();
    host({ session: saved, corrupt: false });
    stop = startSessionSync();
    await vi.waitFor(() => expect(useTabs.getState().tabs).toHaveLength(2));

    // Restoring is not a change to save.
    await vi.advanceTimersByTimeAsync(1500);
    expect(saves()).toEqual([]);

    // Unsaved text came back.
    expect(useTabs.getState().tabs[1]).toMatchObject({ text: 'users | take 3', dirty: true });
    expect(useTabs.getState().activeId).toBe('b');

    useTabs.getState().setText('a', 'applications | take 1');
    await vi.advanceTimersByTimeAsync(600);
    useTabs.getState().setText('a', 'applications | take 2');
    await vi.advanceTimersByTimeAsync(999);
    expect(saves()).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(saves()).toEqual([
      {
        version: 1,
        activeId: 'b',
        tabs: [
          { id: 'a', source: 'graph', title: 'Apps', text: 'applications | take 2', dirty: true, savedId: 's1', parameters: [], filePath: null },
          saved.tabs[1],
        ],
      },
    ]);

    // A run changes the tab but not what the session keeps: nothing to save.
    useTabs.setState((s) => ({ tabs: s.tabs.map((t) => ({ ...t, history: [] })) }));
    await vi.advanceTimersByTimeAsync(1500);
    expect(saves()).toHaveLength(1);
  });

  it('session_sync_saves_at_once_on_pagehide', async () => {
    host({ session: saved, corrupt: false });
    stop = startSessionSync();
    await vi.waitFor(() => expect(useTabs.getState().tabs).toHaveLength(2));

    useTabs.getState().setTitle('a', 'Applications');
    window.dispatchEvent(new Event('pagehide'));

    expect(saves().map((s) => s.tabs[0]?.title)).toEqual(['Applications']);
  });

  it('session_restore_falls_back_to_one_tab', async () => {
    host({ session: { version: 1, activeId: null, tabs: [] }, corrupt: false });
    stop = startSessionSync();
    await vi.waitFor(() => expect(useTabs.getState().tabs).toHaveLength(1));
    expect(useTabs.getState().tabs[0]).toMatchObject({ source: 'graph', title: 'Query 1', text: '', dirty: false });
    stop();

  });

  it('an_unreadable_session_is_never_overwritten_and_is_restored_when_a_retry_reads_it', async () => {
    vi.useFakeTimers();
    let reads = 0;
    bridge.call.mockImplementation((method: string) => {
      if (method === 'session.get') {
        return ++reads <= 2 ? Promise.reject(new BridgeError('failed', 'The file is locked.')) : Promise.resolve({ session: saved, corrupt: false });
      }
      return Promise.resolve({ dropped: 0 });
    });
    const notify = vi.fn();
    stop = startSessionSync(notify);

    // The window still opens with one empty Graph tab to work in, but says it won't save.
    await vi.advanceTimersByTimeAsync(0);
    expect(useTabs.getState().tabs).toHaveLength(1);
    expect(notify).toHaveBeenCalledWith(UNREADABLE);
    const temporary = useTabs.getState().tabs[0]!.id;
    useTabs.getState().setText(temporary, 'groups | count');
    window.dispatchEvent(new Event('pagehide'));
    await vi.advanceTimersByTimeAsync(4999);
    expect(saves()).toEqual([]);
    expect(reads).toBe(1);

    // Retries every 5 s; the second retry reads it. The session comes back, the tab typed in meanwhile is kept after it.
    await vi.advanceTimersByTimeAsync(1);
    expect(reads).toBe(2);
    await vi.advanceTimersByTimeAsync(5000);
    expect(reads).toBe(3);
    expect(useTabs.getState().tabs.map((t) => t.id)).toEqual(['a', 'b', temporary]);
    expect(useTabs.getState().tabs[2]?.text).toBe('groups | count');

    // Saving starts now, with the kept tab in it.
    await vi.advanceTimersByTimeAsync(1000);
    expect(saves().map((x) => x.tabs.map((t) => t.id))).toEqual([['a', 'b', temporary]]);
  });

  it('reading_gives_up_after_3_retries', async () => {
    vi.useFakeTimers();
    host(new BridgeError('failed', 'Access denied.'));
    const sticky = vi.fn();
    stop = startSessionSync(undefined, sticky);
    await vi.advanceTimersByTimeAsync(0);
    expect(useTabs.getState().tabs).toHaveLength(1);

    // Not while retries are left: the 3rd retry is the last, and only its failure gives up.
    await vi.advanceTimersByTimeAsync(3 * 5000 - 1);
    expect(sticky).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(sticky).toHaveBeenCalledExactlyOnceWith('Your session couldn’t be read; changes in this window won’t be saved.');

    await vi.advanceTimersByTimeAsync(60_000);
    useTabs.getState().setText(useTabs.getState().tabs[0]!.id, 'users');
    await vi.advanceTimersByTimeAsync(60_000);

    expect(bridge.call.mock.calls.filter((c) => c[0] === 'session.get')).toHaveLength(4);
    expect(saves()).toEqual([]);
  });

  it('one_save_is_in_flight_and_later_changes_follow_it_as_one', async () => {
    vi.useFakeTimers();
    const answers: ((a: { dropped: number }) => void)[] = [];
    bridge.call.mockImplementation((method: string) =>
      method === 'session.get'
        ? Promise.resolve({ session: saved, corrupt: false })
        : new Promise((resolve) => answers.push(resolve)),
    );
    stop = startSessionSync();
    await vi.waitFor(() => expect(useTabs.getState().tabs).toHaveLength(2));

    useTabs.getState().setTitle('a', 'One');
    await vi.advanceTimersByTimeAsync(1000);
    expect(saves()).toHaveLength(1);

    useTabs.getState().setTitle('a', 'Two');
    await vi.advanceTimersByTimeAsync(1000);
    useTabs.getState().setTitle('a', 'Three');
    window.dispatchEvent(new Event('pagehide'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(saves()).toHaveLength(1);

    answers[0]!({ dropped: 0 });
    await vi.advanceTimersByTimeAsync(0);
    expect(saves().map((x) => x.tabs[0]?.title)).toEqual(['One', 'Three']);
    answers[1]!({ dropped: 0 });
    await vi.advanceTimersByTimeAsync(5000);
    expect(saves()).toHaveLength(2);
  });

  it('a_failed_save_is_retried_without_a_new_change', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    bridge.call.mockImplementation((method: string) => {
      if (method === 'session.get') {
        return Promise.resolve({ session: saved, corrupt: false });
      }
      return ++attempts === 1 ? Promise.reject(new BridgeError('failed', 'The disk is full.')) : Promise.resolve({ dropped: 0 });
    });
    const notify = vi.fn();
    stop = startSessionSync(notify);
    await vi.waitFor(() => expect(useTabs.getState().tabs).toHaveLength(2));

    useTabs.getState().setTitle('a', 'Kept');
    await vi.advanceTimersByTimeAsync(1000);
    expect(notify).toHaveBeenCalledWith('The open tabs couldn’t be saved: The disk is full.');
    await vi.advanceTimersByTimeAsync(4999);
    expect(saves()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(saves().map((x) => x.tabs[0]?.title)).toEqual(['Kept', 'Kept']);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(saves()).toHaveLength(2);
  });

  it('dropped_tabs_are_reported', async () => {
    bridge.call.mockImplementation((method: string) =>
      Promise.resolve(method === 'session.get' ? { session: saved, corrupt: false } : { dropped: 2 }),
    );
    const notify = vi.fn();
    stop = startSessionSync(notify);
    await vi.waitFor(() => expect(useTabs.getState().tabs).toHaveLength(2));

    useTabs.getState().setTitle('a', 'Big');
    window.dispatchEvent(new Event('pagehide'));

    await vi.waitFor(() => expect(notify).toHaveBeenCalledWith('2 tabs were too large to keep for the next start.'));
  });

  it('a_corrupt_session_file_is_reported', async () => {
    host({ session: { version: 1, activeId: null, tabs: [] }, corrupt: true });
    const notify = vi.fn();
    stop = startSessionSync(notify);

    await vi.waitFor(() => expect(notify).toHaveBeenCalledWith('The session file couldn’t be read, so it was set aside. Kustodian started with an empty tab.'));
    expect(useTabs.getState().tabs).toHaveLength(1);
  });

  it('session_sync_saves_a_changed_source', async () => {
    vi.useFakeTimers();
    host({ session: saved, corrupt: false });
    stop = startSessionSync();
    await vi.waitFor(() => expect(useTabs.getState().tabs).toHaveLength(2));

    useTabs.getState().setSource('b', 'hunting');
    await vi.advanceTimersByTimeAsync(1000);

    expect(saves().at(-1)?.tabs.map((t) => [t.id, t.source])).toEqual([
      ['a', 'graph'],
      ['b', 'hunting'],
    ]);
  });

  it('session_restore_keeps_each_tab_source', async () => {
    host({ session: { ...saved, tabs: [{ ...saved.tabs[0]!, source: 'arg' }, { ...saved.tabs[1]!, source: 'hunting' }] }, corrupt: false });
    stop = startSessionSync();
    await vi.waitFor(() => expect(useTabs.getState().tabs.map((t) => t.source)).toEqual(['arg', 'hunting']));
  });
});
