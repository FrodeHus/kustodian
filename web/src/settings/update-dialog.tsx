import { useId, useState } from 'react';
import { call } from '../bridge';
import { errorText } from '../shell/errors';
import { ErrorReportActions, type Shown } from '../shell/error-report';
import { reportIdOf } from '../shell/report-id';
import type { UpdateInfo } from '../wire';
import { writeSettings } from './settings-writes';

/**
 * A newer release is out: "Update" opens its GitHub page, "Remind me later" closes (it asks again next start) and "Skip this
 * version" keeps it from asking again until a newer one is out.
 */
export function UpdateDialog({ info, onClose }: { info: UpdateInfo; onClose: () => void }) {
  const [error, setError] = useState<Shown | null>(null);
  const id = useId();

  const attempt = (action: () => Promise<unknown>) =>
    action().then(onClose, (e: unknown) => setError({ text: errorText(e), reportId: reportIdOf(e) }));

  return (
    <div className="fixed inset-0 z-20">
      <div className="scrim" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        className="card absolute top-1/4 left-1/2 flex w-[440px] max-w-[calc(100vw-32px)] -translate-x-1/2 flex-col gap-3.5 p-5"
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            onClose();
          }
        }}
      >
        <b id={`${id}-title`} className="text-[14px]">
          Kustodian {info.latest} is available
        </b>
        <span className="text-[12.5px]">You are running {info.current}.</span>
        {error && (
          <span role="alert" className="text-[12px] text-bad">
            {error.text}
            <ErrorReportActions reportId={error.reportId} uiSections={{ message: error.text }} />
          </span>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn ghost" onClick={() => void attempt(() => writeSettings((s) => ({ ...s, skippedVersion: info.latest })))}>
            Skip this version
          </button>
          <button type="button" className="btn" onClick={onClose}>
            Remind me later
          </button>
          <button type="button" className="btn primary" autoFocus onClick={() => void attempt(() => call('app.openRelease', { version: info.latest }))}>
            Update
          </button>
        </div>
      </div>
    </div>
  );
}
