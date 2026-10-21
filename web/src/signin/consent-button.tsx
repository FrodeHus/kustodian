import { useState } from 'react';
import { BridgeError, call } from '../bridge';
import { errorText } from '../shell/errors';

/**
 * "Grant Azure access": asks the host to have the user grant Azure access to the account (`account.consent {key, audience:
 * "arm"}`), then `onGranted` runs the query again or reads the list again. The user cancelling says nothing; any other failure
 * (granting as another account, for one) is shown next to the button.
 */
export function ConsentButton({ accountKey, onGranted }: { accountKey: string | undefined; onGranted: () => void }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const grant = () => {
    if (!accountKey) {
      return;
    }
    setBusy(true);
    setProblem(null);
    call('account.consent', { key: accountKey, audience: 'arm' }).then(
      () => {
        setBusy(false);
        onGranted();
      },
      (e: unknown) => {
        setBusy(false);
        if (!(e instanceof BridgeError && e.code === 'cancelled')) {
          setProblem(errorText(e));
        }
      },
    );
  };

  return (
    <>
      <button type="button" className="btn primary shrink-0" disabled={busy || !accountKey} onClick={grant}>
        Grant Azure access
      </button>
      {problem && (
        <span role="alert" className="min-w-0 text-[12px] text-bad">
          {problem}
        </span>
      )}
    </>
  );
}
