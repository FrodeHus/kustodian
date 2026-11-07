import { SolutionsPanel } from '../solutions/solutions-panel';
import { SchemaPanel } from '../schema/schema-panel';
import { schemaSourceOf, useSchemas } from '../schema/schema-store';
import type { TabSource } from '../wire';
import { PANELS, type PanelName } from './panels';
import { RecentPanel } from './recent-panel';
import { SavedPanel } from './saved-panel';
import { SnippetPanel } from './snippet-panel';

/** The rail of side panels (spec 6.1, mockup Main): the chosen one is pressed. */
/** The panel buttons; `panel` is the one showing, or null when none is (a workbook tab starts with none). */
export function Rail({ panel, onChoose }: { panel: PanelName | null; onChoose: (panel: PanelName) => void }) {
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
  /** The active tab's source: every panel follows it (spec 6.1). A raw request tab's, and a workbook tab's, is Graph's. */
  source: TabSource;
  /** The active tab's query, for the schema's "In this query". */
  text: string;
  /** Puts text at the editor's cursor; false when the editor isn't ready. */
  onInsert: (text: string) => boolean;
  /** The active account, which the schema panel's "Grant Azure access" asks consent for. */
  accountKey?: string;
  /** Opens sign-in, when the schema panel's resource types need the account to sign in again. */
  onSignIn?: () => void;
}

/** The side panel the rail chose, for the active tab's source. */
export function SidePanel({ panel, source: tabSource, text, onInsert, accountKey, onSignIn }: SidePanelProps) {
  const source = schemaSourceOf(tabSource);
  const schema = useSchemas((s) => s.byKey[source]);
  const error = useSchemas((s) => s.errors[source]);
  const errorReportId = useSchemas((s) => s.errorReportIds[source]);
  const resourceTypes = useSchemas((s) => s.resourceTypes);
  const resourceTypesError = useSchemas((s) => s.resourceTypesError);
  const resourceTypesReportId = useSchemas((s) => s.resourceTypesReportId);
  const resourceTypesFix = useSchemas((s) => s.resourceTypesFix);
  const listedByDefault = useSchemas((s) => s.listedByDefault);
  const licenses = useSchemas((s) => s.licenses);
  switch (panel) {
    case 'saved':
      return <SavedPanel source={source} />;
    case 'recent':
      return <RecentPanel source={source} />;
    case 'snippets':
      return <SnippetPanel source={source} onInsert={onInsert} />;
    case 'solutions':
      return <SolutionsPanel />;
    default:
      return (
        <SchemaPanel
          key={source}
          source={source}
          schema={schema}
          error={error}
          errorReportId={errorReportId}
          resourceTypes={resourceTypes}
          resourceTypesError={resourceTypesError}
          resourceTypesReportId={resourceTypesReportId}
          resourceTypesFix={resourceTypesFix}
          accountKey={accountKey}
          onSignIn={onSignIn}
          listedByDefault={listedByDefault}
          licenses={licenses}
          text={text}
          onInsert={onInsert}
        />
      );
  }
}
