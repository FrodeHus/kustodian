import { findParams } from '../params/find-params';
import { cellText } from '../results/export';
import type { RunResult } from '../wire';
import type { Widget, WorkbookDoc, WorkbookParameter } from './model';
import { widgetsUsing } from './resolve';

export interface Choice {
  value: string;
  label: string;
}
/** A parameter's choices from its query: view state in the store, never saved. */
export type ParamChoices =
  | { state: 'loading'; items?: Choice[] } // items: the list being reloaded, still usable
  | { state: 'done'; items: Choice[]; capped: boolean }
  | { state: 'failed'; error: string }
  | { state: 'needsWorkspace' };

export const MAX_CHOICES = 1000;

const ID_PREFIX = 'param:';

/** The parameter's choice query as a table widget, so it runs and resolves like one; null without a query. Its own `{name}`
 * is fixed as empty text, or the workbook parameter of that name (itself) would win. */
export function choiceWidget(p: WorkbookParameter): Widget | null {
  if (!p.choicesQuery) {
    return null;
  }
  return {
    id: ID_PREFIX + p.name,
    type: 'table',
    title: '',
    layout: { x: 0, y: 0, w: 0, h: 0 },
    query: { ...p.choicesQuery, parameters: [], saved: null },
    parameters: findParams(p.choicesQuery.text).includes(p.name) ? { [p.name]: { from: 'fixed', value: '' } } : {},
  };
}

/** Value = first column as text, label = second column (else the value); empty values dropped, duplicates keep the first. */
export function choicesFrom(result: RunResult): { items: Choice[]; capped: boolean } {
  const items = new Map<string, Choice>();
  for (const row of result.rows) {
    const value = cellText(row[0]);
    if (value === '' || items.has(value)) {
      continue;
    }
    if (items.size === MAX_CHOICES) {
      return { items: [...items.values()], capped: true };
    }
    items.set(value, { value, label: cellText(row[1]) || value });
  }
  return { items: [...items.values()], capped: false };
}

/** Parameters (other than `name`) whose choice query resolves `{name}` from the workbook or takes it as the hunting timespan. */
export function choicesUsing(doc: WorkbookDoc, name: string): string[] {
  const widgets = doc.parameters.flatMap((p) => (p.name === name ? [] : (choiceWidget(p) ?? [])));
  return widgetsUsing({ ...doc, widgets }, name).map((id) => id.slice(ID_PREFIX.length));
}

/** The choices a control offers: a fixed list, or a query's loaded items (kept while it reloads); null for free entry. */
export function effectiveChoices(param: WorkbookParameter, loaded: ParamChoices | undefined): Choice[] | null {
  if (param.choicesQuery) {
    return (loaded?.state === 'done' || loaded?.state === 'loading') && loaded.items?.length ? loaded.items : null;
  }
  const fixed = (param.choices ?? []).filter((c) => c.trim() !== '');
  return fixed.length > 0 ? fixed.map((c) => ({ value: c, label: c })) : null;
}
