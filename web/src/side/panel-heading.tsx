import { SOURCES } from '../tabs/sources';
import type { Source } from '../wire';

/** A side panel's heading with the "All sources" toggle (**My call**): off, the panel lists the active tab's source's items;
 * on, every source's, each with its badge. */
export function PanelHeading({ title, source, all, onAll }: { title: string; source: Source; all: boolean; onAll: (all: boolean) => void }) {
  return (
    <div className="flex items-center gap-2 pr-3">
      <h2 className="grow">{title}</h2>
      <button
        type="button"
        className="btn ghost h-[22px] px-2 text-[11px]"
        aria-pressed={all}
        title={all ? `Show ${SOURCES[source].name} only` : 'Show every source'}
        onClick={() => onAll(!all)}
      >
        All sources
      </button>
    </div>
  );
}
