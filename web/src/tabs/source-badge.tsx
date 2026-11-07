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

/** A workbook tab's mark in place of a source badge: a grid of widgets. `titled` names it on hover. */
export function WorkbookIcon({ titled = false }: { titled?: boolean }) {
  return (
    <span className="src" title={titled ? 'Workbook' : undefined}>
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
        <rect x="3" y="3" width="8" height="8" rx="1.5" />
        <rect x="13" y="3" width="8" height="8" rx="1.5" />
        <rect x="3" y="13" width="18" height="8" rx="1.5" />
      </svg>
    </span>
  );
}
