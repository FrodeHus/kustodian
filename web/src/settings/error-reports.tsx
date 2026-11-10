import { useId, useState } from 'react';
import { errorText } from '../shell/errors';
import { ErrorReportActions, type Shown } from '../shell/error-report';
import { reportIdOf } from '../shell/report-id';
import type { SettingsAnswer } from '../wire';
import { openTelemetryDocs, setErrorReports } from './settings-writes';

/** What an automatic error report sends and what it never does, as the first-run dialog and Settings both say it. */
export function ErrorReportsExplainer() {
  return (
    <>
      <span className="text-[12.5px]">
        When Kustodian fails in a way it shouldn’t, it can send a short report to its developer, so the bug can be found and fixed. Each
        report has an ID you can quote.
      </span>
      <span className="muted text-[12px]">
        Sent: error types and where in Kustodian’s code they happened, the recent steps before it as codes, the app version and OS. Never
        your tenant, account, queries, values, results or error messages.{' '}
        <button type="button" className="text-accent underline" onClick={openTelemetryDocs}>
          What is sent, in detail
        </button>
      </span>
    </>
  );
}

/**
 * Asked once, after the Graph findings question: whether to send error reports. Nothing is sent until the user says yes; either
 * answer is kept and can be changed in Settings. Esc or the scrim closes it unanswered, so it asks again at the next start.
 */
export function ErrorReportsDialog({ onClose }: { onClose: (answer?: SettingsAnswer) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Shown | null>(null);
  const id = useId();

  const answer = (on: boolean) => {
    setBusy(true);
    setError(null);
    setErrorReports(on).then(onClose, (e: unknown) => {
      setBusy(false);
      setError({ text: `The choice couldn’t be saved: ${errorText(e)}`, reportId: reportIdOf(e) });
    });
  };

  return (
    <div className="fixed inset-0 z-30">
      <div className="scrim" onClick={() => onClose()} />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        className="card absolute top-1/4 left-1/2 flex w-[480px] max-w-[calc(100vw-32px)] -translate-x-1/2 flex-col gap-3.5 p-5"
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            onClose();
          }
        }}
      >
        <b id={`${id}-title`} className="text-[14px]">
          Send error reports?
        </b>
        <ErrorReportsExplainer />
        <span className="faint text-[12px]">Nothing is sent unless you choose to. You can change this any time in Settings.</span>
        {error && (
          <span className="text-[12px] text-bad" role="alert">
            {error.text}
            <ErrorReportActions reportId={error.reportId} uiSections={{ message: error.text }} />
          </span>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn" disabled={busy} autoFocus onClick={() => answer(false)}>
            No
          </button>
          <button type="button" className="btn" disabled={busy} onClick={() => answer(true)}>
            Yes
          </button>
        </div>
      </div>
    </div>
  );
}
