import { call } from '../bridge';
import { sendableHeaders } from '../raw/raw-request';
import { errorText } from '../shell/errors';
import { useTabs } from '../tabs/tab-store';
import type { Session, SessionAnswer } from '../wire';

/** How long after the last change the session is written (spec 6.1: about a second). */
export const SAVE_DELAY_MS = 1000;
/** How long before an unreadable session is read again, or a failed save is tried again. */
export const RETRY_MS = 5000;
/** How many times an unreadable session is read again before giving up. */
export const READ_RETRIES = 3;

export const UNREADABLE_MESSAGE = 'Couldn’t read your last session; changes won’t be saved until it can be read.';

/** What `session.json` keeps of the open tabs: never runs or results, and of a raw tab's headers only those it could send (the
 * host drops the others too), so a typed `Authorization` header never reaches the file. */
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
      ...(t.raw ? { raw: { version: t.raw.version, headers: sendableHeaders(t.raw.headers) } } : {}),
    })),
  };
}

/**
 * Restores the last session's tabs, unsaved text included (spec 6.1), or opens one empty Graph tab when there is none, and
 * then writes the session {@link SAVE_DELAY_MS} after each change to the tabs and at once when the page goes away. Returns the
 * function that stops it. `notify` is told when the session couldn't be read, couldn't be saved, or tabs were too big to keep.
 *
 * - A session that can't be read (an I/O error, a lock; not a corrupt file, which the host has already moved aside) is never
 *   overwritten: nothing is saved while it is unreadable. It is read again every {@link RETRY_MS}, up to {@link READ_RETRIES}
 *   times; when a retry reads it, it is restored, with any tab typed into meanwhile kept after it.
 * - One `session.save` is in flight at a time; changes while it is out are written by one save after it answers.
 * - A save that fails is tried again after {@link RETRY_MS}, without waiting for another change.
 */
export function startSessionSync(notify?: (message: string) => void): () => void {
  let stopped = false;
  let syncing = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let readTimer: ReturnType<typeof setTimeout> | undefined;
  let unsubscribe: (() => void) | undefined;
  // The session as the host last stored it; a change that leaves it the same (a run, a cursor move) isn't written.
  let written = '';
  let inFlight = false;
  let again = false;
  let failing = false;

  const schedule = (ms: number) => {
    clearTimeout(timer);
    timer = setTimeout(save, ms);
  };

  function save() {
    clearTimeout(timer);
    timer = undefined;
    if (inFlight) {
      again = true;
      return;
    }
    const session = snapshot();
    const json = JSON.stringify(session);
    if (json === written) {
      return;
    }
    inFlight = true;
    call<{ dropped: number } | null>('session.save', { session })
      .then(
        (answer) => {
          written = json;
          failing = false;
          if (answer && answer.dropped > 0) {
            notify?.(`${answer.dropped === 1 ? 'A tab was' : `${answer.dropped} tabs were`} too large to keep for the next start.`);
          }
        },
        (e: unknown) => {
          if (!failing) {
            notify?.(`The open tabs couldn’t be saved: ${errorText(e)}`);
          }
          failing = true;
          if (!stopped && !again) {
            schedule(RETRY_MS);
          }
        },
      )
      .finally(() => {
        inFlight = false;
        if (again) {
          again = false;
          save();
        }
      });
  }

  const onPageHide = () => {
    if (syncing) {
      save();
    }
  };

  /** Starts saving: what the host has is `stored`; later changes are written. */
  const beginSaving = (stored: string) => {
    syncing = true;
    written = stored;
    unsubscribe = useTabs.subscribe((state, previous) => {
      if (state.tabs !== previous.tabs || state.activeId !== previous.activeId) {
        schedule(SAVE_DELAY_MS);
      }
    });
    if (JSON.stringify(snapshot()) !== stored) {
      schedule(SAVE_DELAY_MS);
    }
  };

  const ensureTab = () => {
    if (useTabs.getState().tabs.length === 0) {
      useTabs.getState().open('graph');
    }
  };

  /** The first read worked. */
  const begin = (answer: SessionAnswer | null) => {
    const session = answer?.session;
    if (session && session.tabs.length > 0) {
      useTabs.getState().restore(session);
    } else {
      ensureTab();
    }
    if (answer?.corrupt) {
      notify?.('The session file couldn’t be read, so it was set aside. Kustodian started with an empty tab.');
    }
    // What was just restored is what the file has (an empty or set-aside session is fine to replace).
    beginSaving(session && session.tabs.length > 0 ? JSON.stringify(snapshot()) : '');
  };

  /** A retry read the session after the window had started without it: it comes back, and tabs used meanwhile stay. */
  const recover = (answer: SessionAnswer | null) => {
    const session = answer?.session;
    if (!session || session.tabs.length === 0) {
      beginSaving('');
      return;
    }
    const stored = JSON.stringify(session);
    const meanwhile = snapshot().tabs.filter((t) => t.dirty || t.text !== '');
    const keepActive = meanwhile.some((t) => t.id === useTabs.getState().activeId);
    useTabs.getState().restore({
      ...session,
      tabs: [...session.tabs, ...meanwhile],
      activeId: keepActive ? useTabs.getState().activeId : session.activeId,
    });
    beginSaving(stored);
  };

  const read = (attempt: number) => {
    call<SessionAnswer>('session.get').then(
      (answer) => {
        if (!stopped) {
          (attempt === 0 ? begin : recover)(answer);
        }
      },
      () => {
        if (stopped) {
          return;
        }
        if (attempt === 0) {
          ensureTab();
          notify?.(UNREADABLE_MESSAGE);
        }
        if (attempt < READ_RETRIES) {
          readTimer = setTimeout(() => read(attempt + 1), RETRY_MS);
        }
      },
    );
  };

  // Nothing is written before the session was read, so a slow or failed read can't be overwritten by an empty window.
  read(0);
  window.addEventListener('pagehide', onPageHide);

  return () => {
    stopped = true;
    clearTimeout(readTimer);
    if (syncing && timer !== undefined) {
      save();
    }
    clearTimeout(timer);
    timer = undefined;
    unsubscribe?.();
    unsubscribe = undefined;
    window.removeEventListener('pagehide', onPageHide);
  };
}
