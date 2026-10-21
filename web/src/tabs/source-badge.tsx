import type { Source } from '../wire';
import { SOURCES } from './sources';

/** A source's badge; `titled` names the source on hover. */
export function SourceBadge({ source, titled = false }: { source: Source; titled?: boolean }) {
  const s = SOURCES[source];
  return (
    <span className={`src ${s.className}`} title={titled ? s.name : undefined}>
      {s.badge}
    </span>
  );
}
