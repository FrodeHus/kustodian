import { SchemaPanel } from '../schema/schema-panel';
import { schemaSourceOf, useSchemas } from '../schema/schema-store';
import type { Source } from '../wire';
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
  /** The active tab's source: every panel follows it (spec 6.1). A raw request tab's is Graph's. */
  source: Source;
  /** The active tab's query, for the schema's "In this query". */
  text: string;
  /** Puts text at the editor's cursor; false when the editor isn't ready. */
  onInsert: (text: string) => boolean;
}

/** The side panel the rail chose, for the active tab's source. */
export function SidePanel({ panel, source: tabSource, text, onInsert }: SidePanelProps) {
  const source = schemaSourceOf(tabSource);
  const schema = useSchemas((s) => s.byKey[source]);
  const error = useSchemas((s) => s.errors[source]);
  const resourceTypes = useSchemas((s) => s.resourceTypes);
  const resourceTypesError = useSchemas((s) => s.resourceTypesError);
  switch (panel) {
    case 'saved':
      return <SavedPanel source={source} />;
    case 'recent':
      return <RecentPanel source={source} />;
    case 'snippets':
      return <SnippetPanel source={source} onInsert={onInsert} />;
    default:
      return (
        <SchemaPanel
          key={source}
          source={source}
          schema={schema}
          error={error}
          resourceTypes={resourceTypes}
          resourceTypesError={resourceTypesError}
          text={text}
          onInsert={onInsert}
        />
      );
  }
}
