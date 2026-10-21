import { SchemaPanel } from '../schema/schema-panel';
import type { SchemaView } from '../wire';
import { PANELS, type PanelName } from './panels';
import { RecentPanel } from './recent-panel';
import { SavedPanel } from './saved-panel';
import { SnippetPanel } from './snippet-panel';

/** The rail of side panels (spec 6.1, mockup Main): the chosen one is pressed. */
export function Rail({ panel, onChoose }: { panel: PanelName; onChoose: (panel: PanelName) => void }) {
  return (
    <nav className="rail" aria-label="Side panels">
      {PANELS.map((p) => (
        <button key={p.name} type="button" aria-pressed={p.name === panel} aria-label={p.label} title={p.label} onClick={() => onChoose(p.name)}>
          {p.icon}
        </button>
      ))}
    </nav>
  );
}

interface SidePanelProps {
  panel: PanelName;
  schema: SchemaView | null;
  /** The active tab's query, for the schema's "In this query". */
  text: string;
  /** Puts text at the editor's cursor; false when the editor isn't ready. */
  onInsert: (text: string) => boolean;
}

/** The side panel the rail chose. */
export function SidePanel({ panel, schema, text, onInsert }: SidePanelProps) {
  switch (panel) {
    case 'saved':
      return <SavedPanel />;
    case 'recent':
      return <RecentPanel />;
    case 'snippets':
      return <SnippetPanel onInsert={onInsert} />;
    default:
      return <SchemaPanel schema={schema} text={text} onInsert={onInsert} />;
  }
}
