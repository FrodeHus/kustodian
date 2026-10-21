import { call } from '../bridge';
import { useTabs } from '../tabs/tab-store';
import type { Session, SessionAnswer } from '../wire';

/** How long after the last change the session is written (spec 6.1: about a second). */
export const SAVE_DELAY_MS = 1000;

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** What `session.json` keeps of the open tabs: never runs or results. */
function snapshot(): Session {
  const { tabs, activeId } = useTabs.getState();
  return {
    version: 1,
    activeId,
    tabs: tabs.map((t) => ({
      id: t.id,
      source: t.source,
      title: t.title,
      text: t.text,
      dirty: t.dirty,
      savedId: t.savedId ?? null,
      parameters: t.parameters,
      filePath: t.filePath ?? null,
    })),
  };
}

/**
 * Restores the last session's tabs, unsaved text included (spec 6.1), or opens one empty Graph tab when there is none, and
 * then writes the session {@link SAVE_DELAY_MS} after each change to the tabs and at once when the page goes away. Returns the
 * function that stops it. `notify` is told when the session couldn't be read, or tabs were too big to keep.
 */
export function startSessionSync(notify?: (message: string) => void): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let unsubscribe: (() => void) | undefined;
  // The session as last sent; a change that leaves it the same (a run, a cursor move) isn't written.
  let written = '';

  const save = () => {
    clearTimeout(timer);
    timer = undefined;
    const session = snapshot();
    const json = JSON.stringify(session);
    if (json === written) {
      return;
    }
    written = json;
    call<{ dropped: number } | null>('session.save', { session }).then(
      (answer) => {
        if (answer && answer.dropped > 0) {
          notify?.(`${answer.dropped === 1 ? 'A tab was' : `${answer.dropped} tabs were`} too large to keep for the next start.`);
        }
      },
      (e: unknown) => {
        written = '';
        notify?.(`The open tabs couldn’t be saved: ${errorText(e)}`);
      },
    );
  };

  const onPageHide = () => {
    if (unsubscribe) {
      save();
    }
  };

  const begin = (answer: SessionAnswer | null) => {
    if (stopped) {
      return;
    }
    const session = answer?.session;
    if (session && session.tabs.length > 0) {
      useTabs.getState().restore(session);
    } else if (useTabs.getState().tabs.length === 0) {
      useTabs.getState().open('graph');
    }
    if (answer?.corrupt) {
      notify?.('The session file couldn’t be read, so it was set aside. Kustodian started with an empty tab.');
    }
    // What was just restored is what the file has; only later changes are written.
    written = JSON.stringify(snapshot());
    unsubscribe = useTabs.subscribe((state, previous) => {
      if (state.tabs !== previous.tabs || state.activeId !== previous.activeId) {
        clearTimeout(timer);
        timer = setTimeout(save, SAVE_DELAY_MS);
      }
    });
  };

  // Nothing is written before the session was read, so a slow read can't be overwritten by an empty window.
  call<SessionAnswer>('session.get').then(begin, (e: unknown) => {
    if (!stopped) {
      notify?.(`The last session couldn’t be restored: ${errorText(e)}`);
    }
    begin(null);
  });
  window.addEventListener('pagehide', onPageHide);

  return () => {
    stopped = true;
    if (timer !== undefined) {
      save();
    }
    unsubscribe?.();
    unsubscribe = undefined;
    window.removeEventListener('pagehide', onPageHide);
  };
}
