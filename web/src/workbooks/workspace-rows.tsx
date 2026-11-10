import { shortId } from '../toolbar/short-id';
import type { ArmWorkspacesAnswer, QueryWorkspace } from '../wire';

/**
 * The workspaces a workbook queries, as the import review lists them: Save or Open confirms them. A file's workspace name is
 * its author's text, so each row is matched by id against the account's own list and shows the account's name; one the account
 * can't see shows the file's name with that said, and while the list loads or can't be read, that it wasn't checked.
 */
export function WorkspaceRows({ found, mine }: { found: { workspace: QueryWorkspace; widgets: number }[]; mine: ArmWorkspacesAnswer['workspaces'] | null | undefined }) {
  const any = found.length > 0;

  return (
    any && (
      <section className="flex flex-col gap-1.5">
        <b className="text-[12.5px]">{`This workbook queries ${found.length} ${found.length === 1 ? 'workspace' : 'workspaces'}`}</b>
        {found.map(({ workspace, widgets }) => {
          const id = workspace.customerId.toLowerCase();
          const account = mine?.find((w) => w.customerId.toLowerCase() === id);
          return (
            <span key={workspace.customerId} className="flex min-h-7 items-center gap-2">
              <span className="truncate">{account?.name ?? workspace.name}</span>
              <span className="mono shrink-0 text-[11px] text-faint">{shortId(workspace.customerId)}</span>
              {!mine ? (
                <span className="shrink-0 text-faint">· not checked</span>
              ) : (
                !account && <span className="shrink-0 text-bad">· not available to this account</span>
              )}
              <span className="ml-auto shrink-0 text-[11px] text-faint">{`${widgets} ${widgets === 1 ? 'widget' : 'widgets'}`}</span>
            </span>
          );
        })}
      </section>
    )
  );
}
