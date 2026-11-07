import { MAX_FOLDER_LENGTH, MAX_NAME_LENGTH } from '../library/saving';
import type { ParameterDef, QueryOptions, Source, ToolList } from '../wire';
import { parseWorkbook, type Widget, type WorkbookDoc } from './model';

/** JSON.parse then parseWorkbook. A string is what is wrong. */
export function readWorkbookFile(text: string): WorkbookDoc | string {
  try {
    return parseWorkbook(JSON.parse(text));
  } catch {
    return "This file isn't JSON.";
  }
}

export interface ImportSummary {
  widgets: number;
  parameters: number;
  sources: Source[];
  linked: number;
}

const SOURCE_ORDER: Source[] = ['graph', 'hunting', 'arg'];

export function importSummary(doc: WorkbookDoc): ImportSummary {
  const used = new Set<string | undefined>(doc.widgets.map((w) => w.query?.source));
  return {
    widgets: doc.widgets.length,
    parameters: doc.parameters.length,
    sources: SOURCE_ORDER.filter((s) => used.has(s)),
    linked: doc.widgets.filter((w) => w.query?.saved).length,
  };
}

/** The library folder for the workbook's queries: one level, 1 to MAX_FOLDER_LENGTH characters, no '/'. */
export function importFolder(workbookName: string): string {
  const cut = workbookName.trim().replaceAll('/', '-').slice(0, MAX_FOLDER_LENGTH).trim();
  return cut === '' ? 'Imported workbook' : cut;
}

export interface LinkedQuery {
  savedId: string;
  name: string;
  source: Exclude<Source, 'raw'>;
  text: string;
  parameters: ParameterDef[];
  options: QueryOptions | null;
}

export function linkedQueries(doc: WorkbookDoc): LinkedQuery[] {
  const found = new Map<string, LinkedQuery>();
  for (const w of doc.widgets) {
    const q = w.query;
    if (!q?.saved || found.has(q.saved.id)) {
      continue;
    }
    const name = (q.saved.name.trim() || w.title.trim()).slice(0, MAX_NAME_LENGTH).trim();
    found.set(q.saved.id, {
      savedId: q.saved.id,
      name: name || 'Imported query',
      source: q.source,
      text: q.text,
      parameters: q.parameters,
      options: q.options,
    });
  }
  return [...found.values()];
}

export interface ToolMatch {
  tool: string;
  mine: boolean;
}

export function matchTools(doc: WorkbookDoc, list: ToolList | null): ToolMatch[] {
  const mine = new Set(list?.tools.map((t) => t.name));
  const names = new Set(doc.widgets.flatMap((w) => w.tools?.map((b) => b.tool) ?? []));
  return [...names].map((tool) => ({ tool, mine: mine.has(tool) }));
}

export interface ImportChoices {
  /** sender's saved id → the new library entry. null: copy every linked query into its widget (saved: null). */
  added: Record<string, { id: string; name: string }> | null;
  /** the file's tool name → one of my tool names, or null to leave the button off. */
  tools: Record<string, string | null>;
  id: string;
}

/** Own-property lookup: a file's tool name or saved id such as "constructor" must not find Object.prototype. */
const pick = <T>(map: Record<string, T>, key: string): T | undefined => (Object.hasOwn(map, key) ? map[key] : undefined);

export function applyImport(doc: WorkbookDoc, choices: ImportChoices): WorkbookDoc {
  const widgets = doc.widgets.map((w): Widget => {
    const next: Widget = { ...w };
    if (w.query?.saved) {
      next.query = { ...w.query, saved: (choices.added && pick(choices.added, w.query.saved.id)) || null };
    }
    if (w.tools) {
      next.tools = w.tools.flatMap((b) => {
        const tool = pick(choices.tools, b.tool);
        return tool ? [{ ...b, tool }] : [];
      });
    }
    return next;
  });
  const { modifiedAt: _modifiedAt, ...rest } = doc;
  return { ...rest, id: choices.id, widgets };
}
