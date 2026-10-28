import { useState } from 'react';
import { BridgeError, call } from '../bridge';
import { errorText } from '../shell/errors';

/** Whether a failed consent means the permission wasn't granted: the user cancelled (or closed the browser), or Microsoft refused
 * it, which MSAL reports with an `AADSTS` code or `access_denied`. Anything else (another account picked, a bad request, the
 * network) is the host's own message. */
const notGranted = (e: unknown) =>
  e instanceof BridgeError && (e.code === 'cancelled' || (e.code === 'failed' && /\bAADSTS\d+|\baccess_denied\b/i.test(e.message)));

/**
 * "Grant permission…": asks the host to have the user consent to one Graph permission for the account (`account.consent {key,
 * audience: "graph", scope}`). Once granted, `onGranted` runs the query again. The user cancelling, or Microsoft refusing (an
 * administrator has to grant it), is shown next to the button as "Not granted"; any other failure as the host's message.
 */
export function GrantPermissionButton({ accountKey, scope, onGranted }: { accountKey: string | undefined; scope: string; onGranted?: () => void }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const grant = () => {
    if (!accountKey) {
      return;
    }
    setBusy(true);
    setProblem(null);
    call('account.consent', { key: accountKey, audience: 'graph', scope }).then(
      () => {
        setBusy(false);
        onGranted?.();
      },
      (e: unknown) => {
        setBusy(false);
        setProblem(notGranted(e) ? `Not granted. An administrator has to grant ${scope}.` : errorText(e));
      },
    );
  };

  return (
    <>
      <button type="button" className="btn shrink-0" title={scope} aria-label={`Grant permission ${scope}`} disabled={busy || !accountKey} onClick={grant}>
        Grant permission…
      </button>
      {problem && (
        <span role="alert" className="min-w-0 text-[12px] text-bad">
          {problem}
        </span>
      )}
    </>
  );
}
