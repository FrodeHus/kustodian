import { useState } from 'react';
import { BridgeError, call } from '../bridge';
import { useSchemas } from '../schema/schema-store';
import { errorText } from '../shell/errors';
import { ErrorReportActions, type Shown } from '../shell/error-report';
import { reportIdOf } from '../shell/report-id';

/**
 * "Grant Azure access": asks the host to have the user grant Azure access to the account (`account.consent {key, audience}`, "arm"
 * or "logs"). Once granted, the Resource Graph resource types are read again (the schema panel may have been refused them), and
 * `onGranted` runs the query again or reads the list again. The user cancelling says nothing; any other failure (granting as
 * another account, for one) is shown next to the button.
 */
export function ConsentButton({
  accountKey,
  audience,
  onGranted,
}: {
  accountKey: string | undefined;
  /** Whose token needs consent: Azure Resource Manager's, or Log Analytics'. */
  audience: 'arm' | 'logs';
  onGranted?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Shown | null>(null);

  const grant = () => {
    if (!accountKey) {
      return;
    }
    setBusy(true);
    setProblem(null);
    call('account.consent', { key: accountKey, audience }).then(
      () => {
        setBusy(false);
        if (audience === 'arm') {
          void useSchemas.getState().reloadResourceTypes();
        }
        onGranted?.();
      },
      (e: unknown) => {
        setBusy(false);
        if (!(e instanceof BridgeError && e.code === 'cancelled')) {
          setProblem({ text: errorText(e), reportId: reportIdOf(e) });
        }
      },
    );
  };

  return (
    <>
      <button type="button" className="btn primary shrink-0" disabled={busy || !accountKey} onClick={grant}>
        {audience === 'logs' ? 'Grant Log Analytics access' : 'Grant Azure access'}
      </button>
      {problem && (
        <span role="alert" className="min-w-0 text-[12px] text-bad">
          {problem.text}
          <ErrorReportActions reportId={problem.reportId} uiSections={{ message: problem.text }} />
        </span>
      )}
    </>
  );
}
