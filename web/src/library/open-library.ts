import { useTabs } from '../tabs/tab-store';
import type { RecentRun, SavedQuery, Snippet } from '../wire';

/** Opens a saved query in a new tab, with the timespan or scope saved with it, or goes to the tab it is already open in. The
 * Saved panel and the palette both open saved queries this way. */
export function openSaved(q: SavedQuery) {
  const { tabs, activate, openWith } = useTabs.getState();
  const open = tabs.find((t) => t.savedId === q.id);
  if (open) {
    activate(open.id);
  } else {
    openWith({ source: q.source, title: q.name, text: q.text, savedId: q.id, parameters: q.parameters, options: q.options ?? undefined });
  }
}

/** The query's first line that isn't blank, at most 40 characters: what a recent run is called in the list and in its tab. */
export function runTitle(text: string): string {
  const line = text.split(/\r?\n/).find((l) => l.trim() !== '')?.trim() ?? 'Recent run';
  return line.length > 40 ? `${line.slice(0, 39)}…` : line;
}

/** Opens a recent run again in a new tab, with its parameter values and its timespan or scope, so the tab runs as the run did. */
export function openRecent(run: RecentRun) {
  useTabs.getState().openWith({
    source: run.source,
    title: runTitle(run.text),
    text: run.text,
    // Ruling 15: the values come back typed.
    parameters: run.parameters.map(({ name, type, value, required }) => ({ name, type, value, required, choices: null })),
    options: run.options ?? undefined,
  });
}

/** Opens a snippet in a new tab of its own, with its parameter definitions. */
export function openSnippetInNewTab(s: Snippet) {
  useTabs.getState().openWith({ source: s.source, title: s.name, text: s.text, parameters: s.parameters });
}

/**
 * A snippet goes in at the cursor of the open query when it is for the same source, and its parameter definitions join the
 * tab's (a name the tab already has keeps the tab's); otherwise it opens in a new tab. Returns false when the editor wasn't
 * ready (`insert` returned false): then nothing changed, parameters included. The Snippets panel and the palette both insert
 * snippets this way.
 */
export function insertSnippet(s: Snippet, insert: (text: string) => boolean): boolean {
  const { tabs, activeId, setParameters } = useTabs.getState();
  const tab = tabs.find((t) => t.id === activeId);
  if (!tab || tab.source !== s.source) {
    openSnippetInNewTab(s);
    return true;
  }
  if (!insert(s.text)) {
    return false;
  }
  const added = s.parameters.filter((p) => !tab.parameters.some((q) => q.name === p.name));
  if (added.length > 0) {
    setParameters(tab.id, [...tab.parameters, ...added]);
  }
  return true;
}
