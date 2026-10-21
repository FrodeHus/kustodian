import { useTabs } from '../tabs/tab-store';
import type { SavedQuery, Snippet } from '../wire';

/** Opens a saved query in a new tab, or goes to the tab it is already open in. The Saved panel and the palette both open
 * saved queries this way. */
export function openSaved(q: SavedQuery) {
  const { tabs, activate, openWith } = useTabs.getState();
  const open = tabs.find((t) => t.savedId === q.id);
  if (open) {
    activate(open.id);
  } else {
    openWith({ source: q.source, title: q.name, text: q.text, savedId: q.id, parameters: q.parameters });
  }
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
