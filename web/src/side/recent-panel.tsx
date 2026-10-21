import { useEffect, useState } from 'react';
import { call } from '../bridge';
import { openRecent, runTitle } from '../library/open-library';
import { errorText } from '../shell/errors';
import { SourceBadge } from '../tabs/source-badge';
import { useTabs } from '../tabs/tab-store';
import type { RecentRun, Source } from '../wire';
import { PanelHeading } from './panel-heading';

const OUTCOMES: Record<string, string> = {
  ok: 'OK',
  queryError: 'Query error',
  refused: 'Refused',
  noPermission: 'No permission',
  throttled: 'Throttled',
  tooLarge: 'Too large',
  engineTimeout: 'Timed out',
  engineMemory: 'Out of memory',
  signInNeeded: 'Sign-in needed',
  consentNeeded: 'Azure access needed',
  failed: 'Failed',
};

function when(iso: string, now = Date.now()): string {
  const at = new Date(iso);
  const minutes = Math.floor((now - at.getTime()) / 60000);
  if (Number.isNaN(minutes)) {
    return iso;
  }
  if (minutes < 1) {
    return 'just now';
  }
  if (minutes < 60) {
    return `${minutes} min ago`;
  }
  return at.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/** The Recent panel (spec 6.6): the last runs, newest first, each with its outcome, rows and when. It lists the runs of the active
 * tab's `source` (spec 6.1), or every source's with "All sources". A run opens in a new tab with its parameter values and its
 * timespan or scope ({@link openRecent}). Read again whenever a run ends. */
export function RecentPanel({ source = 'graph' }: { source?: Source }) {
  const [runs, setRuns] = useState<RecentRun[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [cleared, setCleared] = useState(0);
  const [all, setAll] = useState(false);
  // Changes when any tab's run ends: the host has added it to Recent by then.
  const ended = useTabs((s) =>
    s.tabs
      .map((t) => (t.run?.state === 'done' ? t.run.runId : ''))
      .filter(Boolean)
      .join(','),
  );

  useEffect(() => {
    let live = true;
    call<{ runs: RecentRun[] }>('recent.list').then(
      (r) => live && setRuns(r.runs),
      (e: unknown) => live && setProblem(`Recent runs couldn’t be read: ${errorText(e)}`),
    );
    return () => {
      live = false;
    };
  }, [ended, cleared]);

  const shown = runs?.filter((r) => all || r.source === source);

  const clear = () =>
    call('recent.clear').then(
      () => {
        setProblem(null);
        setCleared((n) => n + 1);
      },
      (e: unknown) => setProblem(`Recent runs couldn’t be cleared: ${errorText(e)}`),
    );

  return (
    <aside className="side" aria-label="Recent">
      <PanelHeading title="Recent" source={source} all={all} onAll={setAll} />
      <div className="min-h-0 flex-1 overflow-y-auto pb-3">
        {problem && (
          <p role="alert" className="m-0 px-[14px] pb-2 text-[12px] text-bad">
            {problem}
          </p>
        )}
        {shown?.length === 0 && <p className="faint m-0 px-[14px] text-[12px]">{runs?.length ? 'No runs of this source yet.' : 'No runs yet.'}</p>}
        <ul className="side-list">
          {shown?.map((run) => {
            const title = runTitle(run.text);
            const at = when(run.startedAt);
            return (
              <li key={run.id} className="side-item">
                <button type="button" className="side-open flex-col !items-start" aria-label={`Open the run “${title}” from ${at}`} title={run.text} onClick={() => openRecent(run)}>
                  <span className="flex w-full min-w-0 items-center gap-1.5">
                    {all && <SourceBadge source={run.source} titled />}
                    <span className="mono truncate">{title}</span>
                  </span>
                  <span className="faint flex gap-2 text-[11px]">
                    <span className={run.outcome === 'ok' ? 'text-ok' : 'text-bad'}>{OUTCOMES[run.outcome] ?? run.outcome}</span>
                    {run.outcome === 'ok' && <span>{run.rows === 1 ? '1 row' : `${run.rows.toLocaleString('en-US')} rows`}</span>}
                    <span>{at}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
      <div className="side-foot">
        <button type="button" className="btn w-full justify-center" disabled={!runs || runs.length === 0} onClick={() => void clear()}>
          Clear recent
        </button>
      </div>
    </aside>
  );
}
