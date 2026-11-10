import { useState } from 'react';
import { BridgeError, call } from '../bridge';
import { useSchemas } from '../schema/schema-store';
import { ErrorReportActions, type Shown } from '../shell/error-report';
import { errorText } from '../shell/errors';
import { reportIdOf } from '../shell/report-id';
import type { AccessFix } from './access-fixes';

/**
 * The workbook toolbar's "Refresh access", shown while a widget failed for want of access: grants each consent and gets each new
 * token the failed widgets need (`accessFixes`), one after another, then `onDone` refreshes the workbook. The user cancelling one
 * stops there and says nothing; any other failure is shown next to the button.
 */
export function AccessButton({
  accountKey,
  fixes,
  onDone,
}: {
  accountKey: string | null | undefined;
  fixes: AccessFix[];
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Shown | null>(null);
  if (fixes.length === 0) {
    return null;
  }

  const fix = async () => {
    if (!accountKey) {
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      for (const f of fixes) {
        await call(f.kind === 'consent' ? 'account.consent' : 'account.refresh', { key: accountKey, audience: f.audience });
        if (f.kind === 'consent' && f.audience === 'arm') {
          void useSchemas.getState().reloadResourceTypes();
        } else if (f.kind === 'consent') {
          useSchemas.getState().reloadLogs();
        }
      }
      onDone();
    } catch (e) {
      if (!(e instanceof BridgeError && e.code === 'cancelled')) {
        setProblem({ text: errorText(e), reportId: reportIdOf(e) });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {problem && (
        <span role="alert" className="min-w-0 truncate text-[12px] text-bad">
          {problem.text}
          <ErrorReportActions reportId={problem.reportId} uiSections={{ message: problem.text }} />
        </span>
      )}
      <button
        type="button"
        className="btn primary shrink-0"
        title="Some widgets lack access: grant it or get a new access token, then refresh the workbook"
        disabled={busy || !accountKey}
        onClick={() => void fix()}
      >
        Refresh access
      </button>
    </>
  );
}
