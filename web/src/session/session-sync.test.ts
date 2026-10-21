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

    // An unreadable session also starts with one empty Graph tab, and says so.
    useTabs.setState({ tabs: [], activeId: null, cursors: {} });
    host(new BridgeError('failed', 'The disk is gone.'));
    const notify = vi.fn();
    stop = startSessionSync(notify);
    await vi.waitFor(() => expect(useTabs.getState().tabs).toHaveLength(1));
    expect(notify).toHaveBeenCalledWith('The last session couldn’t be restored: The disk is gone.');
  });

  it('a_corrupt_session_file_is_reported', async () => {
    host({ session: { version: 1, activeId: null, tabs: [] }, corrupt: true });
    const notify = vi.fn();
    stop = startSessionSync(notify);

    await vi.waitFor(() => expect(notify).toHaveBeenCalledWith('The session file couldn’t be read, so it was set aside. Kustodian started with an empty tab.'));
    expect(useTabs.getState().tabs).toHaveLength(1);
  });
});
