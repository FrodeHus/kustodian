import { useEffect, useState } from 'react';
import { call } from '../bridge';
import { insertSnippet, openSnippetInNewTab } from '../library/open-library';
import { useRevisions } from '../library/saving';
import { findParams, mergeParameters } from '../params/find-params';
import { errorText } from '../shell/errors';
import { useTabs } from '../tabs/tab-store';
import type { Snippet } from '../wire';
import { ConfirmDelete, RowMenu } from './row-menu';

/** Groups in the order they first appear: the built-in snippets by their group, then the user's own as "Mine". */
function grouped(snippets: Snippet[]): { title: string; snippets: Snippet[] }[] {
  const groups = new Map<string, Snippet[]>();
  for (const s of snippets.filter((x) => x.builtIn)) {
    const title = s.group ? `Built in · ${s.group}` : 'Built in';
    groups.set(title, [...(groups.get(title) ?? []), s]);
  }
  return [...groups].map(([title, list]) => ({ title, snippets: list }));
}

/**
 * The Snippets panel (spec 6.4, mockup Parameters): the built-in snippets by group, then the user's own, with a search. A click
 * inserts a snippet at the cursor; its menu opens it in a new tab, or deletes one of the user's (after asking). The selected
 * text can be saved as a new snippet.
 */
export function SnippetPanel({ onInsert }: { onInsert: (text: string) => boolean }) {
  const revision = useRevisions((s) => s.snippets);
  const [snippets, setSnippets] = useState<Snippet[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [deleting, setDeleting] = useState<string | null>(null);
  const [naming, setNaming] = useState<{ text: string } | null>(null);
  const [name, setName] = useState('');
  const selection = useTabs((s) => (s.activeId ? (s.cursors[s.activeId]?.selection ?? '') : ''));

  useEffect(() => {
    let live = true;
    call<{ snippets: Snippet[] }>('snippets.list').then(
      (r) => live && setSnippets(r.snippets),
      (e: unknown) => live && setProblem(`The snippets couldn’t be read: ${errorText(e)}`),
    );
    return () => {
      live = false;
    };
  }, [revision]);

  const changed = () => useRevisions.getState().bump('snippets');

  const remove = (s: Snippet) => {
    setDeleting(null);
    call('snippets.delete', { id: s.id }).then(
      () => {
        setProblem(null);
        changed();
      },
      (e: unknown) => setProblem(`It couldn’t be deleted: ${errorText(e)}`),
    );
  };

  const saveSelection = (text: string, snippetName: string) => {
    const { tabs, activeId } = useTabs.getState();
    const tab = tabs.find((t) => t.id === activeId);
    if (!tab) {
      return;
    }
    const snippet = {
      id: null,
      source: tab.source,
      name: snippetName,
      description: '',
      text,
      group: null,
      parameters: mergeParameters(findParams(text), tab.parameters),
    };
    call<Snippet>('snippets.save', { snippet }).then(
      () => {
        setNaming(null);
        setProblem(null);
        changed();
      },
      (e: unknown) => setProblem(`The snippet couldn’t be saved: ${errorText(e)}`),
    );
  };

  const needle = search.trim().toLowerCase();
  const shown = (snippets ?? []).filter((s) => !needle || s.name.toLowerCase().includes(needle) || s.description.toLowerCase().includes(needle));
  const mine = shown.filter((s) => !s.builtIn);

  const row = (s: Snippet) => {
    if (deleting === s.id) {
      return (
        <li key={s.id}>
          <ConfirmDelete name={s.name} onDelete={() => remove(s)} onCancel={() => setDeleting(null)} />
        </li>
      );
    }
    const params = findParams(s.text);
    return (
      <li key={s.id} className="side-item">
        <button
          type="button"
          className="side-open"
          aria-label={s.name}
          title={s.description ? `${s.description}\n\n${s.text}` : s.text}
          onClick={() => setProblem(insertSnippet(s, onInsert) ? null : 'The editor isn’t ready yet. Try again in a moment.')}
        >
          <span className="truncate">{s.name}</span>
          {params.length > 0 && (
            <span className="ty mono" aria-hidden="true">
              {params.map((p) => `{${p}}`).join(' ')}
            </span>
          )}
        </button>
        <RowMenu
          name={s.name}
          actions={[
            { label: 'Open in new tab', run: () => openSnippetInNewTab(s) },
            ...(s.builtIn ? [] : [{ label: 'Delete', run: () => setDeleting(s.id) }]),
          ]}
        />
      </li>
    );
  };

  return (
    <aside className="side" aria-label="Snippets">
      <h2>Snippets</h2>
      <input className="search" type="search" aria-label="Find a snippet" placeholder="Find a snippet" value={search} onChange={(e) => setSearch(e.target.value)} />
      <div className="min-h-0 flex-1 overflow-y-auto pb-3">
        {problem && (
          <p role="alert" className="m-0 px-[14px] pb-2 text-[12px] text-bad">
            {problem}
          </p>
        )}
        {grouped(shown).map((g) => (
          <section key={g.title}>
            <h2 className="pt-1">{g.title}</h2>
            <ul className="side-list">{g.snippets.map(row)}</ul>
          </section>
        ))}
        {snippets && (
          <section>
            <h2>Mine</h2>
            {mine.length > 0 ? (
              <ul className="side-list">{mine.map(row)}</ul>
            ) : (
              <p className="faint m-0 px-[14px] text-[12px]">{needle ? 'None of yours matches.' : 'Select part of a query and save it as a snippet.'}</p>
            )}
          </section>
        )}
      </div>
      <div className="side-foot">
        {naming ? (
          <form
            aria-label="New snippet"
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim()) {
                saveSelection(naming.text, name.trim());
              }
            }}
          >
            <input className="textbox" aria-label="Snippet name" placeholder="Snippet name" autoFocus value={name} onChange={(e) => setName(e.target.value)} />
            <div className="flex justify-end gap-1.5">
              <button type="button" className="btn ghost" onClick={() => setNaming(null)}>
                Cancel
              </button>
              <button type="submit" className="btn primary" disabled={!name.trim()}>
                Save snippet
              </button>
            </div>
          </form>
        ) : (
          <button
            type="button"
            className="btn w-full justify-center"
            disabled={selection.trim() === ''}
            title={selection.trim() === '' ? 'Select part of the query first.' : undefined}
            onClick={() => {
              setName('');
              setNaming({ text: selection });
            }}
          >
            Save the selection as a snippet
          </button>
        )}
      </div>
    </aside>
  );
}
