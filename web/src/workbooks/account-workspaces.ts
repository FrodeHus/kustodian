import { useEffect, useState } from 'react';
import { call } from '../bridge';
import type { ArmWorkspacesAnswer } from '../wire';

/** The account's own workspace list while `wanted`: undefined while it is read, null when it can't be. */
export function useAccountWorkspaces(wanted: boolean): ArmWorkspacesAnswer['workspaces'] | null | undefined {
  const [mine, setMine] = useState<ArmWorkspacesAnswer['workspaces'] | null | undefined>(undefined);
  useEffect(() => {
    if (!wanted) {
      return;
    }
    let live = true;
    call<ArmWorkspacesAnswer>('arm.workspaces').then(
      (a) => live && setMine(a.workspaces),
      () => live && setMine(null),
    );
    return () => {
      live = false;
    };
  }, [wanted]);
  return mine;
}
