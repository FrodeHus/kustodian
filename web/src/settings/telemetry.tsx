import { useId, useState } from 'react';
import { errorText } from '../shell/errors';
import type { SettingsAnswer } from '../wire';
import { openTelemetryDocs, setTelemetry } from './settings-writes';

/** What sharing gives and what it sends, as the first-run dialog and Settings both say it. */
export function TelemetryExplainer() {
  return (
    <>
      <span className="text-[12.5px]">
        Some Graph tables refuse parts of a query, such as <span className="mono">$top=999</span> or <span className="mono">$count</span>, and
        Kustodian has to probe and try again. Shared findings can be built into Kustodian, so queries on those tables skip the probing and run
        faster for everyone.
      </span>
      <span className="muted text-[12px]">
        Sent: the table’s path (such as <span className="mono">auditLogs/signIns</span>), what Graph refused, and the app version. Never your
        tenant, account, queries, filter values or results.{' '}
        <button type="button" className="text-accent underline" onClick={openTelemetryDocs}>
          What is sent, in detail
        </button>
      </span>
    </>
  );
}

/**
 * Asked once, at the first start after sharing came in: whether to share Graph compatibility findings. Nothing is shared until
 * the user says yes; either answer is kept and can be changed in Settings. Esc or the scrim closes it unanswered, so it asks again
 * at the next start.
 */
export function TelemetryDialog({ onClose }: { onClose: (answer?: SettingsAnswer) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();

  const answer = (on: boolean) => {
    setBusy(true);
    setError(null);
    setTelemetry(on).then(onClose, (e: unknown) => {
      setBusy(false);
      setError(`The choice couldn’t be saved: ${errorText(e)}`);
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
          Help improve Kustodian’s Graph support?
        </b>
        <TelemetryExplainer />
        <span className="faint text-[12px]">Nothing is shared unless you choose to. You can change this any time in Settings.</span>
        {error && (
          <span className="text-[12px] text-bad" role="alert">
            {error}
          </span>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn" disabled={busy} autoFocus onClick={() => answer(false)}>
            Don’t share
          </button>
          <button type="button" className="btn" disabled={busy} onClick={() => answer(true)}>
            Share findings
          </button>
        </div>
      </div>
    </div>
  );
}
