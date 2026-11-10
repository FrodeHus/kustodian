import type { QueryWorkspace } from '../wire';

/** The workspaces a workbook queries, as the import review and the solution dialog list them: Save or Install confirms them. */
export function WorkspaceRows({ found }: { found: { workspace: QueryWorkspace; widgets: number }[] }) {
  return (
    found.length > 0 && (
      <section className="flex flex-col gap-1.5">
        <b className="text-[12.5px]">{`This workbook queries ${found.length} ${found.length === 1 ? 'workspace' : 'workspaces'}`}</b>
        {found.map(({ workspace, widgets }) => (
          <span key={workspace.customerId} className="flex min-h-7 items-center gap-2">
            <span className="truncate">{workspace.name}</span>
            <span className="ml-auto shrink-0 text-[11px] text-faint">{`${widgets} ${widgets === 1 ? 'widget' : 'widgets'}`}</span>
          </span>
        ))}
      </section>
    )
  );
}
