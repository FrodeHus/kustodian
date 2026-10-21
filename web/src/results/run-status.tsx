import type { ReactNode } from 'react';
import { editorPosition, type TabRun } from '../tabs/tab-store';
import type { ArgScope, RunResult, Source, TableFetch } from '../wire';
import { plural, scopeText, serverRequests } from './source-wording';

const count = (n: number) => n.toLocaleString('en-US');

function stageLabel(stage: string | undefined, detail: string | undefined): string {
  switch (stage) {
    case 'fetching':
      return `Fetching ${detail ?? ''}`;
    case 'probing':
      return `Checking columns of ${detail ?? ''}`;
    case 'per-object':
      return `Reading one object at a time: ${detail ?? ''}`;
    default:
      return detail ?? 'Starting';
  }
}

function duration(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

interface Chip {
  text: string;
  tone?: 'ok' | 'warn' | 'bad';
  title?: string;
}

/** What each table's fetch did that the rows don't show (spec 6.5 run statistics, spec 7 warnings). */
function tableChips(tables: TableFetch[]): Chip[] {
  const chips: Chip[] = [];
  const requests = tables.flatMap((t) => t.requests);
  if (requests.length > 0) {
    chips.push({ text: plural(requests.length, 'Graph request'), title: requests.join('\n') });
  }
  const cached = tables.reduce((n, t) => n + t.perObjectCached, 0);
  if (cached > 0) {
    chips.push({ text: `${plural(cached, 'object')} from cache` });
  }
  for (const t of tables) {
    if (t.perObject.length > 0) {
      chips.push({ tone: 'warn', text: `${plural(t.perObject.length, 'column')} read one object at a time`, title: `${t.table}: ${t.perObject.join(', ')}` });
    }
    if (t.perObjectFailed > 0) {
      chips.push({ tone: 'warn', text: `${t.table}: ${plural(t.perObjectFailed, 'per-object read')} failed` });
    }
    if (t.perObjectCapped) {
      chips.push({ tone: 'warn', text: `${t.table}: too many objects to read one at a time, values empty` });
    }
    if (t.unfiltered) {
      chips.push({ tone: 'warn', text: `${t.table}: Graph refused the filter, filtered here instead` });
    }
    if (t.unreadable.length > 0) {
      chips.push({ tone: 'warn', text: `${t.unreadable.join(', ')}: Graph won't list, values empty` });
    }
    if (t.denied.length > 0) {
      chips.push({ tone: 'warn', text: `${t.denied.join(', ')}: no permission, values empty` });
    }
  }
  return chips;
}

/** What the run sent, in its source's words (Graph's requests are its tables'). */
function sourceChips(result: RunResult, source: Source, scope: ArgScope | null | undefined): Chip[] {
  if (source === 'hunting') {
    const queries = serverRequests(result);
    return queries > 0 ? [{ text: plural(queries, 'hunting query', 'hunting queries') }] : [];
  }
  if (source === 'arg') {
    const pages = serverRequests(result);
    return pages > 0 ? [{ text: `${plural(pages, 'page')} · ${scopeText(scope)}` }] : [];
  }
  return tableChips(result.tables);
}

function resultChips(result: RunResult, source: Source, scope: ArgScope | null | undefined): Chip[] {
  if (result.outcome !== 'ok') {
    return sourceChips(result, source, scope);
  }
  // More rows than were sent: how many there are, as "50,000 of 61,204 rows".
  const rows = result.total > result.rows.length ? `${count(result.rows.length)} of ${plural(result.total, 'row')}` : plural(result.total, 'row');
  const chips: Chip[] = [{ tone: 'ok', text: `● ${rows}` }];
  if (result.droppedValues > 0) {
    chips.push({ tone: 'warn', text: `${plural(result.droppedValues, 'value')} didn't fit the column's type, left empty` });
  }
  return [...chips, ...sourceChips(result, source, scope)];
}

interface RunStatusProps {
  run: TabRun | undefined;
  /** The Resource Graph scope the run had; none is "all I can see". */
  scope?: ArgScope | null;
  onSignIn: () => void;
}

/** The line between the editor and the results: the run's progress, then how it ended and what it sent, worded for the source
 * the run went to. */
export function RunStatus({ run, scope, onSignIn }: RunStatusProps) {
  let content: ReactNode;
  let meta: string | null = null;

  if (!run) {
    content = <span className="faint text-[12px]">No run yet</span>;
  } else if (run.state === 'running') {
    content = (
      <span className="chip" role="status">
        <span className="size-2 animate-pulse rounded-full bg-accent" aria-hidden="true" />
        {stageLabel(run.stage, run.detail)}
      </span>
    );
  } else if (run.cancelled || !run.result) {
    content = <span className="chip">Run cancelled</span>;
  } else {
    const result = run.result;
    const at = result.error ? editorPosition(run.origin, result.error) : null;
    meta = `${new Date(run.startedAt).toLocaleTimeString('en-GB')} · ${duration(result.durationMs)}`;
    content = (
      <>
        {result.outcome !== 'ok' && (
          <span className="flex min-w-0 items-center gap-2 text-bad" role="alert">
            <span className="min-w-0">{result.message ?? 'The query failed.'}</span>
            {at && (
              <span className="mono faint shrink-0 text-[11.5px]">
                Ln {at.line}, Col {at.column}
              </span>
            )}
          </span>
        )}
        {result.outcome === 'signInNeeded' && (
          <button type="button" className="btn primary shrink-0" onClick={onSignIn}>
            Sign in
          </button>
        )}
        {resultChips(result, run.source ?? 'graph', scope).map((chip, i) => (
          <span key={i} className={`chip${chip.tone ? ` ${chip.tone}` : ''}`} title={chip.title}>
            {chip.text}
          </span>
        ))}
      </>
    );
  }

  return (
    <div className="flex min-h-[41px] items-center gap-2 overflow-x-auto border-b border-line px-3 py-2">
      {content}
      <div className="grow" />
      {meta && <span className="mono faint shrink-0 text-[11.5px]">{meta}</span>}
    </div>
  );
}
