import { useEffect, useState } from 'react';
import { useGraphSchemaUpdate } from '../schema/graph-schema-update';
import { errorText } from '../shell/errors';
import { ErrorReportActions } from '../shell/error-report';
import { reportIdOf } from '../shell/report-id';

const when = (iso: string) => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
};

/** Settings' Graph schema card: the schema in use, a newer one waiting for a restart, and "Refresh now", which downloads the
 * published schema again even when it is the one in use. */
export function GraphSchemaSettings() {
  const status = useGraphSchemaUpdate((s) => s.status);
  const checking = useGraphSchemaUpdate((s) => s.checking);
  const [result, setResult] = useState<{ tone: 'ok' | 'bad'; text: string; reportId?: string } | null>(null);

  useEffect(() => void useGraphSchemaUpdate.getState().load().catch(() => undefined), []);

  const refresh = () =>
    useGraphSchemaUpdate
      .getState()
      .check(true)
      .then(
        (s) => setResult({ tone: 'ok', text: s.pending ? 'Downloaded.' : 'The schema in use is the latest.' }),
        (e: unknown) => setResult({ tone: 'bad', text: `Couldn’t refresh the Graph schema: ${errorText(e)}`, reportId: reportIdOf(e) }),
      );

  return (
    <>
      {status ? (
        <dl className="m-0 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-[12.5px]">
          <dt className="text-muted">In use</dt>
          <dd className="m-0">
            {status.downloaded ? 'Downloaded' : 'Built in'}, generated {when(status.generatedAt)}
          </dd>
          <dt className="text-muted">Source</dt>
          <dd className="m-0 break-all font-mono text-[11.5px]">{status.source}</dd>
          <dt className="text-muted">Last checked</dt>
          <dd className="m-0">{status.checkedAt ? when(status.checkedAt) : 'Not this session'}</dd>
        </dl>
      ) : (
        <span className="faint text-[12px]">Reading the schema status…</span>
      )}
      {status?.pending && (
        <span className="chip warn self-start" role="status">
          A newer Graph schema ({when(status.pending)}) is downloaded. Restart Kustodian to use it.
        </span>
      )}
      <div className="flex items-center gap-3">
        <button type="button" className="btn" disabled={checking} onClick={() => void refresh()}>
          {checking ? 'Refreshing…' : 'Refresh now'}
        </button>
        {result && (
          <span className={`text-[12px] ${result.tone === 'bad' ? 'text-bad' : 'text-muted'}`} role={result.tone === 'bad' ? 'alert' : 'status'}>
            {result.text}
            {result.tone === 'bad' && <ErrorReportActions reportId={result.reportId} uiSections={{ message: result.text }} />}
          </span>
        )}
      </div>
      <span className="faint text-[12px]">
        Kustodian checks GitHub for a newer schema when it starts. Refresh now downloads the published schema again, even when it is the
        one in use.
      </span>
    </>
  );
}
