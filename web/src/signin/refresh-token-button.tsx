import { useState } from 'react';
import { BridgeError, call } from '../bridge';
import { errorText } from '../shell/errors';

/**
 * "Refresh access": asks the host for a new token for the account (`account.refresh {key, audience}`), past the cached one, so a
 * role activated since the last token (through PIM, say) counts. The host signs in through the browser when the refresh can't do it
 * alone. Once refreshed, `onRefreshed` runs the query again. The user cancelling says nothing; any other failure is shown next to
 * the button.
 */
export function RefreshTokenButton({
  accountKey,
  audience,
  onRefreshed,
}: {
  accountKey: string | undefined;
  audience: 'graph' | 'arm';
  onRefreshed?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const refresh = () => {
    if (!accountKey) {
      return;
    }
    setBusy(true);
    setProblem(null);
    call('account.refresh', { key: accountKey, audience }).then(
      () => {
        setBusy(false);
        onRefreshed?.();
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
      <button
        type="button"
        className="btn ghost shrink-0"
        title="Get a new access token, so a role activated since (through PIM, say) counts"
        disabled={busy || !accountKey}
        onClick={refresh}
      >
        Refresh access
      </button>
      {problem && (
        <span role="alert" className="min-w-0 text-[12px] text-bad">
          {problem}
        </span>
      )}
    </>
  );
}
