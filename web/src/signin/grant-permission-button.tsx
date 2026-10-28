import { useState } from 'react';
import { call } from '../bridge';

/**
 * "Grant permission…": asks the host to have the user consent to one Graph permission for the account (`account.consent {key,
 * audience: "graph", scope}`). Once granted, `onGranted` runs the query again. The user cancelling, or any other refusal (an
 * administrator has to grant it), is shown next to the button.
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
      () => {
        setBusy(false);
        setProblem(`Not granted. An administrator has to grant ${scope}.`);
      },
    );
  };

  return (
    <>
      <button type="button" className="btn shrink-0" title={scope} disabled={busy || !accountKey} onClick={grant}>
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
